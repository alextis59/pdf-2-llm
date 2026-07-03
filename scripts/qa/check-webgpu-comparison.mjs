import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

export function evaluateWebGpuComparisonReport(report, { minSpeedup = 1.05, requireSpeedup = false } = {}) {
  const comparisons = report.comparisons ?? [];
  const parityFailures = comparisons.filter((comparison) => !comparison.equivalentAcceptedOutput);
  const webgpuComparisons = comparisons.filter(
    (comparison) => comparison.webgpuSelectedProvider === "webgpu"
  );
  const speedupFailures = webgpuComparisons.filter(
    (comparison) =>
      !Number.isFinite(comparison.speedupRatio ?? comparison.pagesPerSecondRatio) ||
      (comparison.speedupRatio ?? comparison.pagesPerSecondRatio) < minSpeedup
  );
  const fallbackReasons = [
    ...new Set(
      comparisons
        .filter((comparison) => comparison.webgpuSelectedProvider !== "webgpu")
        .map((comparison) => comparison.webgpuFallbackReason ?? "webgpu-not-selected")
    )
  ].sort();

  return {
    passed:
      parityFailures.length === 0 &&
      speedupFailures.length === 0 &&
      (!requireSpeedup || webgpuComparisons.length > 0),
    comparisonCount: comparisons.length,
    equivalentAcceptedOutputs: comparisons.length - parityFailures.length,
    parityFailures,
    minSpeedup,
    speedupAvailable: webgpuComparisons.length > 0,
    speedupComparisonCount: webgpuComparisons.length,
    speedupFailures,
    fallbackReasons,
    speedupStatus:
      webgpuComparisons.length > 0
        ? speedupFailures.length === 0
          ? "passed"
          : "failed"
        : requireSpeedup
          ? "missing"
          : "not-applicable"
  };
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

async function main() {
  const reportPath = readOption("--report");
  if (!reportPath) {
    throw new Error("Usage: node scripts/qa/check-webgpu-comparison.mjs --report <benchmark-report>");
  }
  const summaryPath = readOption("--summary");
  const minSpeedup = Number(readOption("--min-speedup") ?? 1.05);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const summary = evaluateWebGpuComparisonReport(report, {
    minSpeedup,
    requireSpeedup: hasFlag("--require-speedup")
  });

  if (summaryPath) {
    const resolvedSummaryPath = path.resolve(summaryPath);
    await mkdir(path.dirname(resolvedSummaryPath), { recursive: true });
    await writeFile(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  const prefix = summary.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} webgpu parity comparisons=${summary.comparisonCount} equivalent=${summary.equivalentAcceptedOutputs}/${summary.comparisonCount}`
  );
  if (summary.speedupAvailable) {
    console.log(
      `${prefix} webgpu speedup min=${summary.minSpeedup} passed=${summary.speedupComparisonCount - summary.speedupFailures.length}/${summary.speedupComparisonCount}`
    );
  } else {
    console.log(
      `${summary.passed ? "SKIP" : "FAIL"} webgpu speedup status=${summary.speedupStatus} fallbackReasons=${summary.fallbackReasons.join(",") || "none"}`
    );
  }

  if (!summary.passed) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
