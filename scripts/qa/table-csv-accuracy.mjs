import { extractMarkdownTableCells } from "./table-span-accuracy.mjs";

export function compareTableCsvCellTextAccuracy(expectedMarkdown, assets) {
  const expectedCells = extractMarkdownTableCells(expectedMarkdown).map(csvComparableCell);
  const actualCells = extractTableCsvCells(assets).map(csvComparableCell);
  const actualCounts = countCells(actualCells);
  const missing = [];
  let matchedCells = 0;

  for (const cell of expectedCells) {
    const count = actualCounts.get(cell.key) ?? 0;
    if (count > 0) {
      matchedCells += 1;
      actualCounts.set(cell.key, count - 1);
    } else {
      missing.push(cell);
    }
  }

  const precision =
    actualCells.length === 0 ? (expectedCells.length === 0 ? 1 : 0) : matchedCells / actualCells.length;
  const recall =
    expectedCells.length === 0 ? (actualCells.length === 0 ? 1 : 0) : matchedCells / expectedCells.length;

  return {
    score: roundNumber(Math.min(precision, recall)),
    precision: roundNumber(precision),
    recall: roundNumber(recall),
    matchedCells,
    expectedCells: expectedCells.length,
    actualCells: actualCells.length,
    csvAssets: tableCsvAssets(assets).length,
    missing: missing.slice(0, 10)
  };
}

export function extractTableCsvCells(assets) {
  return tableCsvAssets(assets).flatMap((asset, assetIndex) => {
    const tableIndex = Number.isInteger(asset.tableIndex) ? asset.tableIndex : assetIndex;
    return parseCsv(asset.content ?? "").flatMap((row, rowIndex) =>
      row.map((text, columnIndex) => ({
        tableIndex,
        rowIndex,
        columnIndex,
        text: normalizeCellText(text)
      }))
    );
  });
}

function tableCsvAssets(assets) {
  return Array.isArray(assets) ? assets.filter((asset) => asset?.kind === "table-csv") : [];
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const source = String(content ?? "");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === "\"" && source[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0 || source.endsWith(",")) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function csvComparableCell(cell) {
  const comparable = {
    tableIndex: cell.tableIndex,
    rowIndex: cell.rowIndex,
    columnIndex: cell.columnIndex,
    text: normalizeCellText(cell.text)
  };
  return {
    ...comparable,
    key: [comparable.tableIndex, comparable.rowIndex, comparable.columnIndex, comparable.text].join(":")
  };
}

function countCells(cells) {
  const counts = new Map();
  for (const cell of cells) {
    counts.set(cell.key, (counts.get(cell.key) ?? 0) + 1);
  }
  return counts;
}

function normalizeCellText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function roundNumber(value) {
  return Number(value.toFixed(3));
}
