import { extractContentStreamTextLines } from "./content-stream.mjs";

export function extractTextLines(bytes, { document = null } = {}) {
  if (document) {
    return documentTextLines(document);
  }

  return findStreamTextsByScan(bytes).flatMap((stream, streamIndex) =>
    extractContentStreamTextLines(stream, { streamIndex })
  );
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

function documentTextLines(document) {
  if (document.pages?.length > 0) {
    return document.pages.flatMap((page) =>
      page.contentStreams.flatMap((stream, streamIndex) =>
        extractContentStreamTextLines(stream.text, {
          pageIndex: page.pageIndex,
          resources: page.resources,
          streamIndex
        })
      )
    );
  }

  return document.streams.flatMap((stream, streamIndex) =>
    extractContentStreamTextLines(stream.text, { streamIndex })
  );
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
    const text = normalizeText(line.text);
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

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return normalizeWhitespace(
    value
      .replace(/\uFB00/g, "ff")
      .replace(/\uFB01/g, "fi")
      .replace(/\uFB02/g, "fl")
      .replace(/\uFB03/g, "ffi")
      .replace(/\uFB04/g, "ffl")
      .replace(/\uFB05/g, "st")
      .replace(/\uFB06/g, "st")
  );
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
