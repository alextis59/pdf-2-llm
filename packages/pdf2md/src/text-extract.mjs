import {
  extractContentStreamRulingLines,
  extractContentStreamTextLines,
  mergeRulingLines
} from "./content-stream.mjs";

const linkPattern = /(https?:\/\/[^\s<>()\[\]{}]+|www\.[^\s<>()\[\]{}]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

export function extractTextLines(bytes, { document = null } = {}) {
  if (document) {
    return documentTextLines(document);
  }

  return findStreamTextsByScan(bytes).flatMap((stream, streamIndex) =>
    extractContentStreamTextLines(stream, { streamIndex })
  );
}

export function extractRulingLines(bytes, { document = null } = {}) {
  if (document) {
    return documentRulingLines(document);
  }

  return mergeRulingLines(
    findStreamTextsByScan(bytes).flatMap((stream, streamIndex) =>
      extractContentStreamRulingLines(stream, { streamIndex })
    )
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
    const structureByPage = structureSignalsByPage(document.structure);
    return document.pages.flatMap((page) =>
      page.contentStreams.flatMap((stream, streamIndex) =>
        extractContentStreamTextLines(stream.text, {
          pageIndex: page.pageIndex,
          resources: page.resources,
          streamIndex,
          structureByMcid: structureByPage.get(page.pageIndex) ?? new Map()
        })
      )
    );
  }

  return document.streams.flatMap((stream, streamIndex) =>
    extractContentStreamTextLines(stream.text, { streamIndex })
  );
}

function documentRulingLines(document) {
  if (document.pages?.length > 0) {
    return mergeRulingLines(
      document.pages.flatMap((page) =>
        page.contentStreams.flatMap((stream, streamIndex) =>
          extractContentStreamRulingLines(stream.text, {
            pageIndex: page.pageIndex,
            streamIndex
          })
        )
      )
    );
  }

  return mergeRulingLines(
    document.streams.flatMap((stream, streamIndex) =>
      extractContentStreamRulingLines(stream.text, { streamIndex })
    )
  );
}

function structureSignalsByPage(structure) {
  const byPage = new Map();
  for (const item of structure?.markedContent ?? []) {
    if (!Number.isInteger(item.pageIndex) || !Number.isInteger(item.mcid)) {
      continue;
    }
    const pageSignals = byPage.get(item.pageIndex) ?? new Map();
    pageSignals.set(item.mcid, item);
    byPage.set(item.pageIndex, pageSignals);
  }
  return byPage;
}

export function linesToMarkdown(lines, options = {}) {
  return linesToMarkdownWithSourceMap(lines, options).markdown;
}

export function linesToMarkdownWithSourceMap(lines, options = {}) {
  const pageNumberRegions = pageNumberRegionsByPage(lines);
  lines = removeRepeatedRunningContent(lines, {
    preserveRunningTitles: options.preserveRunningTitles === true
  });
  const layout = analyzeLineLayout(lines, { pageNumberRegions });
  lines = orderLinesForReading(lines);
  const headingModel = createHeadingModel(lines, {
    outlines: options.outlines ?? []
  });
  const taggedStructureConflicts = taggedStructureConflictsForLines(lines, headingModel);
  const listIndentModel = createListIndentModel(lines);
  const codeModel = createCodeModel(lines);
  const rulingTableExports = createRulingTableExports(lines, options.rulingTables ?? []);
  const blocks = [];
  let previousWasList = false;
  const anchoredPages = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const rulingTable = readRulingTableAt(index, rulingTableExports);
    if (rulingTable) {
      previousWasList = false;
      appendPageAnchor(blocks, rulingTable.pageIndex, options, anchoredPages);
      blocks.push(
        createMarkdownBlock(rulingTable.markdown, "table", rulingTable.sourceLines)
      );
      index = rulingTable.endIndex - 1;
      continue;
    }

    const table = readTableAt(lines, index);
    if (table) {
      previousWasList = false;
      appendPageAnchor(blocks, table.rows[0][0]?.pageIndex, options, anchoredPages);
      blocks.push(createMarkdownBlock(formatTable(table.rows), "table", table.rows.flat()));
      index = table.endIndex - 1;
      continue;
    }

    const line = lines[index];
    const text = normalizeText(line.text);
    if (text.length === 0) {
      continue;
    }

    appendPageAnchor(blocks, line.pageIndex, options, anchoredPages);

    const codeBlock = readCodeBlockAt(
      lines,
      index,
      headingModel,
      codeModel,
      rulingTableExports
    );
    if (codeBlock) {
      previousWasList = false;
      blocks.push(createMarkdownBlock(formatCodeBlock(codeBlock.sourceLines), "code", codeBlock.sourceLines));
      index = codeBlock.endIndex - 1;
      continue;
    }

    const headingLevel = headingLevelForLine(line, headingModel);
    if (headingLevel !== null) {
      previousWasList = false;
      blocks.push(
        createMarkdownBlock(
          `${"#".repeat(headingLevel)} ${escapeMarkdownInline(text)}`,
          "heading",
          [line]
        )
      );
      continue;
    }

    const listItem = parseListItem(text);
    if (listItem) {
      const item = formatListItem(
        listItem,
        listIndentLevelForLine(line, listIndentModel)
      );
      if (previousWasList) {
        const listBlock = blocks[blocks.length - 1];
        listBlock.text = `${listBlock.text}\n${item}`;
        listBlock.sourceLines.push(line);
      } else {
        blocks.push(createMarkdownBlock(item, "list", [line]));
      }
      previousWasList = true;
      continue;
    }

    previousWasList = false;
    const paragraph = readParagraphAt(lines, index, text, headingModel, rulingTableExports);
    blocks.push(
      createMarkdownBlock(escapeMarkdownParagraph(paragraph.text), "paragraph", paragraph.sourceLines)
    );
    index = paragraph.endIndex - 1;
  }

  return {
    ...serializeMarkdownBlocks(blocks),
    layout,
    taggedStructureConflicts
  };
}

function appendPageAnchor(blocks, pageIndex, options, anchoredPages) {
  if (!options.pageAnchors || !Number.isInteger(pageIndex) || anchoredPages.has(pageIndex)) {
    return;
  }
  anchoredPages.add(pageIndex);
  blocks.push(
    createMarkdownBlock(`<a id="page-${pageIndex + 1}"></a>`, "page_anchor", [
      { pageIndex }
    ])
  );
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

function formatListItem(listItem, indentLevel) {
  const indent = "  ".repeat(indentLevel);
  const marker = listItem.type === "ordered" ? `${listItem.index}.` : "-";
  return `${indent}${marker} ${escapeMarkdownInline(listItem.text)}`;
}

function createListIndentModel(lines) {
  const positions = [];
  for (const line of lines) {
    if (Number.isFinite(line.x) && parseListItem(normalizeText(line.text ?? ""))) {
      positions.push(line.x);
    }
  }

  return {
    stops: clusterPositions(positions, 12)
  };
}

function clusterPositions(positions, tolerance) {
  const clusters = [];
  for (const position of [...positions].sort((left, right) => left - right)) {
    const cluster = clusters.find((item) => Math.abs(item.center - position) <= tolerance);
    if (cluster) {
      cluster.positions.push(position);
      cluster.center = average(cluster.positions);
      continue;
    }
    clusters.push({
      center: position,
      positions: [position]
    });
  }
  return clusters.map((cluster) => cluster.center);
}

function listIndentLevelForLine(line, listIndentModel) {
  if (!Number.isFinite(line.x) || listIndentModel.stops.length === 0) {
    return 0;
  }

  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < listIndentModel.stops.length; index += 1) {
    const distance = Math.abs(line.x - listIndentModel.stops[index]);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function createCodeModel(lines) {
  const positions = lines
    .filter((line) => normalizeText(line.text ?? "").length > 0)
    .map((line) => line.x)
    .filter(Number.isFinite);
  return {
    bodyLeft: positions.length > 0 ? Math.min(...positions) : 0
  };
}

function readCodeBlockAt(lines, startIndex, headingModel, codeModel, rulingTableExports = new Map()) {
  const sourceLines = [];
  let hasMonospace = false;
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const text = normalizeText(line.text ?? "");
    if (
      text.length === 0 ||
      parseListItem(text) ||
      headingLevelForLine(line, headingModel) !== null ||
      readRulingTableAt(index, rulingTableExports) ||
      readTableAt(lines, index)
    ) {
      break;
    }

    const kind = codeLineKind(line, codeModel);
    if (!kind) {
      break;
    }
    if (
      sourceLines.length > 0 &&
      !isCodeBlockContinuation(sourceLines[sourceLines.length - 1], line)
    ) {
      break;
    }
    hasMonospace ||= kind === "monospace";
    sourceLines.push(line);
    index += 1;
  }

  if (sourceLines.length === 0 || (!hasMonospace && sourceLines.length < 2)) {
    return null;
  }

  return {
    sourceLines,
    endIndex: index
  };
}

function codeLineKind(line, codeModel) {
  if (isMonospaceLine(line)) {
    return "monospace";
  }
  if (
    Number.isFinite(line.x) &&
    line.x >= codeModel.bodyLeft + 32 &&
    isCodeLikeText(normalizeText(line.text ?? ""))
  ) {
    return "indented";
  }
  return null;
}

function isCodeBlockContinuation(previous, next) {
  if ((previous.pageIndex ?? null) !== (next.pageIndex ?? null)) {
    return false;
  }
  if (!Number.isFinite(previous.y) || !Number.isFinite(next.y)) {
    return true;
  }
  const verticalGap = Math.abs(previous.y - next.y);
  return verticalGap <= Math.max(24, (previous.fontSize ?? 12) * 2);
}

function isMonospaceLine(line) {
  return [line.fontName, line.font?.baseFont, line.font?.name]
    .filter(Boolean)
    .some((name) => /courier|mono|consolas|menlo|monaco|typewriter/i.test(name));
}

function isCodeLikeText(text) {
  return (
    /[{}();=<>]/.test(text) ||
    /^(?:const|let|var|function|class|if|else|for|while|return|import|export)\b/.test(text)
  );
}

function formatCodeBlock(lines) {
  const fence = lines.some((line) => normalizeText(line.text ?? "").includes("```")) ? "~~~" : "```";
  const positions = lines.map((line) => line.x).filter(Number.isFinite);
  const left = positions.length > 0 ? Math.min(...positions) : 0;
  return [
    fence,
    ...lines.map((line) => `${codeIndent(line, left)}${normalizeText(line.text ?? "")}`),
    fence
  ].join("\n");
}

function codeIndent(line, left) {
  if (!Number.isFinite(line.x) || !Number.isFinite(left)) {
    return "";
  }
  return " ".repeat(Math.max(0, Math.round((line.x - left) / 12)));
}

function createHeadingModel(lines, { outlines = [] } = {}) {
  const bodyFontSize = dominantFontSize(lines);
  const fontSizes = uniqueSortedFontSizes(lines);
  const minimumHeadingSize = Math.max(15, bodyFontSize + 2);
  let headingSizes = fontSizes.filter((fontSize) => fontSize >= minimumHeadingSize);
  if (headingSizes.length === 0 && fontSizes.length === 1 && fontSizes[0] >= 15) {
    headingSizes = [fontSizes[0]];
  }
  headingSizes = headingSizes.slice(0, 6);
  const levelByFontSize = new Map(
    headingSizes.map((fontSize, index) => [fontSize, index + 1])
  );
  return {
    bodyFontSize,
    levelByFontSize,
    outlineLevelByTitle: outlineLevelByTitle(outlines)
  };
}

function outlineLevelByTitle(outlines) {
  const levels = new Map();
  for (const outline of outlines) {
    const title = normalizeText(outline?.title ?? "");
    if (!title || levels.has(title)) {
      continue;
    }
    const depth = Number.isInteger(outline.depth) ? outline.depth : 1;
    levels.set(title, Math.min(Math.max(depth, 1), 6));
  }
  return levels;
}

function dominantFontSize(lines) {
  const counts = new Map();
  for (const line of lines) {
    const fontSize = roundedFontSize(line.fontSize);
    if (!Number.isFinite(fontSize) || normalizeText(line.text ?? "").length === 0) {
      continue;
    }
    counts.set(fontSize, (counts.get(fontSize) ?? 0) + 1);
  }

  let bestSize = 12;
  let bestCount = 0;
  for (const [fontSize, count] of counts) {
    if (count > bestCount || (count === bestCount && fontSize < bestSize)) {
      bestSize = fontSize;
      bestCount = count;
    }
  }
  return bestSize;
}

function uniqueSortedFontSizes(lines) {
  return [...new Set(lines.map((line) => roundedFontSize(line.fontSize)).filter(Number.isFinite))]
    .sort((left, right) => right - left);
}

function headingLevelForLine(line, headingModel) {
  const taggedLevel = taggedHeadingLevelForLine(line, headingModel);
  if (taggedLevel !== null) {
    return taggedLevel;
  }
  const outlineLevel = headingModel.outlineLevelByTitle.get(normalizeText(line.text ?? ""));
  if (outlineLevel) {
    return outlineLevel;
  }
  return headingModel.levelByFontSize.get(roundedFontSize(line.fontSize)) ?? null;
}

function taggedHeadingLevelForLine(line, headingModel) {
  const match = String(line.structureRole ?? "").match(/^H([1-6])$/);
  if (!match) {
    return null;
  }
  if (taggedHeadingConflictReason(line, headingModel) !== null) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function taggedStructureConflictsForLines(lines, headingModel) {
  return lines
    .map((line) => taggedStructureConflictForLine(line, headingModel))
    .filter(Boolean);
}

function taggedStructureConflictForLine(line, headingModel) {
  const role = String(line.structureRole ?? "");
  if (!/^H[1-6]$/.test(role)) {
    return null;
  }
  const reason = taggedHeadingConflictReason(line, headingModel);
  if (reason === null || reason === "empty-text") {
    return null;
  }
  return {
    reason,
    role,
    text: truncateDiagnosticText(normalizeText(line.text ?? "")),
    pageIndex: Number.isInteger(line.pageIndex) ? line.pageIndex : null,
    markedContentId: Number.isInteger(line.markedContentId) ? line.markedContentId : null,
    fontSize: numberOrNull(roundedFontSize(line.fontSize)),
    bodyFontSize: numberOrNull(headingModel.bodyFontSize),
    x: numberOrNull(line.x),
    y: numberOrNull(line.y)
  };
}

function taggedHeadingConflictReason(line, headingModel) {
  const text = normalizeText(line.text ?? "");
  if (!text || text.length > 160) {
    return text ? "heading-text-too-long" : "empty-text";
  }
  const fontSize = roundedFontSize(line.fontSize);
  if (Number.isFinite(fontSize) && fontSize < headingModel.bodyFontSize * 0.85) {
    return "font-size-below-body";
  }
  return null;
}

function truncateDiagnosticText(value) {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function roundedFontSize(fontSize) {
  return Number.isFinite(fontSize) ? Math.round(fontSize * 2) / 2 : Number.NaN;
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
  let result = "";
  let offset = 0;
  for (const match of value.matchAll(linkPattern)) {
    result += escapeMarkdownText(value.slice(offset, match.index));
    const { target, trailing } = splitLinkTrailingPunctuation(match[0]);
    result += formatAutolink(target);
    result += escapeMarkdownText(trailing);
    offset = match.index + match[0].length;
  }
  result += escapeMarkdownText(value.slice(offset));
  return result;
}

function escapeMarkdownText(value) {
  return value.replace(/\\/g, "\\\\").replace(/([`*_[\]])/g, "\\$1");
}

function splitLinkTrailingPunctuation(value) {
  const match = value.match(/^(.+?)([.,;:!?]+)?$/);
  return {
    target: match?.[1] ?? value,
    trailing: match?.[2] ?? ""
  };
}

function formatAutolink(target) {
  if (/^www\./i.test(target)) {
    return `<https://${target}>`;
  }
  return `<${target}>`;
}

function escapeMarkdownTableCell(value) {
  return escapeMarkdownInline(value).replace(/\|/g, "\\|");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readParagraphAt(lines, startIndex, firstText, headingModel, rulingTableExports = new Map()) {
  const parts = [firstText];
  let previous = lines[startIndex];
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index];
    const text = normalizeText(line.text);
    if (
      text.length === 0 ||
      headingLevelForLine(line, headingModel) !== null ||
      parseListItem(text) ||
      startsWithMarkdownBlockMarker(text) ||
      readRulingTableAt(index, rulingTableExports) ||
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
    sourceLines: lines.slice(startIndex, index),
    endIndex: index
  };
}

function orderLinesForReading(lines) {
  return groupLinesByPage(lines).flatMap(orderPageLinesForReading);
}

function analyzeLineLayout(lines, { pageNumberRegions = new Map() } = {}) {
  return {
    pages: groupLinesByPage(lines).map((pageGroup) =>
      classifyPageLayout(pageGroup, {
        pageNumbers: pageNumberRegions.get(pageGroupKey(pageGroup)) ?? []
      })
    )
  };
}

function groupLinesByPage(lines) {
  const pageGroups = [];
  const pageIndexes = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = Number.isInteger(line.pageIndex) ? `page:${line.pageIndex}` : "page:unknown";
    let pageGroupIndex = pageIndexes.get(key);
    if (pageGroupIndex === undefined) {
      pageGroupIndex = pageGroups.length;
      pageIndexes.set(key, pageGroupIndex);
      pageGroups.push([]);
    }
    pageGroups[pageGroupIndex].push({ line, index });
  }

  return pageGroups;
}

function classifyPageLayout(indexedLines, { pageNumbers = [] } = {}) {
  const pageIndex = pageIndexForGroup(indexedLines);
  if (indexedLines.length === 0 || !indexedLines.every((item) => hasLineGeometry(item.line))) {
    return {
      pageIndex,
      kind: "unknown",
      rows: 0,
      blocks: 0,
      columns: [],
      sidebars: [],
      callouts: [],
      footnotes: [],
      captions: [],
      pageNumbers
    };
  }

  const rows = groupLinesIntoRows(indexedLines);
  const columns = detectReadingColumns(rows);
  const blocks = segmentRowsIntoReadingBlocks(rows);
  const spanningRows = columns.length >= 2 ? rows.filter((row) => rowSpansColumns(row, columns)) : [];
  const regions = detectLayoutRegions(rows, columns);
  return {
    pageIndex,
    kind: layoutKindFor(columns, spanningRows),
    rows: rows.length,
    blocks: blocks.length,
    columns: columns.map((column, index) => ({
      index,
      x: roundNumber(column.center),
      rows: column.rows.length
    })),
    sidebars: regions.sidebars,
    callouts: regions.callouts,
    footnotes: regions.footnotes,
    captions: regions.captions,
    pageNumbers
  };
}

function pageIndexForGroup(indexedLines) {
  const line = indexedLines.find((item) => Number.isInteger(item.line.pageIndex))?.line;
  return Number.isInteger(line?.pageIndex) ? line.pageIndex : null;
}

function pageGroupKey(indexedLines) {
  const line = indexedLines.find((item) => Number.isInteger(item.line.pageIndex))?.line;
  return line ? pageKey(line) : "page:unknown";
}

function pageKey(line) {
  return Number.isInteger(line.pageIndex) ? `page:${line.pageIndex}` : "page:unknown";
}

function pageNumberRegionsByPage(lines) {
  const regions = new Map();
  for (const line of lines) {
    if (!isPageNumberCandidate(line)) {
      continue;
    }
    const key = pageKey(line);
    const pageRegions = regions.get(key) ?? [];
    pageRegions.push(lineRegion("page-number", line));
    regions.set(key, pageRegions);
  }
  return regions;
}

function lineRegion(kind, line) {
  return {
    kind,
    x: roundNumber(finiteOr(line.x, 0)),
    y: roundNumber(finiteOr(line.y, 0)),
    width: roundNumber(Math.max(1, finiteOr(line.width, 1))),
    height: roundNumber(Math.max(1, finiteOr(line.height, line.fontSize ?? 10))),
    rows: 1
  };
}

function rowSpansColumns(row, columns) {
  const firstColumn = columns[0];
  const lastColumn = columns[columns.length - 1];
  return row.x <= firstColumn.center + 24 && row.right >= lastColumn.center - 24;
}

function layoutKindFor(columns, spanningRows) {
  if (columns.length < 2) {
    return "single-column";
  }
  return spanningRows.length > 0 ? "mixed" : "multi-column";
}

function detectLayoutRegions(rows, columns) {
  return {
    sidebars: detectSidebarRegions(columns),
    callouts: rows.filter(isCalloutRow).map((row) => createRegion("callout", [row])),
    footnotes: rows.filter(isFootnoteRow).map((row) => createRegion("footnote", [row])),
    captions: rows
      .map((row) => ({ row, target: captionTarget(row) }))
      .filter((item) => item.target !== null)
      .map(({ row, target }) => createRegion("caption", [row], { target }))
  };
}

function detectSidebarRegions(columns) {
  if (columns.length < 2) {
    return [];
  }

  const dominant = columns.reduce((best, column) =>
    column.rows.length > best.rows.length ? column : best
  );
  return columns
    .map((column, columnIndex) => ({ column, columnIndex }))
    .filter(({ column }) => column !== dominant && column.rows.length <= dominant.rows.length * 0.45)
    .map(({ column, columnIndex }) => createRegion("sidebar", column.rows, { columnIndex }));
}

function isCalloutRow(row) {
  return /^(?:note|tip|warning|important|caution):\s+/i.test(rowText(row));
}

function isFootnoteRow(row) {
  return row.y <= 160 && row.fontSize <= 10 && /^(?:\d+|[a-z])[\.)]\s+/.test(rowText(row));
}

function captionTarget(row) {
  const text = rowText(row);
  if (/^(?:figure|fig\.?)\s+\d+[\.:]\s+/i.test(text)) {
    return "figure";
  }
  if (/^table\s+\d+[\.:]\s+/i.test(text)) {
    return "table";
  }
  return null;
}

function createRegion(kind, rows, extra = {}) {
  const left = Math.min(...rows.map((row) => row.x));
  const right = Math.max(...rows.map((row) => row.right));
  const top = Math.max(...rows.map((row) => row.y));
  const bottom = Math.min(...rows.map((row) => row.y - Math.max(1, row.fontSize)));
  return {
    kind,
    x: roundNumber(left),
    y: roundNumber(top),
    width: roundNumber(right - left),
    height: roundNumber(top - bottom),
    rows: rows.length,
    ...extra
  };
}

function rowText(row) {
  return row.items.map((item) => normalizeText(item.line.text ?? "")).join(" ");
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function orderPageLinesForReading(indexedLines) {
  if (!indexedLines.every((item) => hasLineGeometry(item.line))) {
    return indexedLines.map((item) => item.line);
  }

  const rows = groupLinesIntoRows(indexedLines);
  const blocks = segmentRowsIntoReadingBlocks(rows);
  return blocks.flatMap((block) => block.rows.flatMap((row) => row.items.map((item) => item.line)));
}

function hasLineGeometry(line) {
  return Number.isFinite(line.x) && Number.isFinite(line.y);
}

function groupLinesIntoRows(indexedLines) {
  const rows = [];
  const sorted = [...indexedLines].sort(
    (left, right) =>
      right.line.y - left.line.y ||
      left.line.x - right.line.x ||
      left.index - right.index
  );

  for (const item of sorted) {
    const tolerance = lineRowTolerance(item.line);
    const current = rows[rows.length - 1];
    if (current && Math.abs(current.y - item.line.y) <= Math.max(current.tolerance, tolerance)) {
      current.items.push(item);
      current.y = average(current.items.map((rowItem) => rowItem.line.y));
      current.tolerance = Math.max(current.tolerance, tolerance);
      continue;
    }

    rows.push({
      items: [item],
      y: item.line.y,
      tolerance
    });
  }

  return rows.flatMap(createReadingRows);
}

function createReadingRows(row) {
  const items = sortRowItems(row.items);
  if (items.length <= 1 || isLikelyTabularRowItems(items)) {
    return [createReadingRow(items)];
  }

  return items.map((item) => createReadingRow([item]));
}

function createReadingRow(items) {
  items = sortRowItems(items);
  const left = Math.min(...items.map((item) => item.line.x));
  const right = Math.max(...items.map((item) => lineRightEdge(item.line)));
  return {
    items,
    x: left,
    y: average(items.map((item) => item.line.y)),
    right,
    width: right - left,
    fontSize: Math.max(...items.map((item) => item.line.fontSize ?? 0))
  };
}

function sortRowItems(items) {
  return [...items].sort(
    (left, right) =>
      left.line.x - right.line.x ||
      left.line.y - right.line.y ||
      left.index - right.index
  );
}

function isLikelyTabularRowItems(items) {
  if (items.length < 2) {
    return false;
  }

  const texts = items.map((item) => normalizeText(item.line.text ?? ""));
  if (texts.some(isNumericCell)) {
    return true;
  }

  return texts.every((text) => text.length <= 24 && !/[.!?:;]$/.test(text));
}

function lineRightEdge(line) {
  if (Number.isFinite(line.width) && line.width > 0) {
    return line.x + line.width;
  }
  const estimatedGlyphWidth = Math.max(4, line.fontSize ?? 10) * 0.5;
  return line.x + Math.max(1, normalizeText(line.text ?? "").length * estimatedGlyphWidth);
}

function lineRowTolerance(line) {
  return Math.max(2, (line.fontSize ?? 10) * 0.25);
}

function segmentRowsIntoReadingBlocks(rows) {
  const columns = detectReadingColumns(rows);
  if (columns.length < 2) {
    return [
      {
        columnIndex: 0,
        rows
      }
    ];
  }

  const blocks = [];
  let pendingColumnRows = [];
  for (const row of [...rows].sort(compareRowsTopDown)) {
    if (rowSpansColumns(row, columns)) {
      appendColumnBlocks(blocks, pendingColumnRows, columns);
      pendingColumnRows = [];
      blocks.push({
        columnIndex: null,
        rows: [row]
      });
      continue;
    }
    pendingColumnRows.push(row);
  }
  appendColumnBlocks(blocks, pendingColumnRows, columns);
  return blocks;
}

function appendColumnBlocks(blocks, rows, columns) {
  if (rows.length === 0) {
    return;
  }

  const columnBlocks = columns
    .map((_, columnIndex) => ({
      columnIndex,
      rows: rows
        .filter((row) => nearestColumnIndex(row, columns) === columnIndex)
        .sort(compareRowsTopDown)
    }))
    .filter((block) => block.rows.length > 0);
  for (const block of columnBlocks) {
    blocks.push(block);
  }
}

function detectReadingColumns(rows) {
  const candidates = rows.filter((row) => Number.isFinite(row.x));
  if (candidates.length < 4) {
    return [];
  }

  const clusterTolerance = Math.max(36, median(candidates.map((row) => row.fontSize || 12)) * 3);
  const clusters = [];
  for (const row of [...candidates].sort((left, right) => left.x - right.x)) {
    const cluster = clusters.find((item) => Math.abs(item.center - row.x) <= clusterTolerance);
    if (cluster) {
      cluster.rows.push(row);
      cluster.center = average(cluster.rows.map((item) => item.x));
      continue;
    }
    clusters.push({
      center: row.x,
      rows: [row]
    });
  }

  const substantialClusters = clusters.filter((cluster) => cluster.rows.length >= 2);
  if (substantialClusters.length < 2) {
    return [];
  }

  const separatedClusters = substantialClusters
    .sort((left, right) => left.center - right.center)
    .filter((cluster, index, all) => {
      if (index === 0) {
        return true;
      }
      return cluster.center - all[index - 1].center >= 96;
    });

  return separatedClusters.length >= 2 ? separatedClusters : [];
}

function nearestColumnIndex(row, columns) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < columns.length; index += 1) {
    const distance = Math.abs(row.x - columns[index].center);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function compareRowsTopDown(left, right) {
  return right.y - left.y || left.x - right.x;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function createMarkdownBlock(text, kind, sourceLines = []) {
  return {
    text,
    kind,
    sourceLines
  };
}

function serializeMarkdownBlocks(blocks) {
  if (blocks.length === 0) {
    return {
      markdown: "",
      sourceMap: {
        entries: []
      }
    };
  }

  let markdown = "";
  const entries = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (index > 0) {
      markdown += "\n\n";
    }
    const block = blocks[index];
    const markdownStart = markdown.length;
    markdown += block.text;
    const markdownEnd = markdown.length;
    entries.push({
      markdownStart,
      markdownEnd,
      kind: block.kind,
      regions: block.sourceLines.map(lineToSourceRegion).filter(Boolean)
    });
  }
  markdown += "\n";

  return {
    markdown,
    sourceMap: {
      entries
    }
  };
}

function lineToSourceRegion(line) {
  if (!line || !Number.isInteger(line.pageIndex)) {
    return null;
  }
  return {
    pageIndex: line.pageIndex,
    x: numberOrNull(line.x),
    y: numberOrNull(line.y),
    width: numberOrNull(line.width),
    height: numberOrNull(line.height),
    source: line.source ?? "pdf-text"
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
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

function createRulingTableExports(lines, rulingTables) {
  const exportsByStart = new Map();
  if (!Array.isArray(rulingTables) || rulingTables.length === 0) {
    return exportsByStart;
  }

  const lineIndexes = new Map(lines.map((line, index) => [line, index]));
  for (const table of rulingTables) {
    const tableExport = createRulingTableExport(table, lines, lineIndexes);
    if (!tableExport) {
      continue;
    }
    const existing = exportsByStart.get(tableExport.startIndex);
    if (!existing || tableExport.sourceLines.length > existing.sourceLines.length) {
      exportsByStart.set(tableExport.startIndex, tableExport);
    }
  }
  return exportsByStart;
}

function createRulingTableExport(table, lines, lineIndexes) {
  if (!isRulingTableExportable(table)) {
    return null;
  }

  const hasSpans = hasRulingTableSpans(table);
  const rows = rulingTableRows(table);
  if (
    rows.length < 2 ||
    rows.some((row) => row.length !== table.columns) ||
    rows.every((row) => row.every((cell) => cell.length === 0))
  ) {
    return null;
  }

  const sourceLines = sourceLinesForRulingTable(table);
  if (
    sourceLines.length === 0 ||
    sourceLines.some((line) => !lineIndexes.has(line))
  ) {
    return null;
  }

  const sourceLineSet = new Set(sourceLines);
  const lineIndices = sourceLines.map((line) => lineIndexes.get(line)).sort((left, right) => left - right);
  const startIndex = lineIndices[0];
  const endIndex = lineIndices.at(-1) + 1;
  for (let index = startIndex; index < endIndex; index += 1) {
    if (!sourceLineSet.has(lines[index])) {
      return null;
    }
  }

  return {
    startIndex,
    endIndex,
    pageIndex: table.pageIndex ?? sourceLines[0]?.pageIndex,
    markdown: hasSpans ? formatHtmlRulingTable(table) : formatMarkdownTableCells(rows),
    sourceLines: [...sourceLines].sort(
      (left, right) => lineIndexes.get(left) - lineIndexes.get(right)
    )
  };
}

function isRulingTableExportable(table) {
  return (
    table &&
    Array.isArray(table.cells) &&
    table.rows >= 2 &&
    table.columns >= 2
  );
}

function hasRulingTableSpans(table) {
  return (
    table.hasSpans === true ||
    table.rowSpans > 0 ||
    table.columnSpans > 0 ||
    table.coveredCells > 0 ||
    table.cells.some(
      (cell) =>
        cell.coveredBy ||
        (cell.rowSpan ?? 1) > 1 ||
        (cell.columnSpan ?? 1) > 1
    )
  );
}

function rulingTableRows(table) {
  const cellsByPosition = new Map(
    table.cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell])
  );
  const rows = [];
  for (let rowIndex = 0; rowIndex < table.rows; rowIndex += 1) {
    const row = [];
    for (let columnIndex = 0; columnIndex < table.columns; columnIndex += 1) {
      const cell = cellsByPosition.get(`${rowIndex}:${columnIndex}`);
      row.push(cell && !cell.coveredBy ? normalizeText(cell.text) : "");
    }
    rows.push(row);
  }
  return rows;
}

function formatHtmlRulingTable(table) {
  const rows = rulingTableCellRows(table);
  const bodyRows = rows.slice(1);
  return [
    "<table>",
    "  <thead>",
    formatHtmlTableRow(rows[0], "th", "    "),
    "  </thead>",
    "  <tbody>",
    ...bodyRows.map((row) => formatHtmlTableRow(row, "td", "    ")),
    "  </tbody>",
    "</table>"
  ].join("\n");
}

function rulingTableCellRows(table) {
  const cellsByPosition = new Map(
    table.cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell])
  );
  const rows = [];
  for (let rowIndex = 0; rowIndex < table.rows; rowIndex += 1) {
    const row = [];
    for (let columnIndex = 0; columnIndex < table.columns; columnIndex += 1) {
      const cell = cellsByPosition.get(`${rowIndex}:${columnIndex}`);
      if (!cell || cell.coveredBy) {
        continue;
      }
      row.push(cell);
    }
    rows.push(row);
  }
  return rows;
}

function formatHtmlTableRow(cells, tagName, indent) {
  return [
    `${indent}<tr>`,
    ...cells.map((cell) => `${indent}  ${formatHtmlTableCell(cell, tagName)}`),
    `${indent}</tr>`
  ].join("\n");
}

function formatHtmlTableCell(cell, tagName) {
  const attributes = [];
  if ((cell.rowSpan ?? 1) > 1) {
    attributes.push(`rowspan="${cell.rowSpan}"`);
  }
  if ((cell.columnSpan ?? 1) > 1) {
    attributes.push(`colspan="${cell.columnSpan}"`);
  }
  const attributeText = attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
  return `<${tagName}${attributeText}>${escapeHtml(normalizeText(cell.text))}</${tagName}>`;
}

function sourceLinesForRulingTable(table) {
  const seen = new Set();
  const sourceLines = [];
  for (const cell of table.cells) {
    for (const line of cell.lines ?? []) {
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      sourceLines.push(line);
    }
  }
  return sourceLines;
}

function readRulingTableAt(index, rulingTableExports) {
  return rulingTableExports.get(index) ?? null;
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
  if (!isPlausibleBorderlessTable(rows)) {
    return null;
  }

  return {
    rows,
    endIndex: index
  };
}

function isPlausibleBorderlessTable(rows) {
  const body = rows.slice(1);
  if (body.length === 0) {
    return false;
  }

  return rows[0].some((_, columnIndex) => {
    const values = body.map((row) => normalizeText(row[columnIndex].text));
    return values.length > 0 && values.every(isNumericCell);
  });
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
  return formatMarkdownTableCells(cells);
}

function formatMarkdownTableCells(cells) {
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

function removeRepeatedRunningContent(lines, options = {}) {
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
    if (options.preserveRunningTitles && isRunningTitleCandidate(line)) {
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

function isRunningTitleCandidate(line) {
  return (
    line.fontSize <= 10 &&
    Number.isFinite(line.y) &&
    line.y >= 740 &&
    /[A-Za-z]/.test(normalizeWhitespace(line.text))
  );
}
