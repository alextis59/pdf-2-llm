import { extractGfmTables } from "./table-adjacency.mjs";

export function compareTableSpanAccuracy(expectedMarkdown, actualMarkdown) {
  const expectedCells = extractMarkdownTableCells(expectedMarkdown);
  const actualCells = extractMarkdownTableCells(actualMarkdown);
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
    expectedTables: tableCount(expectedCells),
    actualTables: tableCount(actualCells),
    missing: missing.slice(0, 10)
  };
}

export function extractMarkdownTableCells(markdown) {
  const source = String(markdown ?? "");
  const htmlTables = extractHtmlTables(source);
  const htmlCells = htmlTables.flatMap((table, index) => parseHtmlTableCells(table, index));
  const markdownWithoutHtmlTables = source.replace(/<table\b[\s\S]*?<\/table>/gi, "");
  const gfmCells = extractGfmTables(markdownWithoutHtmlTables).flatMap((rows, index) =>
    gfmTableCells(rows, htmlTables.length + index)
  );
  return [...htmlCells, ...gfmCells].map((cell) => ({
    ...cell,
    key: cellKey(cell)
  }));
}

function extractHtmlTables(markdown) {
  return [...markdown.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((match) => match[0]);
}

function parseHtmlTableCells(tableHtml, tableIndex) {
  const cells = [];
  const occupied = new Set();
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    let columnIndex = 0;
    const rowHtml = rows[rowIndex][1];
    const cellMatches = [...rowHtml.matchAll(/<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)];

    for (const match of cellMatches) {
      while (occupied.has(positionKey(rowIndex, columnIndex))) {
        columnIndex += 1;
      }

      const rowSpan = readSpan(match[1], "rowspan");
      const columnSpan = readSpan(match[1], "colspan");
      const cell = {
        tableIndex,
        rowIndex,
        columnIndex,
        text: normalizeCellText(stripTags(match[2])),
        rowSpan,
        columnSpan
      };
      cells.push(cell);
      markOccupied(occupied, cell);
      columnIndex += columnSpan;
    }
  }

  return cells;
}

function gfmTableCells(rows, tableIndex) {
  const cells = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < rows[rowIndex].length; columnIndex += 1) {
      cells.push({
        tableIndex,
        rowIndex,
        columnIndex,
        text: normalizeCellText(rows[rowIndex][columnIndex]),
        rowSpan: 1,
        columnSpan: 1
      });
    }
  }
  return cells;
}

function readSpan(attributes, name) {
  const match = String(attributes ?? "").match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"));
  if (!match) {
    return 1;
  }
  return Math.max(1, Number.parseInt(match[1], 10));
}

function markOccupied(occupied, cell) {
  for (let rowIndex = cell.rowIndex; rowIndex < cell.rowIndex + cell.rowSpan; rowIndex += 1) {
    for (
      let columnIndex = cell.columnIndex;
      columnIndex < cell.columnIndex + cell.columnSpan;
      columnIndex += 1
    ) {
      occupied.add(positionKey(rowIndex, columnIndex));
    }
  }
}

function positionKey(rowIndex, columnIndex) {
  return `${rowIndex}:${columnIndex}`;
}

function cellKey(cell) {
  return [
    cell.tableIndex,
    cell.rowIndex,
    cell.columnIndex,
    cell.text,
    cell.rowSpan,
    cell.columnSpan
  ].join(":");
}

function countCells(cells) {
  const counts = new Map();
  for (const cell of cells) {
    counts.set(cell.key, (counts.get(cell.key) ?? 0) + 1);
  }
  return counts;
}

function tableCount(cells) {
  return new Set(cells.map((cell) => cell.tableIndex)).size;
}

function stripTags(value) {
  return decodeHtmlEntities(String(value ?? "").replace(/<[^>]*>/g, ""));
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeCellText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function roundNumber(value) {
  return Number(value.toFixed(3));
}
