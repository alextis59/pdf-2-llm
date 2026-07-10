import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { collectExecutionEnvironment } from "./execution-environment.mjs";

const args = process.argv.slice(2);

const defaultFixture = "corpus/generated/synthetic-simple-text.pdf";
const targets = [
  {
    id: "node-entrypoint",
    runtime: "node",
    entrypoint: "packages/pdf2md/src/node.mjs"
  },
  {
    id: "browser-entrypoint",
    runtime: "browser",
    entrypoint: "packages/pdf2md/src/browser.mjs"
  }
];

function summarizeDurations(durationsMs) {
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

export function createStartupProfile(results, { scope = "entrypoints" } = {}) {
  const cases = results.map((result) => ({
    id: result.id,
    runtime: result.runtime,
    entrypoint: result.entrypoint,
    executionEnvironment: result.executionEnvironment,
    iterations: result.iterations,
    warmup: result.warmup,
    importMs: summarizeDurations(result.samples.map((sample) => sample.importMs)),
    firstConversionMs: summarizeDurations(
      result.samples.map((sample) => sample.firstConversionMs)
    ),
    totalStartupMs: summarizeDurations(result.samples.map((sample) => sample.totalStartupMs)),
    outputChars: result.outputChars,
    textLines: result.textLines,
    passed: result.passed
  }));
  return {
    profileType: "entrypoint-startup",
    scope,
    resultCount: cases.length,
    passed: cases.every((entry) => entry.passed),
    totals: {
      outputChars: cases.reduce((sum, entry) => sum + entry.outputChars, 0),
      textLines: cases.reduce((sum, entry) => sum + entry.textLines, 0)
    },
    cases
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

function usage() {
  return `Usage:
  node scripts/qa/startup-benchmark.mjs [--iterations <n>] [--warmup <n>] [--report <path>]

Options:
  --root <path>              Repository root. Defaults to cwd.
  --fixture <path>           Fixture PDF path. Defaults to ${defaultFixture}.
  --dry-run                  Print selected startup targets without measuring.
`;
}

async function runStartupBenchmark({ repoRoot, fixturePath, iterations, warmup }) {
  if (iterations === 0 && !hasFlag("--dry-run")) {
    throw new Error("--iterations must be greater than 0 unless --dry-run is used");
  }

  const results = [];
  for (const target of targets) {
    for (let index = 0; index < warmup; index += 1) {
      runWorker({ repoRoot, fixturePath, target });
    }
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      samples.push(runWorker({ repoRoot, fixturePath, target }));
    }
    const lastSample = samples[samples.length - 1] ?? {
      outputChars: 0,
      textLines: 0
    };
    results.push({
      id: target.id,
      runtime: target.runtime,
      entrypoint: target.entrypoint,
      executionEnvironment: "node-esm-fresh-process",
      iterations,
      warmup,
      samples,
      outputChars: lastSample.outputChars,
      textLines: lastSample.textLines,
      passed: samples.every((sample) => sample.passed)
    });
  }
  return results;
}

function runWorker({ repoRoot, fixturePath, target }) {
  const child = spawnSync(
    process.execPath,
    [
      process.argv[1],
      "--startup-worker",
      target.id,
      "--root",
      repoRoot,
      "--fixture",
      fixturePath
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 8
    }
  );
  if (child.status !== 0) {
    throw new Error(
      `${target.id} startup worker failed with exit ${child.status}: ${child.stderr || child.stdout}`
    );
  }
  return JSON.parse(child.stdout);
}

async function runWorkerProcess() {
  const targetId = readOption("--startup-worker");
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new Error(`unknown startup target "${targetId}"`);
  }
  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const fixturePath = path.resolve(repoRoot, readOption("--fixture") ?? defaultFixture);
  const bytes = await readFile(fixturePath);
  const entrypointUrl = pathToFileURL(path.join(repoRoot, target.entrypoint)).href;

  const startedAt = performance.now();
  const importStartedAt = performance.now();
  const entrypoint = await import(entrypointUrl);
  const importMs = performance.now() - importStartedAt;

  const conversionStartedAt = performance.now();
  const result = await entrypoint.convertPdfToMarkdown(bytes, {
    ocr: { enabled: false }
  });
  const firstConversionMs = performance.now() - conversionStartedAt;
  const totalStartupMs = performance.now() - startedAt;

  process.stdout.write(
    `${JSON.stringify({
      id: target.id,
      runtime: target.runtime,
      importMs,
      firstConversionMs,
      totalStartupMs,
      outputChars: result.markdown.length,
      textLines: result.diagnostics.extraction.textLines,
      passed: true
    })}\n`
  );
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  if (readOption("--startup-worker")) {
    await runWorkerProcess();
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const fixturePath = readOption("--fixture") ?? defaultFixture;
  const iterations = readIntegerOption("--iterations", 3);
  const warmup = readIntegerOption("--warmup", 1);

  if (hasFlag("--dry-run")) {
    for (const target of targets) {
      console.log(`SELECT ${target.id} runtime=${target.runtime} entrypoint=${target.entrypoint}`);
    }
    console.log(`Selected ${targets.length} startup target(s).`);
    return;
  }

  const results = await runStartupBenchmark({
    repoRoot,
    fixturePath,
    iterations,
    warmup
  });
  for (const result of results) {
    const total = summarizeDurations(result.samples.map((sample) => sample.totalStartupMs));
    const imported = summarizeDurations(result.samples.map((sample) => sample.importMs));
    console.log(
      `STARTUP ${result.id} runtime=${result.runtime} totalMeanMs=${formatNumber(
        total.meanMs
      )} totalMedianMs=${formatNumber(total.medianMs)} importMeanMs=${formatNumber(
        imported.meanMs
      )} outputChars=${result.outputChars} textLines=${result.textLines}`
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    iterations,
    warmup,
    fixture: {
      path: fixturePath
    },
    executionEnvironment: {
      ...await collectExecutionEnvironment({ repoRoot }),
      benchmarkMode: "node-esm-fresh-process",
      notes:
        "Browser package entrypoint startup is measured under Node ESM; real browser smoke is tracked separately in release readiness."
    },
    startupProfile: createStartupProfile(results),
    results
  };
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(`Startup benchmark completed: ${results.length}.`);
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
