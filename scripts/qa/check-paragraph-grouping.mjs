import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultCaseIds = Object.freeze([
  "synthetic-simple-text",
  "synthetic-scientific-two-column",
  "synthetic-header-footer",
  "synthetic-footnote",
  "synthetic-cjk-text",
  "synthetic-rtl-text",
  "synthetic-vertical-writing"
]);

export function extractParagraphBlocks(markdown) {
  const blocks = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.flatMap((block) => {
    if (isNonParagraphBlock(block)) {
      return [];
    }
    const htmlParagraph = block.match(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/);
    if (htmlParagraph) {
      return [normalizeParagraphText(stripHtml(htmlParagraph[1]))];
    }
    return [normalizeParagraphText(block.split("\n").join(" "))];
  });
}

export function compareParagraphGrouping(expectedMarkdown, actualMarkdown) {
  const expectedParagraphs = extractParagraphBlocks(expectedMarkdown);
  const actualParagraphs = extractParagraphBlocks(actualMarkdown);
  const matchedParagraphs = countMatchedParagraphs(expectedParagraphs, actualParagraphs);
  const precision =
    actualParagraphs.length === 0
      ? expectedParagraphs.length === 0
        ? 1
        : 0
      : matchedParagraphs / actualParagraphs.length;
  const recall =
    expectedParagraphs.length === 0
      ? actualParagraphs.length === 0
        ? 1
        : 0
      : matchedParagraphs / expectedParagraphs.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    expectedParagraphs: expectedParagraphs.length,
    actualParagraphs: actualParagraphs.length,
    matchedParagraphs,
    precision,
    recall,
    f1,
    missingParagraphs: subtractMultiset(expectedParagraphs, actualParagraphs),
    extraParagraphs: subtractMultiset(actualParagraphs, expectedParagraphs),
    passed: f1 === 1
  };
}

export function createParagraphGroupingReport(results) {
  const expectedParagraphs = results.reduce((sum, result) => sum + result.expectedParagraphs, 0);
  const actualParagraphs = results.reduce((sum, result) => sum + result.actualParagraphs, 0);
  const matchedParagraphs = results.reduce((sum, result) => sum + result.matchedParagraphs, 0);
  const precision =
    actualParagraphs === 0 ? (expectedParagraphs === 0 ? 1 : 0) : matchedParagraphs / actualParagraphs;
  const recall =
    expectedParagraphs === 0 ? (actualParagraphs === 0 ? 1 : 0) : matchedParagraphs / expectedParagraphs;
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed: results.every((result) => result.passed),
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    expectedParagraphs,
    actualParagraphs,
    matchedParagraphs,
    results
  };
}

function isNonParagraphBlock(block) {
  const lines = block.split("\n");
  const firstLine = lines[0] ?? "";
  return (
    /^#{1,6}\s+/.test(firstLine) ||
    /^<a id="page-\d+"><\/a>$/.test(block) ||
    /^!\[[^\]\n]*\]\([^)]+\)$/.test(block) ||
    lines.every((line) => /^-\s+/.test(line)) ||
    lines.every((line) => /^\d+\.\s+/.test(line)) ||
    isGfmTable(lines) ||
    /^<table(?:\s[^>]*)?>[\s\S]*<\/table>$/.test(block) ||
    /^```[\s\S]*```$/.test(block) ||
    /^\$\$[\s\S]*\$\$$/.test(block)
  );
}

function isGfmTable(lines) {
  return (
    lines.length >= 2 &&
    lines.every((line) => line.trim().startsWith("|") && line.trim().endsWith("|")) &&
    /^\|\s*:?-{3,}:?/.test(lines[1])
  );
}

function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ");
}

function normalizeParagraphText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function countMatchedParagraphs(expected, actual) {
  const actualCounts = toCounts(actual);
  let matched = 0;
  for (const paragraph of expected) {
    const count = actualCounts.get(paragraph) ?? 0;
    if (count > 0) {
      matched += 1;
      actualCounts.set(paragraph, count - 1);
    }
  }
  return matched;
}

function subtractMultiset(left, right) {
  const rightCounts = toCounts(right);
  const result = [];
  for (const value of left) {
    const count = rightCounts.get(value) ?? 0;
    if (count > 0) {
      rightCounts.set(value, count - 1);
    } else {
      result.push(value);
    }
  }
  return result;
}

function toCounts(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
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
  node scripts/qa/check-paragraph-grouping.mjs [--id <manifest-id>] [--report <path>]

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
  return {
    id,
    path: entry.path,
    expectedPath: path.relative(repoRoot, expectedPath),
    ...compareParagraphGrouping(expectedMarkdown, result.markdown)
  };
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} paragraphF1=${formatNumber(result.f1)} ` +
      `precision=${formatNumber(result.precision)} recall=${formatNumber(result.recall)} ` +
      `matched=${result.matchedParagraphs}/${result.expectedParagraphs}`
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

  const report = createParagraphGroupingReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Paragraph grouping F1 check failed.");
  }
  console.log(`Paragraph grouping F1 passed: ${results.length} case(s), f1=${formatNumber(report.f1)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
