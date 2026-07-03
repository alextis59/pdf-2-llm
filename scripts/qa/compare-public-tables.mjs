import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";
import { compareTableCellAdjacency } from "./table-adjacency.mjs";
import { compareTableSpanAccuracy } from "./table-span-accuracy.mjs";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());

const publicTableOracles = [
  {
    id: "nist-sp800-63b-4-authenticator-secrets",
    pdfPath: "corpus/raw/public/nist-sp800-63b-4.pdf",
    expectedPath: "corpus/expected/nist-sp800-63b-4-public-table.md",
    tableBlockIndex: 2,
    minTableCellAdjacency: 1,
    minTableSpanAccuracy: 1
  }
];

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

function usage() {
  return `Usage:
  node scripts/qa/compare-public-tables.mjs [--root <repo-root>]
`;
}

export function extractGfmTableBlocks(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isGfmTableStart(lines, index)) {
      continue;
    }

    const tableLines = [lines[index], lines[index + 1]];
    index += 2;
    while (index < lines.length && isPipeTableLine(lines[index])) {
      tableLines.push(lines[index]);
      index += 1;
    }
    blocks.push(tableLines.join("\n"));
    index -= 1;
  }

  return blocks;
}

export async function comparePublicTableOracle(oracle, { root = process.cwd() } = {}) {
  const expected = await readFile(path.join(root, oracle.expectedPath), "utf8");
  const result = await convertPdfToMarkdown(path.join(root, oracle.pdfPath), {
    ocr: { enabled: false }
  });
  const blocks = extractGfmTableBlocks(result.markdown);
  const actual = blocks[oracle.tableBlockIndex] ?? "";
  const errors = [];
  const adjacency = compareTableCellAdjacency(expected, actual);
  const spanAccuracy = compareTableSpanAccuracy(expected, actual);

  if (!actual) {
    errors.push(`missing public table block ${oracle.tableBlockIndex}`);
  }
  if (adjacency.score + Number.EPSILON < oracle.minTableCellAdjacency) {
    errors.push(
      `table cell adjacency ${formatNumber(adjacency.score)} below ${formatNumber(
        oracle.minTableCellAdjacency
      )}`
    );
  }
  if (spanAccuracy.score + Number.EPSILON < oracle.minTableSpanAccuracy) {
    errors.push(
      `table span accuracy ${formatNumber(spanAccuracy.score)} below ${formatNumber(
        oracle.minTableSpanAccuracy
      )}`
    );
  }

  return {
    id: oracle.id,
    passed: errors.length === 0,
    errors,
    tableBlockIndex: oracle.tableBlockIndex,
    tableBlocks: blocks.length,
    minTableCellAdjacency: oracle.minTableCellAdjacency,
    minTableSpanAccuracy: oracle.minTableSpanAccuracy,
    adjacency,
    spanAccuracy
  };
}

function isGfmTableStart(lines, index) {
  return (
    isPipeTableLine(lines[index]) &&
    isPipeTableLine(lines[index + 1]) &&
    /^\|\s*:?-{3,}:?/.test(lines[index + 1].trim())
  );
}

function isPipeTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(String(line ?? ""));
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} tableBlockIndex=${result.tableBlockIndex} tableBlocks=${
      result.tableBlocks
    } tableCellAdjacency=${formatNumber(result.adjacency.score)} min=${formatNumber(
      result.minTableCellAdjacency
    )} matched=${result.adjacency.matchedPairs}/${result.adjacency.expectedPairs} tableSpanAccuracy=${formatNumber(
      result.spanAccuracy.score
    )} min=${formatNumber(result.minTableSpanAccuracy)} matched=${result.spanAccuracy.matchedCells}/${
      result.spanAccuracy.expectedCells
    }`
  );
  for (const error of result.errors) {
    console.error(`  ${error}`);
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "n/a";
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const results = [];
  for (const oracle of publicTableOracles) {
    const result = await comparePublicTableOracle(oracle, { root: repoRoot });
    printResult(result);
    results.push(result);
  }

  if (results.some((result) => !result.passed)) {
    process.exit(1);
  }
  console.log(`Public table comparison passed: ${results.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
