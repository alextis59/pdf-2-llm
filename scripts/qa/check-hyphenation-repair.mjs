import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultExpectations = Object.freeze([
  {
    id: "synthetic-hyphenated-line",
    repairedTerms: ["hyphenation"],
    rejectedTerms: ["hyphen- ation", "hyphen-\nation", "hyphen-ation"]
  }
]);

export function compareHyphenationRepairs(markdown, expectation) {
  const text = normalizeMarkdownText(markdown);
  const repairedTerms = expectation.repairedTerms ?? [];
  const rejectedTerms = expectation.rejectedTerms ?? [];
  const matchedTerms = repairedTerms.filter((term) => text.includes(normalizeMarkdownText(term)));
  const missingTerms = repairedTerms.filter((term) => !text.includes(normalizeMarkdownText(term)));
  const rejectedTermsPresent = rejectedTerms.filter((term) =>
    text.includes(normalizeMarkdownText(term))
  );
  const accuracy =
    repairedTerms.length === 0 ? (rejectedTermsPresent.length === 0 ? 1 : 0) : matchedTerms.length / repairedTerms.length;
  return {
    repairedTerms,
    rejectedTerms,
    matchedTerms,
    missingTerms,
    rejectedTermsPresent,
    accuracy,
    passed: accuracy === 1 && rejectedTermsPresent.length === 0
  };
}

export function createHyphenationRepairReport(results) {
  const expectedRepairs = results.reduce((sum, result) => sum + result.repairedTerms.length, 0);
  const matchedRepairs = results.reduce((sum, result) => sum + result.matchedTerms.length, 0);
  const rejectedTermsPresent = results.reduce(
    (sum, result) => sum + result.rejectedTermsPresent.length,
    0
  );
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed: results.every((result) => result.passed),
    accuracy:
      expectedRepairs === 0 ? (rejectedTermsPresent === 0 ? 1 : 0) : matchedRepairs / expectedRepairs,
    expectedRepairs,
    matchedRepairs,
    rejectedTermsPresent,
    results
  };
}

function normalizeMarkdownText(markdown) {
  return String(markdown ?? "")
    .replace(/!\[([^\]\n]*)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`|[\]()>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  node scripts/qa/check-hyphenation-repair.mjs [--id <manifest-id>] [--report <path>]

Options:
  --root <path>              Repository root. Defaults to cwd.
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
`;
}

async function runCase(repoRoot, manifestEntries, expectation) {
  const entry = manifestEntries.get(expectation.id);
  if (!entry) {
    throw new Error(`unknown manifest id "${expectation.id}"`);
  }
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: { enabled: false }
  });
  return {
    id: expectation.id,
    path: entry.path,
    ...compareHyphenationRepairs(result.markdown, expectation)
  };
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} hyphenationAccuracy=${formatNumber(result.accuracy)} ` +
      `matched=${result.matchedTerms.length}/${result.repairedTerms.length} ` +
      `rejectedPresent=${result.rejectedTermsPresent.length}`
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
  const selectedIds = new Set(readOptions("--id"));
  const expectations =
    selectedIds.size === 0
      ? defaultExpectations
      : defaultExpectations.filter((expectation) => selectedIds.has(expectation.id));
  for (const id of selectedIds) {
    if (!defaultExpectations.some((expectation) => expectation.id === id)) {
      throw new Error(`unknown hyphenation expectation id "${id}"`);
    }
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestEntries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const results = [];
  for (const expectation of expectations) {
    const result = await runCase(repoRoot, manifestEntries, expectation);
    results.push(result);
    printResult(result);
  }

  const report = createHyphenationRepairReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Hyphenation repair accuracy check failed.");
  }
  console.log(
    `Hyphenation repair accuracy passed: ${results.length} case(s), accuracy=${formatNumber(
      report.accuracy
    )}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
