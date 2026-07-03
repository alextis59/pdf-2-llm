import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

export function summarizeDurations(durationsMs) {
  if (durationsMs.length === 0) {
    return {
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      medianMs: 0
    };
  }
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const total = durationsMs.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  return {
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: total / sorted.length,
    medianMs:
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  };
}

export function summarizeMemory(before, after) {
  return {
    rssDeltaBytes: after.rss - before.rss,
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    externalDeltaBytes: after.external - before.external,
    arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers
  };
}

export function summarizePeakMemory(baseline, samples) {
  const peak = samples.reduce(
    (current, sample) => ({
      rss: Math.max(current.rss, sample.rss),
      heapUsed: Math.max(current.heapUsed, sample.heapUsed),
      external: Math.max(current.external, sample.external),
      arrayBuffers: Math.max(current.arrayBuffers, sample.arrayBuffers)
    }),
    { ...baseline }
  );
  return {
    rssPeakBytes: peak.rss,
    heapUsedPeakBytes: peak.heapUsed,
    externalPeakBytes: peak.external,
    arrayBuffersPeakBytes: peak.arrayBuffers,
    rssPeakDeltaBytes: peak.rss - baseline.rss,
    heapUsedPeakDeltaBytes: peak.heapUsed - baseline.heapUsed
  };
}

export function splitStartupAndThroughputDurations(durationsMs) {
  const startupMs = durationsMs[0] ?? 0;
  const throughputDurations = durationsMs.length > 1 ? durationsMs.slice(1) : durationsMs;
  return {
    startupMs,
    throughputDurations
  };
}

export function summarizeGpuMemoryFromExecution(execution = null) {
  const batches = execution?.batches ?? [];
  return {
    provider: execution?.provider ?? "cpu",
    source: "webgpu-execution-plan",
    estimatedBytes: execution?.totalEstimatedBytes ?? 0,
    maxBatchEstimatedBytes: batches.reduce(
      (max, batch) => Math.max(max, batch.estimatedBytes ?? 0),
      0
    ),
    limitBytes: execution?.limits?.maxMemoryBytes ?? null,
    plannedPages: execution?.plannedPages ?? 0,
    skippedPages: execution?.skippedPages ?? 0
  };
}

export function compareProviderResults(results) {
  const byId = new Map();
  for (const result of results) {
    const group = byId.get(result.id) ?? [];
    group.push(result);
    byId.set(result.id, group);
  }

  const comparisons = [];
  for (const [id, group] of byId) {
    const cpu = group.find((result) => result.providerMode === "cpu");
    const webgpu = group.find((result) => result.providerMode === "webgpu-preferred");
    if (!cpu || !webgpu) {
      continue;
    }
    comparisons.push({
      id,
      workload: webgpu.workload,
      cpuSelectedProvider: cpu.acceleration.selectedProvider,
      webgpuSelectedProvider: webgpu.acceleration.selectedProvider,
      webgpuFallbackReason: webgpu.acceleration.fallbackReason,
      equivalentAcceptedOutput:
        cpu.outputChars === webgpu.outputChars &&
        cpu.textLines === webgpu.textLines &&
        JSON.stringify(cpu.warnings) === JSON.stringify(webgpu.warnings),
      pagesPerSecondRatio:
        cpu.pagesPerSecond > 0 ? webgpu.pagesPerSecond / cpu.pagesPerSecond : null,
      startupDeltaMs: webgpu.startup.durationMs - cpu.startup.durationMs,
      modelLoadDeltaMs: webgpu.modelLoad.durationMs - cpu.modelLoad.durationMs,
      rssPeakDeltaBytes: webgpu.peakMemory.rssPeakBytes - cpu.peakMemory.rssPeakBytes,
      gpuEstimatedBytes: webgpu.gpuMemory.estimatedBytes
    });
  }
  return comparisons;
}

export function evaluateMemoryLimits(memory, acceptance) {
  const limits = [
    {
      metric: "maxRssDeltaBytes",
      actualMetric: "rssDeltaBytes",
      actual: memory.rssDeltaBytes,
      limit: acceptance.maxRssDeltaBytes
    },
    {
      metric: "maxHeapUsedDeltaBytes",
      actualMetric: "heapUsedDeltaBytes",
      actual: memory.heapUsedDeltaBytes,
      limit: acceptance.maxHeapUsedDeltaBytes
    }
  ];
  return limits
    .filter((limit) => Number.isFinite(limit.limit))
    .filter((limit) => limit.actual > limit.limit + Number.EPSILON);
}

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function readOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function usage() {
  return `Usage:
  node scripts/qa/benchmark.mjs --all [--iterations <n>] [--warmup <n>] [--report <path>]
  node scripts/qa/benchmark.mjs --gate <gate> [--iterations <n>] [--warmup <n>] [--report <path>]
  node scripts/qa/benchmark.mjs --id <manifest-id> [--iterations <n>] [--warmup <n>] [--report <path>]
  node scripts/qa/benchmark.mjs --memory-limit-gated [--iterations <n>] [--warmup <n>] [--report <path>]

Options:
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
  --root <path>              Repository root. Defaults to cwd.
  --webgpu-comparison        Run each selected case in CPU and WebGPU-preferred modes.
  --dry-run                  Print selected cases without converting them.
`;
}

function readTopLevelScalars(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s/.test(line)) {
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], normalizeScalar(match[2] ?? ""));
    }
  }
  return values;
}

function readNamedBlockScalars(text, blockName) {
  const values = new Map();
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      inBlock = line.trim() === `${blockName}:`;
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], normalizeScalar(match[2] ?? ""));
    }
  }
  return values;
}

function normalizeScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readIntegerOption(name, fallback) {
  const value = readOption(name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadAcceptance(repoRoot, entry) {
  const text = await readFile(path.join(repoRoot, entry.acceptanceFile), "utf8");
  const scalars = readTopLevelScalars(text);
  const metrics = readNamedBlockScalars(text, "metrics");
  return {
    id: scalars.get("id"),
    gate: scalars.get("gate"),
    expectedMode: scalars.get("expectedMode"),
    gating: scalars.get("gating") === "true",
    skipReason: scalars.get("skipReason") ?? "",
    maxRssDeltaBytes: readNumber(metrics.get("maxRssDeltaBytes"), null),
    maxHeapUsedDeltaBytes: readNumber(metrics.get("maxHeapUsedDeltaBytes"), null)
  };
}

async function loadCases(repoRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const cases = [];
  for (const entry of manifest.entries) {
    cases.push({
      entry,
      acceptance: await loadAcceptance(repoRoot, entry)
    });
  }
  return cases;
}

function selectCases(cases, { selectedIds, selectedGate, memoryLimitGated = false }) {
  const idSet = new Set(selectedIds);
  const selected = [];
  const skipped = [];

  for (const corpusCase of cases) {
    let reason = null;
    if (idSet.size > 0 && !idSet.has(corpusCase.entry.id)) {
      reason = "id-filter: not requested by --id";
    }
    if (!reason && isLocalOnlyEntry(corpusCase.entry)) {
      reason = formatAcceptanceSkip(corpusCase, "local-only");
    }
    if (!reason && !corpusCase.acceptance.gating) {
      reason = formatAcceptanceSkip(corpusCase, "non-gating");
    }
    if (!reason && corpusCase.acceptance.expectedMode === "unsupported") {
      reason = formatAcceptanceSkip(corpusCase, "unsupported");
    }
    if (!reason && selectedGate && corpusCase.acceptance.gate !== selectedGate) {
      reason =
        `gate-filter: acceptance gate ${corpusCase.acceptance.gate} does not match selected gate ${selectedGate}`;
    }
    if (!reason && memoryLimitGated && !hasMemoryLimits(corpusCase.acceptance)) {
      reason = "memory-limit-filter: no memory delta threshold";
    }

    if (reason) {
      skipped.push({ ...corpusCase, reason });
    } else {
      selected.push(corpusCase);
    }
  }

  for (const id of idSet) {
    if (!cases.some((corpusCase) => corpusCase.entry.id === id)) {
      throw new Error(`unknown manifest id "${id}"`);
    }
  }

  return { selected, skipped };
}

function hasMemoryLimits(acceptance) {
  return (
    Number.isFinite(acceptance.maxRssDeltaBytes) ||
    Number.isFinite(acceptance.maxHeapUsedDeltaBytes)
  );
}

function isLocalOnlyEntry(entry) {
  return (
    entry.redistributable === false ||
    entry.source?.type === "local-only" ||
    /(^|\/)local-only(\/|$)/.test(entry.path)
  );
}

function formatAcceptanceSkip(corpusCase, code) {
  const detail = corpusCase.acceptance.skipReason || "missing acceptance skipReason";
  return `${code}: ${detail}`;
}

async function runBenchmarkCase(repoRoot, corpusCase, { iterations, providerMode, warmup }) {
  const { entry, acceptance } = corpusCase;
  const pdfPath = path.join(repoRoot, entry.path);
  const options = await createConversionOptions(repoRoot, entry, providerMode);

  for (let index = 0; index < warmup; index += 1) {
    await convertPdfToMarkdown(pdfPath, options);
  }

  const memoryBefore = collectMemorySnapshot({ forceGc: true });
  const memorySamples = [memoryBefore];
  const durationsMs = [];
  let lastResult = null;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    lastResult = await convertPdfToMarkdown(pdfPath, options);
    durationsMs.push(performance.now() - startedAt);
    memorySamples.push(collectMemorySnapshot({ forceGc: false }));
  }
  const memoryAfter = collectMemorySnapshot({ forceGc: true });
  memorySamples.push(memoryAfter);
  const memory = summarizeMemory(memoryBefore, memoryAfter);
  const peakMemory = summarizePeakMemory(memoryBefore, memorySamples);
  const memoryLimitViolations = evaluateMemoryLimits(memory, acceptance);

  const pages = Math.max(1, lastResult?.diagnostics.pages.length ?? 0);
  const duration = summarizeDurations(durationsMs);
  const { startupMs, throughputDurations } = splitStartupAndThroughputDurations(durationsMs);
  const throughput = summarizeDurations(throughputDurations);
  const throughputPages = pages * throughputDurations.length;
  const throughputSeconds = throughputDurations.reduce((sum, value) => sum + value, 0) / 1000;
  const webgpuDiagnostics = lastResult?.diagnostics.acceleration.webgpu ?? null;
  const ocrModelLoading = lastResult?.diagnostics.extraction.ocr.modelLoading ?? null;
  return {
    id: entry.id,
    gate: acceptance.gate,
    workload: benchmarkWorkload(acceptance),
    providerMode,
    bytes: entry.bytes,
    pdfVersion: entry.pdfVersion,
    iterations,
    warmup,
    pages,
    outputChars: lastResult?.markdown.length ?? 0,
    textLines: lastResult?.diagnostics.extraction.textLines ?? 0,
    warnings: lastResult?.warnings.map((warning) => warning.code) ?? [],
    ...duration,
    startup: {
      durationMs: startupMs
    },
    modelLoad: summarizeModelLoad(ocrModelLoading, options),
    throughput: {
      iterations: throughputDurations.length,
      ...throughput,
      pagesPerSecond: throughputSeconds > 0 ? throughputPages / throughputSeconds : 0
    },
    pagesPerSecond: throughputSeconds > 0 ? throughputPages / throughputSeconds : 0,
    acceleration: summarizeAcceleration(webgpuDiagnostics),
    memory,
    peakMemory,
    gpuMemory: summarizeGpuMemoryFromExecution(webgpuDiagnostics?.execution),
    memoryLimits: {
      maxRssDeltaBytes: acceptance.maxRssDeltaBytes,
      maxHeapUsedDeltaBytes: acceptance.maxHeapUsedDeltaBytes
    },
    memoryLimitViolations,
    passed: memoryLimitViolations.length === 0
  };
}

async function createConversionOptions(repoRoot, entry, providerMode) {
  const options = {
    ocr: entry.ocrResultsFile ? { results: await readOcrResults(repoRoot, entry) } : { enabled: false }
  };
  if (providerMode === "webgpu-preferred") {
    options.webgpu = { preferred: true };
  }
  return options;
}

async function readOcrResults(repoRoot, entry) {
  const ocrPath = path.join(repoRoot, entry.ocrResultsFile);
  try {
    const payload = JSON.parse(await readFile(ocrPath, "utf8"));
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload.results)) {
      return payload.results;
    }
    throw new Error("expected a JSON array or an object with a results array");
  } catch (error) {
    throw new Error(`${entry.id}: OCR results are not readable at ${ocrPath}: ${error.message}`);
  }
}

function benchmarkWorkload(acceptance) {
  if (acceptance.gate === "ocr-v1") {
    return "ocr";
  }
  if (acceptance.gate === "layout-v1") {
    return "layout";
  }
  return "conversion";
}

function summarizeModelLoad(modelLoading, options) {
  return {
    durationMs: 0,
    measured: false,
    reason: options.ocr?.results ? "injected-ocr-results" : "ocr-disabled-or-lazy",
    strategy: modelLoading?.strategy ?? null,
    source: modelLoading?.source ?? null,
    languages: modelLoading?.languages ?? [],
    modelFiles: modelLoading?.modelFiles ?? []
  };
}

function summarizeAcceleration(webgpuDiagnostics) {
  return {
    requested: webgpuDiagnostics?.requested ?? "disabled",
    selectedProvider: webgpuDiagnostics?.selectedProvider ?? "cpu",
    fallbackReason: webgpuDiagnostics?.fallbackReason ?? null,
    runtime: webgpuDiagnostics?.runtime ?? "unknown",
    executionProvider: webgpuDiagnostics?.execution?.provider ?? "cpu",
    executionStatus: webgpuDiagnostics?.execution?.status ?? "no-routed-pages"
  };
}

function collectMemorySnapshot({ forceGc = true } = {}) {
  if (forceGc && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
  return process.memoryUsage();
}

function printCase(prefix, corpusCase) {
  const { entry, acceptance } = corpusCase;
  console.log(`${prefix} ${entry.id} gate=${acceptance.gate} bytes=${entry.bytes} path=${entry.path}`);
}

function printResult(result) {
  const prefix = result.passed ? "BENCH" : "FAIL";
  const rssLimit = Number.isFinite(result.memoryLimits.maxRssDeltaBytes)
    ? ` maxRssDeltaKiB=${formatNumber(result.memoryLimits.maxRssDeltaBytes / 1024)}`
    : "";
  const heapLimit = Number.isFinite(result.memoryLimits.maxHeapUsedDeltaBytes)
    ? ` maxHeapDeltaKiB=${formatNumber(result.memoryLimits.maxHeapUsedDeltaBytes / 1024)}`
    : "";
  console.log(
    `${prefix} ${result.id} mode=${result.providerMode} workload=${result.workload} meanMs=${formatNumber(result.meanMs)} medianMs=${formatNumber(
      result.medianMs
    )} startupMs=${formatNumber(result.startup.durationMs)} pagesPerSecond=${formatNumber(result.pagesPerSecond)} textLines=${result.textLines} provider=${result.acceleration.selectedProvider} gpuKiB=${formatNumber(
      result.gpuMemory.estimatedBytes / 1024
    )} rssDeltaKiB=${formatNumber(
      result.memory.rssDeltaBytes / 1024
    )}${rssLimit} peakRssKiB=${formatNumber(
      result.peakMemory.rssPeakBytes / 1024
    )} heapDeltaKiB=${formatNumber(
      result.memory.heapUsedDeltaBytes / 1024
    )}${heapLimit}`
  );
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const selectAll = hasFlag("--all");
  const memoryLimitGated = hasFlag("--memory-limit-gated");
  const selectedIds = readOptions("--id");
  const selectedGate = readOption("--gate");
  if (!selectAll && !selectedGate && selectedIds.length === 0 && !memoryLimitGated) {
    console.error(usage());
    process.exit(1);
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const manifestPath = path.resolve(
    readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
  );
  const iterations = readIntegerOption("--iterations", 3);
  const warmup = readIntegerOption("--warmup", 1);
  const providerModes = hasFlag("--webgpu-comparison") ? ["cpu", "webgpu-preferred"] : ["cpu"];
  if (iterations === 0 && !hasFlag("--dry-run")) {
    throw new Error("--iterations must be greater than 0 unless --dry-run is used");
  }

  const cases = await loadCases(repoRoot, manifestPath);
  const { selected, skipped } = selectCases(cases, {
    selectedIds,
    selectedGate,
    memoryLimitGated
  });

  if (hasFlag("--dry-run")) {
    for (const corpusCase of selected) {
      printCase("SELECT", corpusCase);
    }
    for (const corpusCase of skipped) {
      console.log(`SKIP ${corpusCase.entry.id} reason=${corpusCase.reason}`);
    }
    console.log(`Selected ${selected.length}; skipped ${skipped.length}.`);
    return;
  }

  const results = [];
  for (const corpusCase of selected) {
    for (const providerMode of providerModes) {
      const result = await runBenchmarkCase(repoRoot, corpusCase, {
        iterations,
        providerMode,
        warmup
      });
      results.push(result);
      printResult(result);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    iterations,
    warmup,
    providerModes,
    comparisons: compareProviderResults(results),
    results
  };
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    for (const result of failed) {
      for (const violation of result.memoryLimitViolations) {
        console.error(
          `${result.id}: ${violation.actualMetric} ${violation.actual} exceeds ${violation.metric} ${violation.limit}`
        );
      }
    }
    process.exit(1);
  }

  console.log(`Benchmark completed: ${results.length}; skipped ${skipped.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
