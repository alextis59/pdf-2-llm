import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

export function summarizeDurations(durationsMs) {
  const summary = summarizeNumbers(durationsMs);
  return {
    minMs: summary.min,
    maxMs: summary.max,
    meanMs: summary.mean,
    medianMs: summary.median
  };
}

function summarizeNumbers(values) {
  if (values.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
    median:
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

export function createAcceptedOutputHash(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("accepted output hashing requires a conversion result");
  }

  const { diagnostics, ...publicResult } = result;
  const stableDiagnostics =
    diagnostics && typeof diagnostics === "object" ? { ...diagnostics } : diagnostics;
  if (stableDiagnostics && typeof stableDiagnostics === "object") {
    delete stableDiagnostics.timing;
    if (stableDiagnostics.options && typeof stableDiagnostics.options === "object") {
      const { webgpuRequired, webgpuPreferred, ...stableOptions } = stableDiagnostics.options;
      stableDiagnostics.options = stableOptions;
    }
    if (stableDiagnostics.acceleration && typeof stableDiagnostics.acceleration === "object") {
      const { webgpu, ...stableAcceleration } = stableDiagnostics.acceleration;
      stableDiagnostics.acceleration = stableAcceleration;
    }
  }

  const canonicalResult = canonicalizeJson({
    ...publicResult,
    diagnostics: stableDiagnostics
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalResult)).digest("hex")}`;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalizeJson(value[key])])
  );
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
    const pagesPerSecondRatio =
      cpu.pagesPerSecond > 0 ? webgpu.pagesPerSecond / cpu.pagesPerSecond : null;
    const preprocessingSpeedupRatio = webgpu.acceleration.preprocessing?.speedupRatio ?? null;
    comparisons.push({
      id,
      workload: webgpu.workload,
      cpuSelectedProvider: cpu.acceleration.selectedProvider,
      webgpuSelectedProvider: webgpu.acceleration.selectedProvider,
      webgpuFallbackReason: webgpu.acceleration.fallbackReason,
      cpuAcceptedOutputHash: cpu.acceptedOutputHash,
      webgpuAcceptedOutputHash: webgpu.acceptedOutputHash,
      equivalentAcceptedOutput:
        typeof cpu.acceptedOutputHash === "string" &&
        cpu.acceptedOutputHash === webgpu.acceptedOutputHash,
      speedupMetric: Number.isFinite(preprocessingSpeedupRatio)
        ? "webgpu-preprocessing"
        : "pages-per-second",
      speedupRatio: Number.isFinite(preprocessingSpeedupRatio)
        ? preprocessingSpeedupRatio
        : pagesPerSecondRatio,
      pagesPerSecondRatio,
      webgpuPreprocessingSpeedupRatio: preprocessingSpeedupRatio,
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

export function createMemoryProfileSummary(results, { scope = "memory-limit-gated" } = {}) {
  const cases = results.filter((result) => hasMemoryLimits(result.memoryLimits)).map(profileResult);
  return {
    profileType: "long-memory",
    scope,
    resultCount: cases.length,
    passed: cases.every((profile) => profile.passed),
    totals: {
      pages: cases.reduce((sum, profile) => sum + profile.pages, 0),
      bytes: cases.reduce((sum, profile) => sum + profile.bytes, 0)
    },
    peaks: {
      rssDeltaBytes: maxProfileMetric(cases, "rssDeltaBytes"),
      heapUsedDeltaBytes: maxProfileMetric(cases, "heapUsedDeltaBytes"),
      rssPeakBytes: maxProfileMetric(cases, "rssPeakBytes"),
      heapUsedPeakBytes: maxProfileMetric(cases, "heapUsedPeakBytes"),
      rssPeakDeltaBytes: maxProfileMetric(cases, "rssPeakDeltaBytes"),
      heapUsedPeakDeltaBytes: maxProfileMetric(cases, "heapUsedPeakDeltaBytes")
    },
    cases
  };
}

function profileResult(result) {
  const pages = Math.max(0, result.pages ?? 0);
  const perPageDivisor = Math.max(1, pages);
  const memory = result.memory ?? {};
  const peakMemory = result.peakMemory ?? {};
  return {
    id: result.id,
    gate: result.gate,
    kind: result.kind,
    features: result.features ?? [],
    workload: result.workload,
    providerMode: result.providerMode,
    pages,
    bytes: result.bytes ?? 0,
    iterations: result.iterations ?? 0,
    warmup: result.warmup ?? 0,
    rssDeltaBytes: memory.rssDeltaBytes ?? 0,
    heapUsedDeltaBytes: memory.heapUsedDeltaBytes ?? 0,
    externalDeltaBytes: memory.externalDeltaBytes ?? 0,
    arrayBuffersDeltaBytes: memory.arrayBuffersDeltaBytes ?? 0,
    rssPeakBytes: peakMemory.rssPeakBytes ?? 0,
    heapUsedPeakBytes: peakMemory.heapUsedPeakBytes ?? 0,
    rssPeakDeltaBytes: peakMemory.rssPeakDeltaBytes ?? 0,
    heapUsedPeakDeltaBytes: peakMemory.heapUsedPeakDeltaBytes ?? 0,
    rssDeltaBytesPerPage: (memory.rssDeltaBytes ?? 0) / perPageDivisor,
    heapUsedDeltaBytesPerPage: (memory.heapUsedDeltaBytes ?? 0) / perPageDivisor,
    rssPeakDeltaBytesPerPage: (peakMemory.rssPeakDeltaBytes ?? 0) / perPageDivisor,
    heapUsedPeakDeltaBytesPerPage: (peakMemory.heapUsedPeakDeltaBytes ?? 0) / perPageDivisor,
    limits: {
      maxRssDeltaBytes: result.memoryLimits?.maxRssDeltaBytes ?? null,
      maxHeapUsedDeltaBytes: result.memoryLimits?.maxHeapUsedDeltaBytes ?? null
    },
    violations: result.memoryLimitViolations ?? [],
    passed: result.passed === true
  };
}

function maxProfileMetric(cases, metricName) {
  if (cases.length === 0) {
    return null;
  }
  return Math.max(...cases.map((profile) => profile[metricName] ?? 0));
}

export function createThroughputProfileSummary(
  results,
  { profileType = "throughput", scope = "selected-cases" } = {}
) {
  const cases = results.map(throughputResult);
  return {
    profileType,
    scope,
    resultCount: cases.length,
    passed: cases.every((profile) => profile.passed),
    totals: {
      pages: cases.reduce((sum, profile) => sum + profile.pages, 0),
      bytes: cases.reduce((sum, profile) => sum + profile.bytes, 0),
      outputChars: cases.reduce((sum, profile) => sum + profile.outputChars, 0),
      textLines: cases.reduce((sum, profile) => sum + profile.textLines, 0)
    },
    rates: {
      pagesPerSecond: summarizeNumbers(cases.map((profile) => profile.pagesPerSecond)),
      outputCharsPerSecond: summarizeNumbers(
        cases.map((profile) => profile.outputCharsPerSecond)
      ),
      inputBytesPerSecond: summarizeNumbers(cases.map((profile) => profile.inputBytesPerSecond))
    },
    cases
  };
}

function throughputResult(result) {
  const throughput = result.throughput ?? {};
  const meanMs = throughput.meanMs ?? result.meanMs ?? 0;
  return {
    id: result.id,
    gate: result.gate,
    kind: result.kind,
    features: result.features ?? [],
    workload: result.workload,
    providerMode: result.providerMode,
    pages: Math.max(0, result.pages ?? 0),
    bytes: result.bytes ?? 0,
    outputChars: result.outputChars ?? 0,
    textLines: result.textLines ?? 0,
    iterations: result.iterations ?? 0,
    warmup: result.warmup ?? 0,
    startupMs: result.startup?.durationMs ?? 0,
    throughputIterations: throughput.iterations ?? 0,
    throughputMeanMs: meanMs,
    throughputMedianMs: throughput.medianMs ?? result.medianMs ?? 0,
    pagesPerSecond: throughput.pagesPerSecond ?? result.pagesPerSecond ?? 0,
    outputCharsPerSecond: meanMs > 0 ? ((result.outputChars ?? 0) * 1000) / meanMs : 0,
    inputBytesPerSecond: meanMs > 0 ? ((result.bytes ?? 0) * 1000) / meanMs : 0,
    passed: result.passed === true
  };
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
    Number.isFinite(acceptance?.maxRssDeltaBytes) ||
    Number.isFinite(acceptance?.maxHeapUsedDeltaBytes)
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
    kind: entry.kind,
    features: entry.features ?? [],
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
    acceptedOutputHash: createAcceptedOutputHash(lastResult),
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
    executionStatus: webgpuDiagnostics?.execution?.status ?? "no-routed-pages",
    preprocessing: webgpuDiagnostics?.preprocessing ?? null
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

function reportScope({ memoryLimitGated, selectedGate, selectedIds, selectAll }) {
  if (memoryLimitGated) {
    return "memory-limit-gated";
  }
  if (selectedGate) {
    return `gate:${selectedGate}`;
  }
  if (selectedIds.length > 0) {
    return "selected-ids";
  }
  return selectAll ? "all" : "selected-cases";
}

function throughputProfileType(selectedGate) {
  if (selectedGate === "text-mvp") {
    return "text-throughput";
  }
  if (selectedGate === "ocr-v1") {
    return "ocr-throughput";
  }
  return selectedGate ? `${selectedGate}-throughput` : "throughput";
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

  const scope = reportScope({ memoryLimitGated, selectedGate, selectedIds, selectAll });
  const memoryProfile = createMemoryProfileSummary(results, { scope });
  const report = {
    generatedAt: new Date().toISOString(),
    iterations,
    warmup,
    providerModes,
    comparisons: compareProviderResults(results),
    ...(memoryProfile.resultCount > 0 ? { memoryProfile } : {}),
    throughputProfile: createThroughputProfileSummary(results, {
      profileType: throughputProfileType(selectedGate),
      scope
    }),
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
