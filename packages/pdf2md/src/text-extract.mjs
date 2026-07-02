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

export function linesToMarkdown(lines, options = {}) {
  lines = removeRepeatedRunningContent(lines);
  const blocks = [];
  let previousWasList = false;
  const anchoredPages = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const table = readTableAt(lines, index);
    if (table) {
      previousWasList = false;
      appendPageAnchor(blocks, table.rows[0][0]?.pageIndex, options, anchoredPages);
      blocks.push(formatTable(table.rows));
      index = table.endIndex - 1;
      continue;
    }

    const line = lines[index];
    const text = normalizeText(line.text);
    if (text.length === 0) {
      continue;
    }

    appendPageAnchor(blocks, line.pageIndex, options, anchoredPages);

    if (line.fontSize >= 20) {
      previousWasList = false;
      blocks.push(`# ${escapeMarkdownInline(text)}`);
      continue;
    }

    if (line.fontSize >= 15) {
      previousWasList = false;
      blocks.push(`## ${escapeMarkdownInline(text)}`);
      continue;
    }

    const listItem = parseListItem(text);
    if (listItem) {
      const item =
        listItem.type === "ordered"
          ? `${listItem.index}. ${escapeMarkdownInline(listItem.text)}`
          : `- ${escapeMarkdownInline(listItem.text)}`;
      if (previousWasList) {
        blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n${item}`;
      } else {
        blocks.push(item);
      }
      previousWasList = true;
      continue;
    }

    previousWasList = false;
    const paragraph = readParagraphAt(lines, index, text);
    blocks.push(escapeMarkdownParagraph(paragraph.text));
    index = paragraph.endIndex - 1;
  }

  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

function appendPageAnchor(blocks, pageIndex, options, anchoredPages) {
  if (!options.pageAnchors || !Number.isInteger(pageIndex) || anchoredPages.has(pageIndex)) {
    return;
  }
  anchoredPages.add(pageIndex);
  blocks.push(`<a id="page-${pageIndex + 1}"></a>`);
}

function parseListItem(text) {
  const unordered = text.match(/^[-*]\s+(.+)$/);
  if (unordered) {
    return {
      type: "unordered",
      text: unordered[1]
    };
  }

  const ordered = text.match(/^(\d+)[.)]\s+(.+)$/);
  if (ordered) {
    return {
      type: "ordered",
      index: Number.parseInt(ordered[1], 10),
      text: ordered[2]
    };
  }

  return null;
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

function escapeMarkdownParagraph(value) {
  return escapeMarkdownInline(value)
    .replace(/^([#>])/, "\\$1")
    .replace(/^([-+])(\s)/, "\\$1$2")
    .replace(/^(\d+)\. /, "$1\\. ");
}

function escapeMarkdownInline(value) {
  return value.replace(/\\/g, "\\\\").replace(/([`*_[\]])/g, "\\$1");
}

function escapeMarkdownTableCell(value) {
  return escapeMarkdownInline(value).replace(/\|/g, "\\|");
}

function readParagraphAt(lines, startIndex, firstText) {
  const parts = [firstText];
  let previous = lines[startIndex];
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index];
    const text = normalizeText(line.text);
    if (
      text.length === 0 ||
      line.fontSize >= 15 ||
      parseListItem(text) ||
      startsWithMarkdownBlockMarker(text) ||
      readTableAt(lines, index) ||
      !isParagraphContinuation(previous, line)
    ) {
      break;
    }

    parts.push(text);
    previous = line;
    index += 1;
  }

  return {
    text: parts.join(" "),
    endIndex: index
  };
}

function startsWithMarkdownBlockMarker(text) {
  return /^([#>]|\d+[.)]\s|[-+]\s)/.test(text);
}

function isParagraphContinuation(previous, next) {
  if (
    !Number.isFinite(previous.x) ||
    !Number.isFinite(previous.y) ||
    !Number.isFinite(next.x) ||
    !Number.isFinite(next.y)
  ) {
    return false;
  }
  if ((previous.pageIndex ?? null) !== (next.pageIndex ?? null)) {
    return false;
  }
  if (Math.abs(previous.x - next.x) > 4 || Math.abs(previous.fontSize - next.fontSize) > 0.5) {
    return false;
  }

  const verticalGap = Math.abs(previous.y - next.y);
  if (verticalGap <= 0 || verticalGap > Math.max(14, previous.fontSize * 1.35)) {
    return false;
  }

  return !/[.!?:;)]$/.test(normalizeText(previous.text));
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
    !parseListItem(normalizeText(line.text))
  );
}

function formatTable(rows) {
  const cells = rows.map((row) => row.map((cell) => normalizeText(cell.text)));
  const header = cells[0];
  const body = cells.slice(1);
  const alignments = header.map((_, columnIndex) => {
    const values = body.map((row) => row[columnIndex]);
    return values.length > 0 && values.every(isNumericCell) ? "---:" : "---";
  });
  return [
    `| ${header.map(escapeMarkdownTableCell).join(" | ")} |`,
    `| ${alignments.join(" | ")} |`,
    ...body.map((row) => `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`)
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
    if (isPageNumberCandidate(line)) {
      return false;
    }
    if (!isRunningContentCandidate(line)) {
      return true;
    }
    return (runningCounts.get(normalizeWhitespace(line.text)) ?? 0) < 2;
  });
}

function isRunningContentCandidate(line) {
  return line.fontSize <= 10 && Number.isFinite(line.y) && (line.y >= 740 || line.y <= 60);
}

function isPageNumberCandidate(line) {
  if (!isRunningContentCandidate(line)) {
    return false;
  }
  return /^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(normalizeWhitespace(line.text));
}
