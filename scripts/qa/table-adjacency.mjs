export function compareTableCellAdjacency(expectedMarkdown, actualMarkdown) {
  const expectedTables = extractGfmTables(expectedMarkdown);
  const actualTables = extractGfmTables(actualMarkdown);
  const expectedPairs = expectedTables.flatMap((table, index) => tableAdjacencyPairs(table, index));
  const actualPairs = actualTables.flatMap((table, index) => tableAdjacencyPairs(table, index));
  const actualCounts = countPairs(actualPairs);
  const missing = [];
  let matchedPairs = 0;

  for (const pair of expectedPairs) {
    const count = actualCounts.get(pair.key) ?? 0;
    if (count > 0) {
      matchedPairs += 1;
      actualCounts.set(pair.key, count - 1);
    } else {
      missing.push(pair);
    }
  }

  return {
    score:
      expectedPairs.length === 0
        ? actualPairs.length === 0
          ? 1
          : 0
        : roundNumber(matchedPairs / expectedPairs.length),
    matchedPairs,
    expectedPairs: expectedPairs.length,
    actualPairs: actualPairs.length,
    expectedTables: expectedTables.length,
    actualTables: actualTables.length,
    missing: missing.slice(0, 10)
  };
}

export function extractGfmTables(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const tables = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isGfmTableRow(lines[index]) || !isGfmSeparatorRow(lines[index + 1])) {
      continue;
    }

    const rows = [splitGfmTableRow(lines[index])];
    let cursor = index + 2;
    while (cursor < lines.length && isGfmTableRow(lines[cursor])) {
      rows.push(splitGfmTableRow(lines[cursor]));
      cursor += 1;
    }
    tables.push(rows);
    index = cursor - 1;
  }

  return tables;
}

function tableAdjacencyPairs(rows, tableIndex) {
  const pairs = [];
  const normalizedRows = rows.map((row) => row.map(normalizeCellText));
  const maxColumns = Math.max(0, ...normalizedRows.map((row) => row.length));

  for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex += 1) {
    const row = normalizedRows[rowIndex];
    for (let columnIndex = 0; columnIndex < row.length - 1; columnIndex += 1) {
      addPair(pairs, {
        direction: "right",
        tableIndex,
        rowIndex,
        columnIndex,
        from: row[columnIndex],
        to: row[columnIndex + 1]
      });
    }
  }

  for (let rowIndex = 0; rowIndex < normalizedRows.length - 1; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
      addPair(pairs, {
        direction: "down",
        tableIndex,
        rowIndex,
        columnIndex,
        from: normalizedRows[rowIndex][columnIndex],
        to: normalizedRows[rowIndex + 1][columnIndex]
      });
    }
  }

  return pairs;
}

function addPair(pairs, pair) {
  if (!pair.from || !pair.to) {
    return;
  }
  pairs.push({
    ...pair,
    key: `${pair.direction}:${pair.from}=>${pair.to}`
  });
}

function countPairs(pairs) {
  const counts = new Map();
  for (const pair of pairs) {
    counts.set(pair.key, (counts.get(pair.key) ?? 0) + 1);
  }
  return counts;
}

function isGfmTableRow(line) {
  return /\|/.test(String(line ?? "").trim());
}

function isGfmSeparatorRow(line) {
  const cells = splitGfmTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitGfmTableRow(line) {
  let text = String(line ?? "").trim();
  if (text.startsWith("|")) {
    text = text.slice(1);
  }
  if (text.endsWith("|")) {
    text = text.slice(0, -1);
  }

  const cells = [];
  let cell = "";
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(normalizeCellText(cell));
      cell = "";
      continue;
    }
    cell += char;
  }
  if (escaped) {
    cell += "\\";
  }
  cells.push(normalizeCellText(cell));
  return cells;
}

function normalizeCellText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function roundNumber(value) {
  return Number(value.toFixed(3));
}
