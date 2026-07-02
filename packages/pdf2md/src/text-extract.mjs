export function extractTextLines(bytes, { document = null } = {}) {
  const streamTexts = document
    ? document.streams.map((stream) => stream.text)
    : findStreamTextsByScan(bytes);
  const lines = [];

  for (const stream of streamTexts) {
    for (const textBlockMatch of stream.matchAll(/BT([\s\S]*?)ET/g)) {
      const block = textBlockMatch[1];
      const fontSize = readFontSize(block);
      const text = readShownText(block).trim();
      if (text.length > 0) {
        const position = readPosition(block);
        lines.push({
          text,
          fontSize,
          x: position.x,
          y: position.y
        });
      }
    }
  }

  return lines;
}

function findStreamTextsByScan(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  const streamTexts = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const streamMatch of source.matchAll(streamPattern)) {
    streamTexts.push(streamMatch[1]);
  }
  return streamTexts;
}

export function linesToMarkdown(lines) {
  lines = removeRepeatedRunningContent(lines);
  const blocks = [];
  let previousWasList = false;

  for (let index = 0; index < lines.length; index += 1) {
    const table = readTableAt(lines, index);
    if (table) {
      previousWasList = false;
      blocks.push(formatTable(table.rows));
      index = table.endIndex - 1;
      continue;
    }

    const line = lines[index];
    const text = normalizeWhitespace(line.text);
    if (text.length === 0) {
      continue;
    }

    if (line.fontSize >= 20) {
      previousWasList = false;
      blocks.push(`# ${text}`);
      continue;
    }

    if (line.fontSize >= 15) {
      previousWasList = false;
      blocks.push(`## ${text}`);
      continue;
    }

    if (/^[-*]\s+/.test(text)) {
      const item = text.replace(/^[-*]\s+/, "- ");
      if (previousWasList) {
        blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n${item}`;
      } else {
        blocks.push(item);
      }
      previousWasList = true;
      continue;
    }

    previousWasList = false;
    blocks.push(text);
  }

  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

function readFontSize(block) {
  const matches = [...block.matchAll(/\/[A-Za-z0-9]+\s+([-+]?\d*\.?\d+)\s+Tf/g)];
  if (matches.length === 0) {
    return 12;
  }
  return Number.parseFloat(matches[matches.length - 1][1]);
}

function readPosition(block) {
  const matches = [...block.matchAll(/([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+Td/g)];
  if (matches.length === 0) {
    return { x: null, y: null };
  }
  const match = matches[matches.length - 1];
  return {
    x: Number.parseFloat(match[1]),
    y: Number.parseFloat(match[2])
  };
}

function readShownText(block) {
  const parts = [];

  for (const match of block.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    parts.push(decodePdfString(match[1]));
  }

  for (const match of block.matchAll(/\[((?:.|\n)*?)\]\s*TJ/g)) {
    for (const stringMatch of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      parts.push(decodePdfString(stringMatch[1]));
    }
  }

  for (const match of block.matchAll(/\(((?:\\.|[^\\)])*)\)\s*'/g)) {
    parts.push(decodePdfString(match[1]));
  }

  for (const match of block.matchAll(/[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+\(((?:\\.|[^\\)])*)\)\s*"/g)) {
    parts.push(decodePdfString(match[1]));
  }

  return parts.join("");
}

function decodePdfString(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      continue;
    }

    if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    const escapes = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\"
    };
    output += escapes[next] ?? next;
    index += 1;
  }
  return output;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function readTableAt(lines, startIndex) {
  const rows = [];
  let index = startIndex;

  while (index < lines.length) {
    const first = lines[index];
    if (!isTableCellCandidate(first)) {
      break;
    }

    const row = [first];
    let nextIndex = index + 1;
    while (
      nextIndex < lines.length &&
      isTableCellCandidate(lines[nextIndex]) &&
      Math.abs(lines[nextIndex].y - first.y) <= 2
    ) {
      row.push(lines[nextIndex]);
      nextIndex += 1;
    }

    if (row.length < 2) {
      break;
    }

    rows.push(row.sort((left, right) => left.x - right.x));
    index = nextIndex;
  }

  if (rows.length < 2) {
    return null;
  }

  const columnCount = rows[0].length;
  if (!rows.every((row) => row.length === columnCount)) {
    return null;
  }

  return {
    rows,
    endIndex: index
  };
}

function isTableCellCandidate(line) {
  return (
    line.fontSize < 15 &&
    Number.isFinite(line.x) &&
    Number.isFinite(line.y) &&
    !/^[-*]\s+/.test(normalizeWhitespace(line.text))
  );
}

function formatTable(rows) {
  const cells = rows.map((row) => row.map((cell) => normalizeWhitespace(cell.text)));
  const header = cells[0];
  const body = cells.slice(1);
  const alignments = header.map((_, columnIndex) => {
    const values = body.map((row) => row[columnIndex]);
    return values.length > 0 && values.every(isNumericCell) ? "---:" : "---";
  });
  return [
    `| ${header.join(" | ")} |`,
    `| ${alignments.join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function isNumericCell(value) {
  return /^[-+]?\d+(?:\.\d+)?%?$/.test(value);
}

function removeRepeatedRunningContent(lines) {
  const runningCounts = new Map();
  for (const line of lines) {
    if (isRunningContentCandidate(line)) {
      const key = normalizeWhitespace(line.text);
      runningCounts.set(key, (runningCounts.get(key) ?? 0) + 1);
    }
  }

  return lines.filter((line) => {
    if (!isRunningContentCandidate(line)) {
      return true;
    }
    return (runningCounts.get(normalizeWhitespace(line.text)) ?? 0) < 2;
  });
}

function isRunningContentCandidate(line) {
  return line.fontSize <= 10 && Number.isFinite(line.y) && (line.y >= 740 || line.y <= 60);
}
