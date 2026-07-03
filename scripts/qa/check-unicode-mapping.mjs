import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown, warningCodes } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultCaseIds = Object.freeze([
  "synthetic-rtl-text",
  "synthetic-cjk-text",
  "synthetic-vertical-writing"
]);

export function extractMappedUnicodeText(markdown) {
  const plainText = String(markdown ?? "")
    .replace(/!\[([^\]\n]*)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`|[\]()>-]/g, " ")
    .replace(/\s+/g, " ")
    .normalize("NFC");
  return [...plainText].filter((character) => character.codePointAt(0) > 0x7f).join("");
}

export function compareUnicodeMapping(expectedMarkdown, actualMarkdown) {
  const expectedText = extractMappedUnicodeText(expectedMarkdown);
  const actualText = extractMappedUnicodeText(actualMarkdown);
  const expectedCodePoints = [...expectedText];
  const actualCodePoints = [...actualText];
  const editDistance = levenshteinDistance(expectedCodePoints, actualCodePoints);
  const accuracy =
    expectedCodePoints.length === 0
      ? actualCodePoints.length === 0
        ? 1
        : 0
      : Math.max(0, 1 - editDistance / expectedCodePoints.length);
  return {
    expectedText,
    actualText,
    expectedCodePoints: expectedCodePoints.length,
    actualCodePoints: actualCodePoints.length,
    editDistance,
    accuracy,
    passed: accuracy === 1
  };
}

export function createUnicodeMappingAccuracyReport(results) {
  const expectedCodePoints = results.reduce((sum, result) => sum + result.expectedCodePoints, 0);
  const editDistance = results.reduce((sum, result) => sum + result.editDistance, 0);
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed: results.every((result) => result.passed),
    accuracy:
      expectedCodePoints === 0 ? (editDistance === 0 ? 1 : 0) : Math.max(0, 1 - editDistance / expectedCodePoints),
    expectedCodePoints,
    editDistance,
    results
  };
}

function levenshteinDistance(left, right) {
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost
      );
    }
    previous = current;
  }
  return previous[right.length];
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
  node scripts/qa/check-unicode-mapping.mjs [--id <manifest-id>] [--report <path>]

Options:
  --root <path>              Repository root. Defaults to cwd.
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
`;
}

async function runCase(repoRoot, manifestEntries, id) {
  const entry = manifestEntries.get(id);
  if (!entry) {
    throw new Error(`unknown manifest id "${id}"`);
  }
  const expectedPath = path.join(repoRoot, "corpus", "expected", `${id}.md`);
  const expectedMarkdown = await readFile(expectedPath, "utf8");
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: { enabled: false }
  });
  const comparison = compareUnicodeMapping(expectedMarkdown, result.markdown);
  const unicodeMappingWarnings = result.warnings.filter(
    (warning) => warning.code === warningCodes.TextUnicodeMappingSuspect
  );
  return {
    id,
    path: entry.path,
    expectedPath: path.relative(repoRoot, expectedPath),
    ...comparison,
    unicodeMappingWarnings: unicodeMappingWarnings.map((warning) => warning.details ?? {}),
    passed: comparison.passed && unicodeMappingWarnings.length === 0
  };
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} unicodeAccuracy=${formatNumber(result.accuracy)} ` +
      `edits=${result.editDistance}/${result.expectedCodePoints} ` +
      `unicodeWarnings=${result.unicodeMappingWarnings.length}`
  );
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
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
  const selectedIds = readOptions("--id");
  const caseIds = selectedIds.length > 0 ? selectedIds : defaultCaseIds;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestEntries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const results = [];
  for (const id of caseIds) {
    const result = await runCase(repoRoot, manifestEntries, id);
    results.push(result);
    printResult(result);
  }

  const report = createUnicodeMappingAccuracyReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Unicode mapping accuracy check failed.");
  }
  console.log(
    `Unicode mapping accuracy passed: ${results.length} case(s), accuracy=${formatNumber(
      report.accuracy
    )}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
