import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

const defaultInputs = Object.freeze({
  currentText: ".temp/qa/text-throughput-benchmark.json",
  baselineText: "corpus/reports/text-throughput-benchmark.json",
  currentOcr: ".temp/qa/ocr-throughput-benchmark.json",
  baselineOcr: "corpus/reports/ocr-throughput-benchmark.json",
  currentStartup: ".temp/qa/startup-benchmark.json",
  baselineStartup: "corpus/reports/startup-benchmark.json",
  currentMemory: ".temp/qa/long-memory-profile.json",
  baselineMemory: "corpus/reports/long-memory-profile.json"
});

const defaultBudget = Object.freeze({
  minPagesPerSecondRatio: 0.02,
  minPagesPerSecond: 10,
  maxStartupMeanRatio: 8,
  maxStartupMeanMs: 250,
  maxMemoryPeakDeltaRatio: 2,
  maxMemoryPeakDeltaBytes: 256 * 1024 * 1024
});

export function evaluatePerformanceRegression({ currentReports, baselineReports }, budget = defaultBudget) {
  return [
    ...throughputChecks({
      currentReport: currentReports.text,
      baselineReport: baselineReports.text,
      profileName: "text-throughput",
      budget
    }),
    ...throughputChecks({
      currentReport: currentReports.ocr,
      baselineReport: baselineReports.ocr,
      profileName: "ocr-throughput",
      budget
    }),
    ...startupChecks({
      currentReport: currentReports.startup,
      baselineReport: baselineReports.startup,
      budget
    }),
    ...memoryChecks({
      currentReport: currentReports.memory,
      baselineReport: baselineReports.memory,
      budget
    })
  ];
}

export function createPerformanceRegressionReport(
  { currentReports, baselineReports, inputs = defaultInputs },
  { budget = defaultBudget } = {}
) {
  const checks = evaluatePerformanceRegression({ currentReports, baselineReports }, budget);
  const violations = checks.filter((check) => !check.passed);
  return {
    generatedAt: new Date().toISOString(),
    budget,
    inputs,
    checks,
    violations,
    passed: violations.length === 0
  };
}

export function findPerformanceInputSelfComparisons(inputs, repoRoot = process.cwd()) {
  return [
    ["text-throughput", "currentText", "baselineText"],
    ["ocr-throughput", "currentOcr", "baselineOcr"],
    ["entrypoint-startup", "currentStartup", "baselineStartup"],
    ["long-memory", "currentMemory", "baselineMemory"]
  ]
    .filter(([, currentKey, baselineKey]) => {
      const currentPath = inputs[currentKey];
      const baselinePath = inputs[baselineKey];
      return (
        typeof currentPath === "string" &&
        typeof baselinePath === "string" &&
        path.resolve(repoRoot, currentPath) === path.resolve(repoRoot, baselinePath)
      );
    })
    .map(([profile, currentKey, baselineKey]) => ({
      profile,
      current: inputs[currentKey],
      baseline: inputs[baselineKey]
    }));
}

function throughputChecks({ currentReport, baselineReport, profileName, budget }) {
  const checks = [
    profilePassedCheck({
      profileName,
      metric: "throughputProfile.passed",
      actual: currentReport.throughputProfile?.passed
    })
  ];
  const currentCases = casesById(currentReport.throughputProfile?.cases);
  const baselineCases = baselineReport.throughputProfile?.cases ?? [];
  for (const baselineCase of baselineCases) {
    const currentCase = currentCases.get(baselineCase.id);
    if (!currentCase) {
      checks.push(missingCaseCheck({ profileName, id: baselineCase.id }));
      continue;
    }
    const baseline = finiteNumber(baselineCase.pagesPerSecond);
    const actual = finiteNumber(currentCase.pagesPerSecond);
    const threshold = Math.max(baseline * budget.minPagesPerSecondRatio, budget.minPagesPerSecond);
    checks.push({
      profile: profileName,
      id: baselineCase.id,
      metric: "pagesPerSecond",
      direction: "at-least",
      actual,
      baseline,
      threshold,
      passed: actual >= threshold
    });
  }
  return checks;
}

function startupChecks({ currentReport, baselineReport, budget }) {
  const profileName = "entrypoint-startup";
  const checks = [
    profilePassedCheck({
      profileName,
      metric: "startupProfile.passed",
      actual: currentReport.startupProfile?.passed
    })
  ];
  const currentCases = casesById(currentReport.startupProfile?.cases);
  const baselineCases = baselineReport.startupProfile?.cases ?? [];
  for (const baselineCase of baselineCases) {
    const currentCase = currentCases.get(baselineCase.id);
    if (!currentCase) {
      checks.push(missingCaseCheck({ profileName, id: baselineCase.id }));
      continue;
    }
    const baseline = finiteNumber(baselineCase.totalStartupMs?.meanMs);
    const actual = finiteNumber(currentCase.totalStartupMs?.meanMs);
    const threshold = upperThreshold({
      baseline,
      ratio: budget.maxStartupMeanRatio,
      absolute: budget.maxStartupMeanMs
    });
    checks.push({
      profile: profileName,
      id: baselineCase.id,
      metric: "totalStartupMeanMs",
      direction: "at-most",
      actual,
      baseline,
      threshold,
      passed: actual <= threshold
    });
  }
  return checks;
}

function memoryChecks({ currentReport, baselineReport, budget }) {
  const profileName = "long-memory";
  const checks = [
    profilePassedCheck({
      profileName,
      metric: "memoryProfile.passed",
      actual: currentReport.memoryProfile?.passed
    })
  ];
  const currentCases = casesById(currentReport.memoryProfile?.cases);
  const baselineCases = baselineReport.memoryProfile?.cases ?? [];
  for (const baselineCase of baselineCases) {
    const currentCase = currentCases.get(baselineCase.id);
    if (!currentCase) {
      checks.push(missingCaseCheck({ profileName, id: baselineCase.id }));
      continue;
    }
    const baseline = finiteNumber(baselineCase.rssPeakDeltaBytes);
    const actual = finiteNumber(currentCase.rssPeakDeltaBytes);
    const threshold = upperThreshold({
      baseline,
      ratio: budget.maxMemoryPeakDeltaRatio,
      absolute: budget.maxMemoryPeakDeltaBytes
    });
    checks.push({
      profile: profileName,
      id: baselineCase.id,
      metric: "rssPeakDeltaBytes",
      direction: "at-most",
      actual,
      baseline,
      threshold,
      passed: actual <= threshold
    });
  }
  return checks;
}

function profilePassedCheck({ profileName, metric, actual }) {
  return {
    profile: profileName,
    id: profileName,
    metric,
    direction: "equals",
    actual,
    baseline: true,
    threshold: true,
    passed: actual === true
  };
}

function missingCaseCheck({ profileName, id }) {
  return {
    profile: profileName,
    id,
    metric: "case-present",
    direction: "equals",
    actual: null,
    baseline: "present",
    threshold: "present",
    passed: false
  };
}

function casesById(cases = []) {
  return new Map(cases.map((entry) => [entry.id, entry]));
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function upperThreshold({ baseline, ratio, absolute }) {
  const thresholds = [];
  if (Number.isFinite(baseline) && Number.isFinite(ratio)) {
    thresholds.push(baseline * ratio);
  }
  if (Number.isFinite(absolute)) {
    thresholds.push(absolute);
  }
  return thresholds.length > 0 ? Math.min(...thresholds) : Number.POSITIVE_INFINITY;
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

function readNumberOption(name, fallback) {
  const value = readOption(name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function usage() {
  return `Usage:
  node scripts/qa/check-performance-regression.mjs [--report <path>]

Options:
  --root <path>                         Repository root. Defaults to cwd.
  --current-text <path>                 Current text benchmark report.
  --baseline-text <path>                Baseline text benchmark report.
  --current-ocr <path>                  Current OCR benchmark report.
  --baseline-ocr <path>                 Baseline OCR benchmark report.
  --current-startup <path>              Current startup benchmark report.
  --baseline-startup <path>             Baseline startup benchmark report.
  --current-memory <path>               Current long-memory report.
  --baseline-memory <path>              Baseline long-memory report.
  --min-pages-per-second-ratio <n>      Throughput ratio floor. Defaults to ${defaultBudget.minPagesPerSecondRatio}.
  --min-pages-per-second <n>            Absolute throughput floor. Defaults to ${defaultBudget.minPagesPerSecond}.
  --max-startup-mean-ratio <n>          Startup ratio ceiling. Defaults to ${defaultBudget.maxStartupMeanRatio}.
  --max-startup-mean-ms <n>             Absolute startup ceiling. Defaults to ${defaultBudget.maxStartupMeanMs}.
  --max-memory-peak-delta-ratio <n>     Memory ratio ceiling. Defaults to ${defaultBudget.maxMemoryPeakDeltaRatio}.
  --max-memory-peak-delta-bytes <n>     Absolute memory ceiling. Defaults to ${defaultBudget.maxMemoryPeakDeltaBytes}.
`;
}

async function readJson(repoRoot, filePath) {
  const resolvedPath = path.resolve(repoRoot, filePath);
  try {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath} is not readable JSON: ${error.message}`);
  }
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const inputs = {
    currentText: readOption("--current-text") ?? defaultInputs.currentText,
    baselineText: readOption("--baseline-text") ?? defaultInputs.baselineText,
    currentOcr: readOption("--current-ocr") ?? defaultInputs.currentOcr,
    baselineOcr: readOption("--baseline-ocr") ?? defaultInputs.baselineOcr,
    currentStartup: readOption("--current-startup") ?? defaultInputs.currentStartup,
    baselineStartup: readOption("--baseline-startup") ?? defaultInputs.baselineStartup,
    currentMemory: readOption("--current-memory") ?? defaultInputs.currentMemory,
    baselineMemory: readOption("--baseline-memory") ?? defaultInputs.baselineMemory
  };
  const selfComparisons = findPerformanceInputSelfComparisons(inputs, repoRoot);
  if (selfComparisons.length > 0) {
    throw new Error(
      `Current performance inputs must differ from their baselines: ${selfComparisons
        .map((comparison) => `${comparison.profile} (${comparison.current})`)
        .join(", ")}`
    );
  }
  const budget = {
    minPagesPerSecondRatio: readNumberOption(
      "--min-pages-per-second-ratio",
      defaultBudget.minPagesPerSecondRatio
    ),
    minPagesPerSecond: readNumberOption(
      "--min-pages-per-second",
      defaultBudget.minPagesPerSecond
    ),
    maxStartupMeanRatio: readNumberOption(
      "--max-startup-mean-ratio",
      defaultBudget.maxStartupMeanRatio
    ),
    maxStartupMeanMs: readNumberOption("--max-startup-mean-ms", defaultBudget.maxStartupMeanMs),
    maxMemoryPeakDeltaRatio: readNumberOption(
      "--max-memory-peak-delta-ratio",
      defaultBudget.maxMemoryPeakDeltaRatio
    ),
    maxMemoryPeakDeltaBytes: readNumberOption(
      "--max-memory-peak-delta-bytes",
      defaultBudget.maxMemoryPeakDeltaBytes
    )
  };
  const currentReports = {
    text: await readJson(repoRoot, inputs.currentText),
    ocr: await readJson(repoRoot, inputs.currentOcr),
    startup: await readJson(repoRoot, inputs.currentStartup),
    memory: await readJson(repoRoot, inputs.currentMemory)
  };
  const baselineReports = {
    text: await readJson(repoRoot, inputs.baselineText),
    ocr: await readJson(repoRoot, inputs.baselineOcr),
    startup: await readJson(repoRoot, inputs.baselineStartup),
    memory: await readJson(repoRoot, inputs.baselineMemory)
  };
  const report = createPerformanceRegressionReport(
    { currentReports, baselineReports, inputs },
    { budget }
  );
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(
    `Performance regression ${report.passed ? "passed" : "failed"}: ` +
      `${report.checks.length} checks, ${report.violations.length} violation(s)`
  );
  if (!report.passed) {
    for (const violation of report.violations) {
      console.error(
        `${violation.profile}:${violation.id} ${violation.metric} actual=${violation.actual} ` +
          `threshold=${violation.threshold} baseline=${violation.baseline}`
      );
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
