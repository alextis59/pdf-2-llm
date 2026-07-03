import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown, warningCodes } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultExpectations = Object.freeze([
  {
    id: "synthetic-simple-text",
    expectedCodes: [warningCodes.OcrDisabled, warningCodes.HeuristicTextExtraction]
  },
  {
    id: "synthetic-two-column",
    expectedCodes: [
      warningCodes.OcrDisabled,
      warningCodes.TextOrderingUncertain,
      warningCodes.HeuristicTextExtraction
    ]
  },
  {
    id: "synthetic-vector-figure",
    expectedCodes: [
      warningCodes.OcrDisabled,
      warningCodes.FigureLowSemanticContent,
      warningCodes.HeuristicTextExtraction
    ]
  },
  {
    id: "synthetic-scanned-text",
    expectedCodes: []
  }
]);

export function compareWarningCodeSets(expectedCodes, actualCodes) {
  const expected = new Set(expectedCodes);
  const actual = new Set(actualCodes);
  const matchedCodes = [...expected].filter((code) => actual.has(code)).sort();
  const unexpectedCodes = [...actual].filter((code) => !expected.has(code)).sort();
  const missingCodes = [...expected].filter((code) => !actual.has(code)).sort();
  const precision =
    actual.size === 0 ? (expected.size === 0 ? 1 : 0) : matchedCodes.length / actual.size;
  const recall =
    expected.size === 0 ? (actual.size === 0 ? 1 : 0) : matchedCodes.length / expected.size;
  return {
    expectedCodes: [...expected].sort(),
    actualCodes: [...actual].sort(),
    matchedCodes,
    unexpectedCodes,
    missingCodes,
    precision,
    recall,
    passed: unexpectedCodes.length === 0 && missingCodes.length === 0
  };
}

export function createWarningCodeAccuracyReport(results) {
  const passed = results.every((result) => result.passed);
  const totalExpected = results.reduce((sum, result) => sum + result.expectedCodes.length, 0);
  const totalActual = results.reduce((sum, result) => sum + result.actualCodes.length, 0);
  const totalMatched = results.reduce((sum, result) => sum + result.matchedCodes.length, 0);
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed,
    precision: totalActual === 0 ? (totalExpected === 0 ? 1 : 0) : totalMatched / totalActual,
    recall: totalExpected === 0 ? (totalActual === 0 ? 1 : 0) : totalMatched / totalExpected,
    results
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

function usage() {
  return `Usage:
  node scripts/qa/check-warning-codes.mjs [--report <path>]

Options:
  --root <path>              Repository root. Defaults to cwd.
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
`;
}

async function loadOcrResults(repoRoot, entry) {
  if (!entry.ocrResultsFile) {
    return null;
  }
  const payload = JSON.parse(await readFile(path.join(repoRoot, entry.ocrResultsFile), "utf8"));
  return Array.isArray(payload) ? payload : payload.results;
}

async function runCase(repoRoot, manifestEntries, expectation) {
  const entry = manifestEntries.get(expectation.id);
  if (!entry) {
    throw new Error(`unknown manifest id "${expectation.id}"`);
  }
  const ocrResults = await loadOcrResults(repoRoot, entry);
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: ocrResults ? { results: ocrResults } : { enabled: false }
  });
  return {
    id: expectation.id,
    ...compareWarningCodeSets(
      expectation.expectedCodes,
      result.warnings.map((warning) => warning.code)
    )
  };
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const manifestPath = path.resolve(
    readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestEntries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const results = [];
  for (const expectation of defaultExpectations) {
    const result = await runCase(repoRoot, manifestEntries, expectation);
    results.push(result);
    const prefix = result.passed ? "PASS" : "FAIL";
    console.log(
      `${prefix} ${result.id} warningPrecision=${formatNumber(result.precision)} ` +
        `warningRecall=${formatNumber(result.recall)} expected=${result.expectedCodes.join(",") || "none"} ` +
        `actual=${result.actualCodes.join(",") || "none"}`
    );
  }

  const report = createWarningCodeAccuracyReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Warning-code accuracy check failed.");
  }
  console.log(
    `Warning-code accuracy passed: ${results.length} case(s), precision=${formatNumber(
      report.precision
    )}, recall=${formatNumber(report.recall)}`
  );
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
