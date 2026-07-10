import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultCaseIds = Object.freeze([
  "synthetic-borderless-table",
  "synthetic-visible-table",
  "synthetic-split-across-page-table",
  "synthetic-table-with-note",
  "synthetic-complex-spanned-table",
  "synthetic-simple-text",
  "synthetic-two-column"
]);

export function extractTableBlocks(markdown) {
  const blocks = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.flatMap((block) => {
    const lines = block.split("\n");
    if (isGfmTable(lines)) {
      return [{ format: "gfm", text: block }];
    }
    if (/^<table(?:\s[^>]*)?>[\s\S]*<\/table>$/.test(block)) {
      return [{ format: "html", text: normalizeHtmlTable(block) }];
    }
    return [];
  });
}

export function compareTableDetection(expectedMarkdown, actualMarkdown) {
  const expectedTables = extractTableBlocks(expectedMarkdown);
  const actualTables = extractTableBlocks(actualMarkdown);
  const actualMatchCounts = new Map();
  for (const table of actualTables) {
    const key = tableMatchKey(table);
    actualMatchCounts.set(key, (actualMatchCounts.get(key) ?? 0) + 1);
  }
  let truePositives = 0;
  for (const table of expectedTables) {
    const key = tableMatchKey(table);
    const remaining = actualMatchCounts.get(key) ?? 0;
    if (remaining > 0) {
      truePositives += 1;
      actualMatchCounts.set(key, remaining - 1);
    }
  }
  const falsePositives = actualTables.length - truePositives;
  const falseNegatives = expectedTables.length - truePositives;
  const precision =
    actualTables.length === 0 ? (expectedTables.length === 0 ? 1 : 0) : truePositives / actualTables.length;
  const recall =
    expectedTables.length === 0 ? (actualTables.length === 0 ? 1 : 0) : truePositives / expectedTables.length;
  return {
    expectedTables: expectedTables.length,
    actualTables: actualTables.length,
    expectedFormats: countFormats(expectedTables),
    actualFormats: countFormats(actualTables),
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    passed: falsePositives === 0 && falseNegatives === 0
  };
}

export function createTableDetectionReport(results) {
  const expectedTables = results.reduce((sum, result) => sum + result.expectedTables, 0);
  const actualTables = results.reduce((sum, result) => sum + result.actualTables, 0);
  const truePositives = results.reduce((sum, result) => sum + result.truePositives, 0);
  const falsePositives = results.reduce((sum, result) => sum + result.falsePositives, 0);
  const falseNegatives = results.reduce((sum, result) => sum + result.falseNegatives, 0);
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed: results.every((result) => result.passed),
    precision: actualTables === 0 ? (expectedTables === 0 ? 1 : 0) : truePositives / actualTables,
    recall: expectedTables === 0 ? (actualTables === 0 ? 1 : 0) : truePositives / expectedTables,
    expectedTables,
    actualTables,
    truePositives,
    falsePositives,
    falseNegatives,
    results
  };
}

function isGfmTable(lines) {
  return (
    lines.length >= 2 &&
    lines.every((line) => line.trim().startsWith("|") && line.trim().endsWith("|")) &&
    /^\|\s*:?-{3,}:?/.test(lines[1])
  );
}

function normalizeHtmlTable(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function tableMatchKey(table) {
  const rows = table.format === "gfm" ? readGfmRows(table.text) : readHtmlRows(table.text);
  return JSON.stringify([table.format, rows]);
}

function readGfmRows(value) {
  return value
    .split("\n")
    .filter((_, index) => index !== 1)
    .map(splitGfmRow);
}

function splitGfmRow(value) {
  const trimmed = value.trim();
  const source = trimmed.slice(trimmed.startsWith("|") ? 1 : 0, trimmed.endsWith("|") ? -1 : undefined);
  const cells = [];
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(normalizeCellValue(current));
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(normalizeCellValue(current));
  return cells;
}

function readHtmlRows(value) {
  const rows = [];
  for (const rowMatch of value.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(th|td)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
      cells.push({
        type: cellMatch[1].toLowerCase(),
        colspan: readHtmlSpan(cellMatch[2], "colspan"),
        rowspan: readHtmlSpan(cellMatch[2], "rowspan"),
        value: normalizeCellValue(cellMatch[3].replace(/<[^>]+>/g, " "))
      });
    }
    rows.push(cells);
  }
  return rows.length > 0 ? rows : [[normalizeCellValue(value)]];
}

function readHtmlSpan(attributes, name) {
  const match = String(attributes ?? "").match(
    new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s>]+))`, "i")
  );
  return match ? Number.parseInt(match[1] ?? match[2] ?? match[3], 10) : 1;
}

function normalizeCellValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function countFormats(tables) {
  const counts = {};
  for (const table of tables) {
    counts[table.format] = (counts[table.format] ?? 0) + 1;
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
  node scripts/qa/check-table-detection.mjs [--id <manifest-id>] [--report <path>]

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
    ...compareTableDetection(expectedMarkdown, result.markdown)
  };
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} tablePrecision=${formatNumber(result.precision)} ` +
      `tableRecall=${formatNumber(result.recall)} expected=${result.expectedTables} actual=${result.actualTables}`
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

  const report = createTableDetectionReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Table detection precision/recall check failed.");
  }
  console.log(
    `Table detection passed: ${results.length} case(s), precision=${formatNumber(
      report.precision
    )}, recall=${formatNumber(report.recall)}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
