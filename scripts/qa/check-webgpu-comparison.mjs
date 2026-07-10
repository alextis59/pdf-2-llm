import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateWebGpuComparisonReport(report, { minSpeedup, requireSpeedup }) {
  const errors = [];
  if (!Number.isFinite(minSpeedup) || minSpeedup <= 0) {
    errors.push("minSpeedup must be a finite number greater than zero");
  }
  if (typeof requireSpeedup !== "boolean") {
    errors.push("requireSpeedup must be a boolean");
  }
  if (!isRecord(report)) {
    errors.push("report must be an object");
    return errors;
  }
  if (!Array.isArray(report.comparisons)) {
    errors.push("report.comparisons must be an array");
    return errors;
  }
  if (report.comparisons.length === 0) {
    errors.push("report.comparisons must contain at least one comparison");
    return errors;
  }

  const ids = new Set();
  for (const [index, comparison] of report.comparisons.entries()) {
    const location = `report.comparisons[${index}]`;
    if (!isRecord(comparison)) {
      errors.push(`${location} must be an object`);
      continue;
    }
    if (typeof comparison.id !== "string" || comparison.id.trim() === "") {
      errors.push(`${location}.id must be a non-empty string`);
    } else if (ids.has(comparison.id)) {
      errors.push(`${location}.id must be unique`);
    } else {
      ids.add(comparison.id);
    }
    if (typeof comparison.equivalentAcceptedOutput !== "boolean") {
      errors.push(`${location}.equivalentAcceptedOutput must be a boolean`);
    }
    if (!new Set(["cpu", "webgpu"]).has(comparison.webgpuSelectedProvider)) {
      errors.push(`${location}.webgpuSelectedProvider must be \"cpu\" or \"webgpu\"`);
    }
    for (const metric of ["speedupRatio", "pagesPerSecondRatio"]) {
      const value = comparison[metric];
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
        errors.push(`${location}.${metric} must be null or a finite non-negative number`);
      }
    }
    const selectedRatio = comparison.speedupRatio ?? comparison.pagesPerSecondRatio;
    if (
      comparison.webgpuSelectedProvider === "webgpu" &&
      (!Number.isFinite(selectedRatio) || selectedRatio < 0)
    ) {
      errors.push(`${location} must include a finite non-negative speedup ratio`);
    }
  }
  return errors;
}

export function evaluateWebGpuComparisonReport(report, { minSpeedup = 1.05, requireSpeedup = false } = {}) {
  const validationErrors = validateWebGpuComparisonReport(report, { minSpeedup, requireSpeedup });
  if (validationErrors.length > 0) {
    return {
      passed: false,
      comparisonCount: Array.isArray(report?.comparisons) ? report.comparisons.length : 0,
      equivalentAcceptedOutputs: 0,
      parityFailures: [],
      minSpeedup,
      speedupAvailable: false,
      speedupComparisonCount: 0,
      speedupFailures: [],
      fallbackReasons: [],
      speedupStatus: "invalid",
      validationErrors
    };
  }

  const comparisons = report.comparisons;
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
          : "not-applicable",
    validationErrors
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
  for (const error of summary.validationErrors) {
    console.error(`FAIL webgpu comparison report: ${error}`);
  }
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
