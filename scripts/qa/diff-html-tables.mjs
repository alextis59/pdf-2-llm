import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { renderMarkdownToHtml } from "./render-markdown.mjs";
import { extractHtmlTableCells } from "./table-span-accuracy.mjs";

const args = process.argv.slice(2);

export function diffRenderedHtmlTables(expectedMarkdown, actualMarkdown) {
  return diffHtmlTables(renderMarkdownToHtml(String(expectedMarkdown ?? "")), renderMarkdownToHtml(String(actualMarkdown ?? "")));
}

export function diffHtmlTables(expectedHtml, actualHtml) {
  const expectedTableCount = countHtmlTables(expectedHtml);
  const actualTableCount = countHtmlTables(actualHtml);
  const expectedCells = groupByTable(extractHtmlTableCells(expectedHtml));
  const actualCells = groupByTable(extractHtmlTableCells(actualHtml));
  const differences = [];
  const comparedTables = Math.max(expectedTableCount, actualTableCount);

  for (let tableIndex = 0; tableIndex < comparedTables; tableIndex += 1) {
    const expectedTableCells = expectedCells.get(tableIndex) ?? [];
    const actualTableCells = actualCells.get(tableIndex) ?? [];

    if (tableIndex >= expectedTableCount) {
      differences.push({
        kind: "extra-table",
        tableIndex,
        actualCells: actualTableCells.length
      });
      continue;
    }

    if (tableIndex >= actualTableCount) {
      differences.push({
        kind: "missing-table",
        tableIndex,
        expectedCells: expectedTableCells.length
      });
      continue;
    }

    compareTable(tableIndex, expectedTableCells, actualTableCells, differences);
  }

  return {
    passed: differences.length === 0,
    expectedTables: expectedTableCount,
    actualTables: actualTableCount,
    differences
  };
}

function compareTable(tableIndex, expectedCells, actualCells, differences) {
  const expectedShape = tableShape(expectedCells);
  const actualShape = tableShape(actualCells);

  if (expectedShape.rows !== actualShape.rows) {
    differences.push({
      kind: "row-count",
      tableIndex,
      expected: expectedShape.rows,
      actual: actualShape.rows
    });
  }

  if (expectedShape.columns !== actualShape.columns) {
    differences.push({
      kind: "column-count",
      tableIndex,
      expected: expectedShape.columns,
      actual: actualShape.columns
    });
  }

  const actualByPosition = new Map(actualCells.map((cell) => [positionKey(cell), cell]));
  const expectedByPosition = new Map(expectedCells.map((cell) => [positionKey(cell), cell]));

  for (const expectedCell of expectedCells) {
    const actualCell = actualByPosition.get(positionKey(expectedCell));
    if (!actualCell) {
      differences.push({
        kind: "missing-cell",
        tableIndex,
        rowIndex: expectedCell.rowIndex,
        columnIndex: expectedCell.columnIndex,
        expected: describeCell(expectedCell)
      });
      continue;
    }

    if (expectedCell.text !== actualCell.text) {
      differences.push({
        kind: "cell-text",
        tableIndex,
        rowIndex: expectedCell.rowIndex,
        columnIndex: expectedCell.columnIndex,
        expected: expectedCell.text,
        actual: actualCell.text
      });
    }

    if (expectedCell.rowSpan !== actualCell.rowSpan || expectedCell.columnSpan !== actualCell.columnSpan) {
      differences.push({
        kind: "cell-span",
        tableIndex,
        rowIndex: expectedCell.rowIndex,
        columnIndex: expectedCell.columnIndex,
        expected: {
          rowSpan: expectedCell.rowSpan,
          columnSpan: expectedCell.columnSpan
        },
        actual: {
          rowSpan: actualCell.rowSpan,
          columnSpan: actualCell.columnSpan
        }
      });
    }
  }

  for (const actualCell of actualCells) {
    if (!expectedByPosition.has(positionKey(actualCell))) {
      differences.push({
        kind: "extra-cell",
        tableIndex,
        rowIndex: actualCell.rowIndex,
        columnIndex: actualCell.columnIndex,
        actual: describeCell(actualCell)
      });
    }
  }
}

function tableShape(cells) {
  return cells.reduce(
    (shape, cell) => ({
      rows: Math.max(shape.rows, cell.rowIndex + cell.rowSpan),
      columns: Math.max(shape.columns, cell.columnIndex + cell.columnSpan)
    }),
    { rows: 0, columns: 0 }
  );
}

function groupByTable(cells) {
  const grouped = new Map();
  for (const cell of cells) {
    if (!grouped.has(cell.tableIndex)) {
      grouped.set(cell.tableIndex, []);
    }
    grouped.get(cell.tableIndex).push(cell);
  }
  return grouped;
}

function positionKey(cell) {
  return `${cell.rowIndex}:${cell.columnIndex}`;
}

function describeCell(cell) {
  return {
    text: cell.text,
    rowSpan: cell.rowSpan,
    columnSpan: cell.columnSpan
  };
}

function countHtmlTables(html) {
  return [...String(html ?? "").matchAll(/<table\b[\s\S]*?<\/table>/gi)].length;
}

function positionalArgs() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function usage() {
  return `Usage:
  node scripts/qa/diff-html-tables.mjs <expected.md> <actual.md>
`;
}

async function readMarkdown(filePath) {
  return readFile(path.resolve(filePath), "utf8");
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const [expectedPath, actualPath] = positionalArgs();
  if (!expectedPath || !actualPath) {
    console.error(usage());
    process.exit(1);
  }

  const [expectedMarkdown, actualMarkdown] = await Promise.all([
    readMarkdown(expectedPath),
    readMarkdown(actualPath)
  ]);
  const diff = diffRenderedHtmlTables(expectedMarkdown, actualMarkdown);

  if (!diff.passed) {
    console.error("Rendered HTML tables differ.");
    console.error(JSON.stringify(diff, null, 2));
    process.exit(1);
  }

  console.log("Rendered HTML tables match.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
