import {
  extractContentStreamImageDraws,
  extractContentStreamRulingLines,
  extractContentStreamTextLines,
  extractContentStreamsImageDraws,
  extractContentStreamsRulingLines,
  extractContentStreamsTextLines,
  mergeRulingLines
} from "./content-stream.mjs";
import { bytesToLatin1 } from "./runtime.mjs";

const linkPattern = /(https?:\/\/[^\s<>()\[\]{}]+|www\.[^\s<>()\[\]{}]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const defaultEquationImageFallbackConfidence = 0.75;

export function extractTextLines(bytes, { document = null } = {}) {
  return extractDocumentContent(bytes, { document }).textLines;
}

export function extractRulingLines(bytes, { document = null } = {}) {
  return extractDocumentContent(bytes, { document }).rulingLines;
}

export function extractImageDraws(bytes, { document = null } = {}) {
  return extractDocumentContent(bytes, { document }).imageDraws;
}

export function extractDocumentContent(
  bytes,
  { document = null, contentStreamLimits = null } = {}
) {
  const contentStreamBudgets = createContentStreamBudgets();
  return document
    ? extractParsedDocumentContent(document, { contentStreamBudgets, contentStreamLimits })
    : extractScannedStreamContent(bytes, { contentStreamBudgets, contentStreamLimits });
}

function findStreamTextsByScan(bytes) {
  const source = bytesToLatin1(bytes);
  const streamTexts = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const streamMatch of source.matchAll(streamPattern)) {
    streamTexts.push(streamMatch[1]);
  }
  return streamTexts;
}

function extractScannedStreamContent(bytes, { contentStreamBudgets, contentStreamLimits }) {
  const content = createEmptyExtractedContent();
  const streamTexts = findStreamTextsByScan(bytes);
  for (let streamIndex = 0; streamIndex < streamTexts.length; streamIndex += 1) {
    appendContentStreamExtraction(
      content,
      streamTexts[streamIndex],
      { streamIndex },
      { contentStreamBudgets, contentStreamLimits }
    );
  }
  content.rulingLines = mergeRulingLines(content.rulingLines);
  return content;
}

function extractParsedDocumentContent(document, { contentStreamBudgets, contentStreamLimits }) {
  const content = createEmptyExtractedContent();
  if (document.pages?.length > 0) {
    const structureByPage = structureSignalsByPage(document.structure);
    for (const page of document.pages) {
      const structureByMcid = structureByPage.get(page.pageIndex) ?? new Map();
      appendPageContentStreamExtraction(
        content,
        page.contentStreams,
        {
          pageIndex: page.pageIndex,
          resources: page.resources,
          structureByMcid
        },
        { contentStreamBudgets, contentStreamLimits }
      );
    }
    content.rulingLines = mergeRulingLines(content.rulingLines);
    return content;
  }

  for (let streamIndex = 0; streamIndex < document.streams.length; streamIndex += 1) {
    appendContentStreamExtraction(
      content,
      document.streams[streamIndex].text,
      { streamIndex },
      { contentStreamBudgets, contentStreamLimits }
    );
  }
  content.rulingLines = mergeRulingLines(content.rulingLines);
  return content;
}

function appendPageContentStreamExtraction(
  content,
  contentStreams,
  options,
  { contentStreamBudgets, contentStreamLimits }
) {
  const streams = contentStreams.map((stream, streamIndex) => ({
    text: stream.text,
    streamIndex
  }));
  content.textLines.push(
    ...extractContentStreamsTextLines(streams, {
      ...options,
      contentStreamBudget: contentStreamBudgets.text,
      contentStreamLimits
    })
  );
  content.rulingLines.push(
    ...extractContentStreamsRulingLines(streams, {
      ...options,
      contentStreamBudget: contentStreamBudgets.ruling,
      contentStreamLimits,
      mergeRulingLines: false
    })
  );
  content.imageDraws.push(
    ...extractContentStreamsImageDraws(streams, {
      ...options,
      contentStreamBudget: contentStreamBudgets.image,
      contentStreamLimits
    })
  );
}

function createEmptyExtractedContent() {
  return {
    textLines: [],
    rulingLines: [],
    imageDraws: []
  };
}

function appendContentStreamExtraction(
  content,
  streamText,
  options,
  { contentStreamBudgets, contentStreamLimits }
) {
  content.textLines.push(
    ...extractContentStreamTextLines(streamText, {
      ...options,
      contentStreamBudget: contentStreamBudgets.text,
      contentStreamLimits
    })
  );
  content.rulingLines.push(
    ...extractContentStreamRulingLines(streamText, {
      ...options,
      contentStreamBudget: contentStreamBudgets.ruling,
      contentStreamLimits,
      mergeRulingLines: false
    })
  );
  content.imageDraws.push(
    ...extractContentStreamImageDraws(streamText, {
      ...options,
      contentStreamBudget: contentStreamBudgets.image,
      contentStreamLimits
    })
  );
}

function createContentStreamBudgets() {
  return {
    text: { tokens: 0, operations: 0, outputs: 0 },
    ruling: { tokens: 0, operations: 0, outputs: 0 },
    image: { tokens: 0, operations: 0, outputs: 0 }
  };
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
  const formulaOcrState = createFormulaOcrState(options.equations?.formulaOcr);
  const taggedStructureConflicts = taggedStructureConflictsForLines(lines, headingModel);
  const listIndentModel = createListIndentModel(lines);
  const codeModel = createCodeModel(lines);
  const equationModel = createEquationModel(lines);
  const rulingTableExports = createRulingTableExports(
    lines,
    options.rulingTables ?? [],
    options.tableCsvSidecarsByTable
  );
  const lowConfidenceTables = [];
  const lowConfidenceTableLines = new Set();
  const blocks = [];
  const equationImageCountsByPage = new Map();
  let equationSequence = 0;
  let previousWasList = false;
  const anchoredPages = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const rulingTable = readRulingTableAt(index, rulingTableExports);
    if (rulingTable) {
      previousWasList = false;
      appendPageAnchor(blocks, rulingTable.pageIndex, options, anchoredPages);
      blocks.push(
        createMarkdownBlock(rulingTable.markdown, "table", rulingTable.sourceLines, {
          irRows: rulingTable.irRows,
          csvSidecarAssetId: rulingTable.csvSidecarAssetId,
          table: {
            source: "ruling-grid",
            pageIndex: rulingTable.pageIndex,
            rows: rulingTable.rows,
            columns: rulingTable.columns,
            output: rulingTable.output,
            confidence: rulingTable.confidence,
            hasSpans: rulingTable.hasSpans,
            numericColumns: rulingTable.numericColumns
          }
        })
      );
      continue;
    }
    if (isRulingTableSourceLineAt(index, rulingTableExports)) {
      previousWasList = false;
      continue;
    }

    const table = readTableAt(lines, index);
    if (table?.lowConfidence) {
      recordLowConfidenceTable(table, lowConfidenceTables, lowConfidenceTableLines);
    } else if (table) {
      previousWasList = false;
      appendPageAnchor(blocks, table.rows[0][0]?.pageIndex, options, anchoredPages);
      blocks.push(
        createMarkdownBlock(formatTable(table.rows), "table", table.rows.flat(), {
          irRows: table.rows.map((row) =>
            row.map((line) => ({
              text: normalizeText(line.text ?? ""),
              rowSpan: 1,
              colSpan: 1
            }))
          ),
          table: {
            source: "borderless-heuristic",
            pageIndex: table.rows[0][0]?.pageIndex ?? null,
            rows: table.rows.length,
            columns: table.rows[0].length,
            output: "gfm",
            confidence: table.confidence,
            hasSpans: false,
            numericColumns: table.numericColumns
          }
        })
      );
      index = table.endIndex - 1;
      continue;
    }

    const line = lines[index];
    const text = normalizeText(line.text);
    if (text.length === 0) {
      continue;
    }

    if (appendPageAnchor(blocks, line.pageIndex, options, anchoredPages)) {
      previousWasList = false;
    }

    const equationBlock = readEquationAt(
      lines,
      index,
      headingModel,
      equationModel,
      rulingTableExports
    );
    if (equationBlock) {
      const formulaOcr = formulaOcrForEquation(
        equationBlock.sourceLines,
        equationSequence,
        formulaOcrState
      );
      const metadataFallback = formulaOcr
        ? null
        : equationMetadataFallbackForLines(
            equationBlock.sourceLines,
            options.equations ?? {},
            equationImageCountsByPage
          );
      equationSequence += 1;
      previousWasList = false;
      blocks.push(
        createMarkdownBlock(equationMarkdown(equationBlock.sourceLines, metadataFallback, formulaOcr), "equation", equationBlock.sourceLines, {
          equation: equationMetadata(equationBlock.sourceLines, metadataFallback, formulaOcr)
        })
      );
      index = equationBlock.endIndex - 1;
      continue;
    }

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
      if (previousWasList && blocks.at(-1)?.kind === "list") {
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
    const paragraph = readParagraphAt(lines, index, text, headingModel, rulingTableExports, equationModel);
    blocks.push(
      createMarkdownBlock(formatParagraphMarkdown(paragraph), "paragraph", paragraph.sourceLines)
    );
    index = paragraph.endIndex - 1;
  }

  return {
    ...serializeMarkdownBlocks(blocks),
    irElementsByPage: irElementsByPageFromBlocks(blocks),
    tables: tableDiagnosticsFromBlocks(blocks),
    equations: equationDiagnosticsFromBlocks(blocks, formulaOcrState),
    lowConfidenceTables,
    layout,
    taggedStructureConflicts
  };
}

function appendPageAnchor(blocks, pageIndex, options, anchoredPages) {
  if (!options.pageAnchors || !Number.isInteger(pageIndex) || anchoredPages.has(pageIndex)) {
    return false;
  }
  anchoredPages.add(pageIndex);
  blocks.push(
    createMarkdownBlock(`<a id="page-${pageIndex + 1}"></a>`, "page_anchor", [
      { pageIndex }
    ])
  );
  return true;
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
      readConfidentTableAt(lines, index)
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
  const normalizedLines = lines.map((line) => normalizeText(line.text ?? ""));
  const fence = codeFenceForText(normalizedLines.join("\n"));
  const positions = lines.map((line) => line.x).filter(Number.isFinite);
  const left = positions.length > 0 ? Math.min(...positions) : 0;
  return [
    fence,
    ...lines.map((line, index) => `${codeIndent(line, left)}${normalizedLines[index]}`),
    fence
  ].join("\n");
}

function codeFenceForText(text) {
  const backtickLength = Math.max(3, longestCharacterRun(text, "`") + 1);
  const tildeLength = Math.max(3, longestCharacterRun(text, "~") + 1);
  return backtickLength <= tildeLength
    ? "`".repeat(backtickLength)
    : "~".repeat(tildeLength);
}

function longestCharacterRun(value, character) {
  let longest = 0;
  let current = 0;
  for (const item of value) {
    if (item === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function codeIndent(line, left) {
  if (!Number.isFinite(line.x) || !Number.isFinite(left)) {
    return "";
  }
  return " ".repeat(Math.max(0, Math.round((line.x - left) / 12)));
}

function createEquationModel(lines) {
  const textLines = lines.filter((line) => normalizeText(line.text ?? "").length > 0);
  const leftEdges = textLines.map((line) => line.x).filter(Number.isFinite);
  const rightEdges = textLines
    .filter((line) => Number.isFinite(line.x))
    .map(lineRightEdge)
    .filter(Number.isFinite);
  const bodyLeft = leftEdges.length > 0 ? Math.min(...leftEdges) : 0;
  const bodyRight = rightEdges.length > 0 ? Math.max(...rightEdges) : bodyLeft + 468;
  return {
    bodyLeft,
    bodyWidth: Math.max(1, bodyRight - bodyLeft)
  };
}

function readEquationAt(lines, startIndex, headingModel, equationModel, rulingTableExports = new Map()) {
  const sourceLines = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const text = normalizeText(line.text ?? "");
    if (
      text.length === 0 ||
      headingLevelForLine(line, headingModel) !== null ||
      parseListItem(text) ||
      startsWithMarkdownBlockMarker(text) ||
      readRulingTableAt(index, rulingTableExports) ||
      isRulingTableSourceLineAt(index, rulingTableExports) ||
      readConfidentTableAt(lines, index) ||
      !isEquationLine(line, equationModel)
    ) {
      break;
    }
    if (
      sourceLines.length > 0 &&
      !isEquationContinuation(sourceLines[sourceLines.length - 1], line)
    ) {
      break;
    }
    sourceLines.push(line);
    index += 1;
  }

  if (sourceLines.length === 0) {
    return null;
  }
  return {
    sourceLines,
    endIndex: index
  };
}

function isEquationLine(line, equationModel) {
  const text = normalizeText(line.text ?? "");
  if (
    text.length < 3 ||
    text.length > 180 ||
    isLikelyCodeText(text) ||
    isLikelyLinkText(text) ||
    isLikelyRawHtmlText(text) ||
    isLikelyProseSentence(text)
  ) {
    return false;
  }
  if (!hasEquationStructure(text)) {
    return false;
  }
  return hasStrongMathSymbol(text) || isDisplayMathLine(line, equationModel);
}

function isEquationContinuation(previous, next) {
  if ((previous.pageIndex ?? null) !== (next.pageIndex ?? null)) {
    return false;
  }
  if (!Number.isFinite(previous.y) || !Number.isFinite(next.y)) {
    return true;
  }
  const verticalGap = Math.abs(previous.y - next.y);
  return verticalGap <= Math.max(24, (previous.fontSize ?? 12) * 2);
}

function hasEquationStructure(text) {
  return (
    hasStrongMathSymbol(text) ||
    /(?:^|[\s(])(?:[A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?)\s*(?:=|<=|>=|<|>)\s*[-+A-Za-z0-9([\\]/.test(text) ||
    /(?:[A-Za-z0-9)\]])\s*(?:\^|_|\/|\*)\s*(?:[A-Za-z0-9([])/.test(text)
  );
}

function hasStrongMathSymbol(text) {
  return /[\u0370-\u03ff\u2200-\u22ff]/.test(text);
}

function isDisplayMathLine(line, equationModel) {
  if (!Number.isFinite(line.x)) {
    return true;
  }
  const width = Number.isFinite(line.width) && line.width > 0 ? line.width : lineRightEdge(line) - line.x;
  const indented = line.x >= equationModel.bodyLeft + 24;
  const compact = width <= equationModel.bodyWidth * 0.72;
  return indented || compact;
}

function isLikelyCodeText(text) {
  return (
    /^(?:const|let|var|function|class|if|else|for|while|return|import|export)\b/.test(text) ||
    /[{};]/.test(text)
  );
}

function isLikelyLinkText(text) {
  return /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(text);
}

function isLikelyRawHtmlText(text) {
  return /<\/?[A-Za-z][^>]*>|<!--|<![A-Z]|<\?/i.test(text);
}

function isLikelyProseSentence(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 7 && /[.!?]$/.test(text) && !hasStrongMathSymbol(text);
}

function formatEquationBlock(lines) {
  const body = lines.map((line) => normalizeText(line.text ?? "").replace(/\$\$/g, "\\$\\$")).join("\n");
  return `$$\n${body}\n$$`;
}

function equationMarkdown(lines, metadataFallback, formulaOcr = null) {
  if (formulaOcr?.latex) {
    return formatLatexEquationBlock(formulaOcr.latex);
  }
  if (metadataFallback) {
    return `*[Equation ${metadataFallback.equationNumber} preview unavailable; low-confidence OCR retained in metadata.]*`;
  }
  return formatEquationBlock(lines);
}

function formatLatexEquationBlock(latex) {
  return `$$\n${latex.replace(/\$\$/g, "\\$\\$")}\n$$`;
}

function equationMetadata(lines, metadataFallback = null, formulaOcr = null) {
  const bounds = boundsForLines(lines);
  const text = lines.map((line) => normalizeText(line.text ?? "")).join("\n");
  const metadata = {
    source: lines.find((line) => typeof line.source === "string")?.source ?? "pdf-text",
    text,
    latex: formulaOcr?.latex ?? null,
    lineCount: lines.length,
    containsUnicodeMath: lines.some((line) => hasStrongMathSymbol(normalizeText(line.text ?? ""))),
    ...bounds
  };
  if (formulaOcr) {
    return {
      ...metadata,
      formulaOcrSource: formulaOcr.source,
      ...(formulaOcr.confidence != null ? { formulaOcrConfidence: formulaOcr.confidence } : {})
    };
  }
  return metadataFallback
    ? {
        ...metadata,
        output: "metadata-only",
        previewStatus: "unavailable",
        confidence: metadataFallback.confidence,
        fallbackReason: metadataFallback.fallbackReason,
        fallbackThreshold: metadataFallback.fallbackThreshold
      }
    : metadata;
}

function createFormulaOcrState(config = {}) {
  if (config?.enabled === false) {
    return {
      enabled: false,
      status: "disabled",
      results: [],
      usedResultIndexes: new Set()
    };
  }
  const results = (Array.isArray(config?.results) ? config.results : [])
    .map(normalizeFormulaOcrResult)
    .filter(Boolean);
  const enabled = config?.enabled === true || results.length > 0;
  return {
    enabled,
    status: enabled ? "selected" : "not-configured",
    results,
    usedResultIndexes: new Set()
  };
}

function normalizeFormulaOcrResult(result, resultIndex) {
  const latex = normalizeFormulaLatex(result?.latex);
  if (!latex) {
    return null;
  }
  return {
    resultIndex,
    equationIndex: Number.isInteger(result.equationIndex) ? result.equationIndex : null,
    pageIndex: Number.isInteger(result.pageIndex) ? result.pageIndex : null,
    latex,
    confidence: normalizeOptionalConfidence(result.confidence),
    source: result.source ?? "options.equations.formulaOcr.results"
  };
}

function normalizeFormulaLatex(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeOptionalConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return null;
  }
  return roundNumber(confidence > 1 ? confidence / 100 : confidence);
}

function formulaOcrForEquation(lines, equationIndex, state) {
  if (!state.enabled || state.status === "disabled" || state.results.length === 0) {
    return null;
  }
  const pageIndex = lines.find((line) => Number.isInteger(line.pageIndex))?.pageIndex ?? null;
  const result = state.results.find((candidate) => {
    if (state.usedResultIndexes.has(candidate.resultIndex)) {
      return false;
    }
    if (candidate.equationIndex !== null) {
      return candidate.equationIndex === equationIndex;
    }
    if (candidate.pageIndex !== null && Number.isInteger(pageIndex)) {
      return candidate.pageIndex === pageIndex;
    }
    return candidate.resultIndex === equationIndex;
  });
  if (!result) {
    return null;
  }
  state.usedResultIndexes.add(result.resultIndex);
  return result;
}

function equationMetadataFallbackForLines(lines, options, countsByPage) {
  const confidence = equationOcrConfidence(lines);
  const threshold = equationImageFallbackConfidence(options);
  if (confidence === null || confidence >= threshold) {
    return null;
  }
  const pageIndex = lines.find((line) => Number.isInteger(line.pageIndex))?.pageIndex ?? null;
  const pageKey = Number.isInteger(pageIndex) ? pageIndex : "unknown";
  const equationNumber = (countsByPage.get(pageKey) ?? 0) + 1;
  countsByPage.set(pageKey, equationNumber);
  return {
    equationNumber,
    confidence,
    fallbackReason: "low-ocr-confidence",
    fallbackThreshold: threshold
  };
}

function equationOcrConfidence(lines) {
  if (!lines.some((line) => line.source === "ocr")) {
    return null;
  }
  const confidenceValues = lines
    .map((line) => Number(line.confidence))
    .filter(Number.isFinite);
  if (confidenceValues.length === 0) {
    return null;
  }
  return roundNumber(average(confidenceValues));
}

function equationImageFallbackConfidence(options) {
  const threshold = Number(options.imageFallbackConfidence);
  if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
    return threshold;
  }
  return defaultEquationImageFallbackConfidence;
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
    normalizeScriptCharacters(value)
      .replace(/\uFB00/g, "ff")
      .replace(/\uFB01/g, "fi")
      .replace(/\uFB02/g, "fl")
      .replace(/\uFB03/g, "ffi")
      .replace(/\uFB04/g, "ffl")
      .replace(/\uFB05/g, "st")
      .replace(/\uFB06/g, "st")
  );
}

function normalizeScriptCharacters(value) {
  let result = "";
  for (const char of String(value ?? "")) {
    const codePoint = char.codePointAt(0);
    result += shouldNormalizeCompatibilityCharacter(codePoint) ? char.normalize("NFKC") : char;
  }
  return result;
}

function shouldNormalizeCompatibilityCharacter(codePoint) {
  return (
    codePoint === 0x3000 ||
    (codePoint >= 0xff01 && codePoint <= 0xff9f) ||
    (codePoint >= 0xfb50 && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  );
}

function escapeMarkdownParagraph(value) {
  return escapeMarkdownInline(value)
    .replace(/^([#>])/, "\\$1")
    .replace(/^([-+])(\s)/, "\\$1$2")
    .replace(/^(\d+)\. /, "$1\\. ");
}

function formatParagraphMarkdown(paragraph) {
  const direction = paragraphDirection(paragraph.sourceLines);
  if (direction === "vertical") {
    return `<p style="writing-mode: vertical-rl">${escapeHtml(paragraph.text)}</p>`;
  }
  if (direction === "rtl") {
    return `<p dir="rtl">${escapeHtml(paragraph.text)}</p>`;
  }
  return escapeMarkdownParagraph(paragraph.text);
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
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]])/g, "\\$1");
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

function readParagraphAt(
  lines,
  startIndex,
  firstText,
  headingModel,
  rulingTableExports = new Map(),
  equationModel = createEquationModel(lines)
) {
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
      isRulingTableSourceLineAt(index, rulingTableExports) ||
      isEquationLine(line, equationModel) ||
      readConfidentTableAt(lines, index) ||
      !isParagraphContinuation(previous, line)
    ) {
      break;
    }

    parts.push(text);
    previous = line;
    index += 1;
  }

  return {
    text: joinParagraphParts(parts),
    sourceLines: lines.slice(startIndex, index),
    endIndex: index
  };
}

function joinParagraphParts(parts) {
  if (parts.length <= 1) {
    return parts.join("");
  }

  let text = parts[0];
  for (const part of parts.slice(1)) {
    if (shouldRepairHyphenatedBreak(text, part)) {
      text = text.replace(/-\s*$/, "");
      text += part.trimStart();
      continue;
    }
    text += paragraphPartSeparator(text, part);
    text += part;
  }
  return text;
}

function shouldRepairHyphenatedBreak(previous, next) {
  const previousText = String(previous ?? "").trimEnd();
  const nextText = String(next ?? "").trimStart();
  return /[A-Za-z]-$/.test(previousText) && /^[a-z]/.test(nextText);
}

function paragraphPartSeparator(previous, next) {
  const previousChar = lastVisibleCharacter(previous);
  const nextChar = firstVisibleCharacter(next);
  if (previousChar && nextChar && isCjkLineBreakBoundary(previousChar, nextChar)) {
    return "";
  }
  return " ";
}

function firstVisibleCharacter(value) {
  for (const char of String(value ?? "")) {
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return null;
}

function lastVisibleCharacter(value) {
  const chars = [...String(value ?? "")].filter((char) => !/\s/.test(char));
  return chars.at(-1) ?? null;
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
    text: rows.map(rowText).join(" "),
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

  if (indexedLines.length > 0 && pageDirection(indexedLines) === "vertical") {
    return orderVerticalPageLines(indexedLines);
  }

  const rows = groupLinesIntoRows(indexedLines);
  const blocks = segmentRowsIntoReadingBlocks(rows);
  return blocks.flatMap((block) => block.rows.flatMap((row) => row.items.map((item) => item.line)));
}

function hasLineGeometry(line) {
  return Number.isFinite(line.x) && Number.isFinite(line.y);
}

function pageDirection(indexedLines) {
  return dominantDirection(indexedLines.map((item) => item.line));
}

function orderVerticalPageLines(indexedLines) {
  return groupLinesIntoVerticalColumns(indexedLines).flatMap((column) =>
    column.items
      .sort(
        (left, right) =>
          right.line.y - left.line.y ||
          lineVerticalAxis(right.line) - lineVerticalAxis(left.line) ||
          left.index - right.index
      )
      .map((item) => item.line)
  );
}

function groupLinesIntoVerticalColumns(indexedLines) {
  const columns = [];
  const sorted = [...indexedLines].sort(
    (left, right) =>
      lineVerticalAxis(right.line) - lineVerticalAxis(left.line) ||
      right.line.y - left.line.y ||
      left.index - right.index
  );

  for (const item of sorted) {
    const axis = lineVerticalAxis(item.line);
    const tolerance = verticalColumnTolerance(item.line);
    const current = columns[columns.length - 1];
    if (current && Math.abs(current.x - axis) <= Math.max(current.tolerance, tolerance)) {
      current.items.push(item);
      current.x = average(current.items.map((columnItem) => lineVerticalAxis(columnItem.line)));
      current.tolerance = Math.max(current.tolerance, tolerance);
      continue;
    }

    columns.push({
      items: [item],
      x: axis,
      tolerance
    });
  }

  return columns;
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
  const direction = rowDirection(row.items);
  const items = sortRowItems(row.items, direction);
  if (items.length <= 1 || direction === "rtl" || isLikelyTabularRowItems(items)) {
    return [createReadingRow(items, direction)];
  }

  return items.map((item) => createReadingRow([item], direction));
}

function createReadingRow(items, direction = rowDirection(items)) {
  items = sortRowItems(items, direction);
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

function sortRowItems(items, direction = rowDirection(items)) {
  return [...items].sort(
    direction === "rtl"
      ? (left, right) =>
          lineRightEdge(right.line) - lineRightEdge(left.line) ||
          right.line.x - left.line.x ||
          left.line.y - right.line.y ||
          left.index - right.index
      : (left, right) =>
          left.line.x - right.line.x ||
          left.line.y - right.line.y ||
          left.index - right.index
  );
}

function rowDirection(items) {
  return dominantDirection(items.map((item) => item.line));
}

function paragraphDirection(lines) {
  return dominantDirection(lines);
}

function dominantDirection(lines) {
  let vertical = 0;
  let rtl = 0;
  let ltr = 0;
  for (const line of lines) {
    const direction = lineDirection(line);
    if (direction === "vertical") {
      vertical += 1;
    } else if (direction === "rtl") {
      rtl += 1;
    } else if (direction === "ltr") {
      ltr += 1;
    }
  }
  if (vertical > rtl && vertical > ltr) {
    return "vertical";
  }
  return rtl > ltr ? "rtl" : ltr > 0 ? "ltr" : "unknown";
}

function lineDirection(line) {
  if (line?.direction === "rtl" || line?.direction === "ltr" || line?.direction === "vertical") {
    return line.direction;
  }
  return textDirection(normalizeText(line?.text ?? ""));
}

function textDirection(text) {
  let rtl = 0;
  let ltr = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (isRtlCodePoint(codePoint)) {
      rtl += 1;
    } else if (isLatinCodePoint(codePoint)) {
      ltr += 1;
    }
  }
  return rtl > ltr ? "rtl" : ltr > 0 ? "ltr" : "unknown";
}

function isRtlCodePoint(codePoint) {
  return (
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  );
}

function isLatinCodePoint(codePoint) {
  return (
    (codePoint >= 0x0041 && codePoint <= 0x005a) ||
    (codePoint >= 0x0061 && codePoint <= 0x007a)
  );
}

function isCjkLineBreakBoundary(previousChar, nextChar) {
  return isCjkJoinCharacter(previousChar) && isCjkJoinCharacter(nextChar);
}

function isCjkJoinCharacter(char) {
  if (!char) {
    return false;
  }
  const codePoint = char.codePointAt(0);
  return isCjkCodePoint(codePoint) || isCjkPunctuationCodePoint(codePoint);
}

function isCjkCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function isCjkPunctuationCodePoint(codePoint) {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
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

function lineVerticalAxis(line) {
  if (Number.isFinite(line.width) && line.width > 0) {
    return line.x + line.width / 2;
  }
  return line.x;
}

function verticalColumnTolerance(line) {
  const width = Number.isFinite(line.width) && line.width > 0 ? line.width : line.fontSize;
  return Math.max(4, (width ?? 10) * 0.75);
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

function createMarkdownBlock(text, kind, sourceLines = [], metadata = {}) {
  return {
    text,
    kind,
    sourceLines,
    metadata
  };
}

function irElementsByPageFromBlocks(blocks) {
  const elementsByPage = new Map();
  for (const block of blocks) {
    if (block.kind === "table") {
      appendTableIrElement(elementsByPage, block);
      continue;
    }
    if (block.kind === "equation" || block.kind === "page_anchor") {
      continue;
    }
    for (const line of block.sourceLines) {
      if (!Number.isInteger(line?.pageIndex)) {
        continue;
      }
      const spans = irTextSpansForLine(line);
      if (spans.length === 0) {
        continue;
      }
      appendIrElement(elementsByPage, line.pageIndex, {
        type: "text",
        spans
      });
    }
  }
  return elementsByPage;
}

function appendTableIrElement(elementsByPage, block) {
  const pageIndex = block.metadata?.table?.pageIndex;
  if (!Number.isInteger(pageIndex) || !Array.isArray(block.metadata?.irRows)) {
    return;
  }
  appendIrElement(elementsByPage, pageIndex, {
    type: "table",
    rows: block.metadata.irRows.map((row) => row.map((cell) => ({ ...cell }))),
    confidence: block.metadata.table.confidence,
    ...(block.metadata.table.output === "html" ? { htmlFallback: block.text } : {}),
    ...(typeof block.metadata.csvSidecarAssetId === "string"
      ? { csvSidecarAssetId: block.metadata.csvSidecarAssetId }
      : {})
  });
}

function appendIrElement(elementsByPage, pageIndex, element) {
  const elements = elementsByPage.get(pageIndex) ?? [];
  elements.push(element);
  elementsByPage.set(pageIndex, elements);
}

function irTextSpansForLine(line) {
  const sourceSpans = Array.isArray(line.spans) && line.spans.length > 0
    ? line.spans
    : [line];
  return coalesceIrTextSpans(
    sourceSpans
      .map((span) => createIrTextSpan(span, line))
      .filter(Boolean)
  );
}

function coalesceIrTextSpans(spans) {
  const coalesced = [];
  for (const span of spans) {
    const previous = coalesced.at(-1);
    if (!previous || !canCoalesceIrTextSpans(previous, span)) {
      coalesced.push(span);
      continue;
    }
    const minX = Math.min(previous.x, span.x);
    const minY = Math.min(previous.y, span.y);
    const maxX = Math.max(previous.x + previous.width, span.x + span.width);
    const maxY = Math.max(previous.y + previous.height, span.y + span.height);
    previous.text += span.text;
    if (previous.glyphIds) {
      previous.glyphIds.push(...span.glyphIds);
    }
    previous.x = roundNumber(minX);
    previous.y = roundNumber(minY);
    previous.width = roundNumber(maxX - minX);
    previous.height = roundNumber(maxY - minY);
  }
  return coalesced;
}

function canCoalesceIrTextSpans(left, right) {
  if (
    left.fontName !== right.fontName ||
    left.direction !== right.direction ||
    left.confidence !== right.confidence ||
    left.source !== right.source ||
    Boolean(left.glyphIds) !== Boolean(right.glyphIds)
  ) {
    return false;
  }
  const vertical = left.direction === "vertical";
  const leftCrossSize = vertical ? left.width : left.height;
  const rightCrossSize = vertical ? right.width : right.height;
  const tolerance = Math.max(0.5, Math.min(leftCrossSize, rightCrossSize) * 0.1);
  if (vertical) {
    return (
      Math.abs(left.x - right.x) <= tolerance &&
      Math.abs(left.width - right.width) <= tolerance &&
      intervalGap(left.y, left.height, right.y, right.height) <= tolerance
    );
  }
  return (
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance &&
    intervalGap(left.x, left.width, right.x, right.width) <= tolerance
  );
}

function intervalGap(leftStart, leftLength, rightStart, rightLength) {
  return Math.max(
    0,
    Math.max(leftStart, rightStart) -
      Math.min(leftStart + leftLength, rightStart + rightLength)
  );
}

function createIrTextSpan(span, line) {
  const text = String(span?.text ?? line?.text ?? "");
  if (text.length === 0) {
    return null;
  }
  const fontName = span?.fontName ?? line?.fontName;
  const glyphIds = Array.isArray(span?.glyphIds) ? [...span.glyphIds] : null;
  return {
    text,
    ...(glyphIds ? { glyphIds } : {}),
    ...(typeof fontName === "string" && fontName.length > 0 ? { fontName } : {}),
    x: roundNumber(finiteOr(span?.x, finiteOr(line?.x, 0))),
    y: roundNumber(finiteOr(span?.y, finiteOr(line?.y, 0))),
    width: roundNumber(Math.max(0, finiteOr(span?.width, finiteOr(line?.width, 0)))),
    height: roundNumber(Math.max(0, finiteOr(span?.height, finiteOr(line?.height, 0)))),
    direction: irTextDirection(span?.direction ?? line?.direction),
    confidence: normalizedIrConfidence(span?.confidence ?? line?.confidence),
    source: irTextSource(span?.source ?? line?.source)
  };
}

function irTextDirection(value) {
  return value === "ltr" || value === "rtl" || value === "vertical" ? value : "unknown";
}

function normalizedIrConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence)
    ? roundNumber(Math.min(1, Math.max(0, confidence > 1 ? confidence / 100 : confidence)))
    : 0;
}

function irTextSource(value) {
  return value === "ocr" || value === "tagged-pdf" ? value : "pdf-text";
}

function tableDiagnosticsFromBlocks(blocks) {
  const tables = [];
  for (const block of blocks) {
    if (block.kind !== "table" || !block.metadata?.table) {
      continue;
    }
    tables.push({
      tableIndex: tables.length,
      ...block.metadata.table,
      sourceLines: block.sourceLines.length
    });
  }
  return tables;
}

function equationDiagnosticsFromBlocks(blocks, formulaOcrState) {
  const equations = [];
  for (const block of blocks) {
    if (block.kind !== "equation" || !block.metadata?.equation) {
      continue;
    }
    equations.push({
      equationIndex: equations.length,
      pageIndex: block.sourceLines.find((line) => Number.isInteger(line.pageIndex))?.pageIndex ?? null,
      ...block.metadata.equation
    });
  }
  return {
    total: equations.length,
    unicodeEquations: equations.filter((equation) => equation.containsUnicodeMath).length,
    textEquations: equations.filter((equation) => equation.output == null).length,
    imageEquations: equations.filter((equation) => equation.output === "image").length,
    metadataOnlyEquations: equations.filter((equation) => equation.output === "metadata-only").length,
    formulaOcr: {
      enabled: formulaOcrState.enabled,
      status: formulaOcrState.status
    },
    equations
  };
}

function recordLowConfidenceTable(table, lowConfidenceTables, seenLines) {
  const sourceLines = table.rows.flat();
  if (sourceLines.some((line) => seenLines.has(line))) {
    return;
  }
  for (const line of sourceLines) {
    seenLines.add(line);
  }
  lowConfidenceTables.push({
    tableIndex: lowConfidenceTables.length,
    source: "borderless-heuristic",
    pageIndex: table.rows[0][0]?.pageIndex ?? null,
    rows: table.rows.length,
    columns: table.rows[0].length,
    confidence: table.confidence,
    reason: table.reason,
    sourceLines: sourceLines.length
  });
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

function boundsForLines(lines) {
  const regions = lines
    .filter((line) => Number.isFinite(line.x) && Number.isFinite(line.y))
    .map((line) => ({
      x: line.x,
      y: line.y,
      width: Math.max(1, finiteOr(line.width, lineRightEdge(line) - line.x)),
      height: Math.max(1, finiteOr(line.height, line.fontSize ?? 10))
    }));
  if (regions.length === 0) {
    return {
      x: null,
      y: null,
      width: null,
      height: null
    };
  }
  const minX = Math.min(...regions.map((region) => region.x));
  const maxX = Math.max(...regions.map((region) => region.x + region.width));
  const minY = Math.min(...regions.map((region) => region.y - region.height));
  const maxY = Math.max(...regions.map((region) => region.y));
  return {
    x: roundNumber(minX),
    y: roundNumber(maxY),
    width: roundNumber(maxX - minX),
    height: roundNumber(maxY - minY)
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
  const previousDirection = lineDirection(previous);
  const nextDirection = lineDirection(next);
  const verticalGap = Math.abs(previous.y - next.y);
  if (
    previousDirection === "rtl" &&
    nextDirection === "rtl" &&
    verticalGap <= Math.max(lineRowTolerance(previous), lineRowTolerance(next)) &&
    Math.abs(previous.fontSize - next.fontSize) <= 0.5
  ) {
    return true;
  }

  const aligned =
    previousDirection === "rtl" && nextDirection === "rtl"
      ? Math.abs(lineRightEdge(previous) - lineRightEdge(next)) <= 4
      : Math.abs(previous.x - next.x) <= 4;
  if (!aligned || Math.abs(previous.fontSize - next.fontSize) > 0.5) {
    return false;
  }

  if (verticalGap <= 0 || verticalGap > Math.max(14, previous.fontSize * 1.35)) {
    return false;
  }

  return !endsWithParagraphTerminal(normalizeText(previous.text));
}

function endsWithParagraphTerminal(text) {
  return /[.!?:;)\u3002\uff01\uff1f\uff0e\uff61]$/.test(text);
}

function createRulingTableExports(lines, rulingTables, tableCsvSidecarsByTable = new Map()) {
  const exportsByStart = new Map();
  if (!Array.isArray(rulingTables) || rulingTables.length === 0) {
    return {
      byStart: exportsByStart,
      sourceLineIndexes: new Set()
    };
  }

  const lineIndexes = new Map(lines.map((line, index) => [line, index]));
  for (const table of rulingTables) {
    const tableExport = createRulingTableExport(
      table,
      lineIndexes,
      tableCsvSidecarsByTable?.get(table)?.id
    );
    if (!tableExport) {
      continue;
    }
    const existing = exportsByStart.get(tableExport.startIndex);
    if (!existing || tableExport.sourceLines.length > existing.sourceLines.length) {
      exportsByStart.set(tableExport.startIndex, tableExport);
    }
  }
  const sourceLineIndexes = new Set();
  for (const tableExport of exportsByStart.values()) {
    for (const lineIndex of tableExport.sourceLineIndexes) {
      sourceLineIndexes.add(lineIndex);
    }
  }
  return {
    byStart: exportsByStart,
    sourceLineIndexes
  };
}

function createRulingTableExport(table, lineIndexes, csvSidecarAssetId = null) {
  if (!isRulingTableExportable(table)) {
    return null;
  }

  const hasSpans = hasRulingTableSpans(table);
  const outputAsHtml = hasSpans || table.rows === 1;
  const rows = rulingTableRows(table);
  if (
    rows.length < 1 ||
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

  const lineIndices = sourceLines.map((line) => lineIndexes.get(line)).sort((left, right) => left - right);
  const startIndex = lineIndices[0];
  const endIndex = lineIndices.at(-1) + 1;
  const output = outputAsHtml
    ? createHtmlRulingTableOutput(table, { header: table.rows > 1 })
    : {
        rows: table.rows,
        columns: table.columns,
        markdown: formatMarkdownTableCells(rows)
      };

  return {
    startIndex,
    endIndex,
    pageIndex: table.pageIndex ?? sourceLines[0]?.pageIndex,
    rows: output.rows,
    columns: output.columns,
    output: outputAsHtml ? "html" : "gfm",
    confidence: rulingTableConfidence(hasSpans),
    irRows: rulingTableIrRows(table, rows, { outputAsHtml }),
    csvSidecarAssetId,
    hasSpans,
    numericColumns: numericColumnIndexes(rows),
    markdown: output.markdown,
    sourceLineIndexes: lineIndices,
    sourceLines: [...sourceLines].sort(
      (left, right) => lineIndexes.get(left) - lineIndexes.get(right)
    )
  };
}

function rulingTableIrRows(table, rows, { outputAsHtml }) {
  if (!outputAsHtml) {
    return rows.map((row) =>
      row.map((text) => ({
        text,
        rowSpan: 1,
        colSpan: 1
      }))
    );
  }
  return expandedRulingTableCellRows(table).map((row) =>
    row.map((cell) => ({
      text: normalizeText(cell.text ?? ""),
      rowSpan: Math.max(1, cell.rowSpan ?? 1),
      colSpan: Math.max(1, cell.columnSpan ?? 1)
    }))
  );
}

function rulingTableConfidence(hasSpans) {
  return hasSpans ? 0.9 : 0.95;
}

function isRulingTableExportable(table) {
  return (
    table &&
    Array.isArray(table.cells) &&
    table.rows >= 1 &&
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

function createHtmlRulingTableOutput(table, { header = true } = {}) {
  const rows = expandedRulingTableCellRows(table);
  const columns = rows.reduce((max, row) => Math.max(max, row.length), table.columns);
  return {
    rows: rows.length,
    columns,
    markdown: formatHtmlRulingTableRows(rows, { header })
  };
}

function formatHtmlRulingTableRows(rows, { header = true } = {}) {
  const bodyRows = header ? rows.slice(1) : rows;
  const parts = [
    "<table>",
    "  <tbody>",
    ...bodyRows.map((row) => formatHtmlTableRow(row, "td", "    ")),
    "  </tbody>",
    "</table>"
  ];
  if (header) {
    parts.splice(1, 0, "  <thead>", formatHtmlTableRow(rows[0], "th", "    "), "  </thead>");
  }
  return parts.join("\n");
}

function expandedRulingTableCellRows(table) {
  const cellsByPosition = new Map(
    table.cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell])
  );
  const rows = [];
  for (let rowIndex = 0; rowIndex < table.rows; rowIndex += 1) {
    const rowCells = [];
    for (let columnIndex = 0; columnIndex < table.columns; columnIndex += 1) {
      const cell = cellsByPosition.get(`${rowIndex}:${columnIndex}`);
      if (!cell || cell.coveredBy) {
        continue;
      }
      rowCells.push(cell);
    }

    const visualRows = virtualRowsForRulingCells(table, rowCells);
    if (shouldUseVirtualRows(visualRows)) {
      rows.push(...visualRows);
    } else {
      rows.push(rowCells);
    }
  }
  return rows;
}

function shouldUseVirtualRows(visualRows) {
  return (
    visualRows.length > 1 &&
    visualRows.some((row) => row.filter((cell) => normalizeText(cell.text).length > 0).length >= 2)
  );
}

function virtualRowsForRulingCells(table, cells) {
  const visualLineRows = visualLineRowsForRulingCells(cells);
  return visualLineRows.map((visualRow) => createVirtualRulingTableRow(table, visualRow));
}

function visualLineRowsForRulingCells(cells) {
  const items = [];
  for (const cell of cells) {
    for (const line of cell.lines ?? []) {
      if (normalizeText(line.text ?? "").length === 0) {
        continue;
      }
      items.push({ cell, line });
    }
  }
  const rows = [];
  for (const item of items.sort((left, right) => right.line.y - left.line.y || left.line.x - right.line.x)) {
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
  return rows;
}

function createVirtualRulingTableRow(table, visualRow) {
  const columns = Array.from({ length: table.columns }, () => []);
  const itemsByCell = new Map();
  for (const item of visualRow.items) {
    const cellItems = itemsByCell.get(item.cell) ?? [];
    cellItems.push(item);
    itemsByCell.set(item.cell, cellItems);
  }

  for (const [cell, items] of itemsByCell) {
    const sortedItems = [...items].sort((left, right) => left.line.x - right.line.x);
    const span = Math.max(1, cell.columnSpan ?? 1);
    if (span === 1 && sortedItems.length > 1) {
      for (let index = 0; index < sortedItems.length; index += 1) {
        const columnIndex = Math.min(table.columns - 1, cell.columnIndex + index);
        columns[columnIndex].push(normalizeText(sortedItems[index].line.text));
      }
      continue;
    }

    for (const item of sortedItems) {
      const columnIndex = virtualColumnIndexForLine(table, cell, item.line);
      columns[columnIndex].push(normalizeText(item.line.text));
    }
  }

  return columns.map((parts) => ({
    text: parts.filter(Boolean).join(" "),
    rowSpan: 1,
    columnSpan: 1,
    coveredBy: null
  }));
}

function virtualColumnIndexForLine(table, cell, line) {
  const span = Math.max(1, cell.columnSpan ?? 1);
  const firstColumn = cell.columnIndex;
  const lastColumn = Math.min(table.columns - 1, firstColumn + span - 1);
  const centerColumn = columnIndexForLineCenter(table, line);
  if (centerColumn >= firstColumn && centerColumn <= lastColumn) {
    return centerColumn;
  }
  return firstColumn;
}

function columnIndexForLineCenter(table, line) {
  if (!Array.isArray(table.xEdges) || table.xEdges.length < 2) {
    return 0;
  }
  const center = line.x + Math.max(0, line.width ?? 0) / 2;
  for (let index = 0; index < table.xEdges.length - 1; index += 1) {
    if (center >= table.xEdges[index] - 0.5 && center <= table.xEdges[index + 1] + 0.5) {
      return index;
    }
  }
  return center < table.xEdges[0] ? 0 : table.xEdges.length - 2;
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
      const sourceLine = line.sourceLine ?? line;
      if (seen.has(sourceLine)) {
        continue;
      }
      seen.add(sourceLine);
      sourceLines.push(sourceLine);
    }
  }
  return sourceLines;
}

function readRulingTableAt(index, rulingTableExports) {
  return rulingTableExports.byStart?.get(index) ?? rulingTableExports.get?.(index) ?? null;
}

function isRulingTableSourceLineAt(index, rulingTableExports) {
  return rulingTableExports.sourceLineIndexes?.has(index) ?? false;
}

function readConfidentTableAt(lines, startIndex) {
  const table = readTableAt(lines, startIndex);
  return table && !table.lowConfidence ? table : null;
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
  const numericColumns = numericColumnIndexes(rows);
  if (numericColumns.length === 0) {
    if (isCompactBorderlessTableCandidate(rows)) {
      return {
        rows,
        numericColumns,
        confidence: lowConfidenceBorderlessTableConfidence(rows),
        lowConfidence: true,
        reason: "no-numeric-body-column",
        endIndex: index
      };
    }
    return null;
  }

  return {
    rows,
    numericColumns,
    confidence: borderlessTableConfidence(rows, numericColumns),
    endIndex: index
  };
}

function numericColumnIndexes(rows) {
  const body = rows.slice(1);
  if (body.length === 0) {
    return [];
  }

  return rows[0]
    .map((_, columnIndex) => columnIndex)
    .filter((columnIndex) => {
      const values = body.map((row) => tableCellText(row[columnIndex]));
      return values.length > 0 && values.every(isNumericCell);
    });
}

function borderlessTableConfidence(rows, numericColumns) {
  const numericRatio = numericColumns.length / rows[0].length;
  const rowBonus = rows.length >= 3 ? 0.1 : 0;
  return roundNumber(Math.min(0.85, 0.55 + numericRatio * 0.25 + rowBonus));
}

function lowConfidenceBorderlessTableConfidence(rows) {
  const rowBonus = rows.length >= 3 ? 0.05 : 0;
  return roundNumber(Math.min(0.5, 0.4 + rowBonus));
}

function isCompactBorderlessTableCandidate(rows) {
  if (rows.length < 3 || rows[0].length < 2) {
    return false;
  }

  const firstRowX = rows[0].map((cell) => cell.x).filter(Number.isFinite);
  if (firstRowX.length !== rows[0].length) {
    return false;
  }

  const columnGaps = firstRowX.slice(1).map((x, index) => x - firstRowX[index]);
  return columnGaps.every((gap) => gap > 24 && gap <= 180);
}

function tableCellText(cell) {
  return typeof cell === "string" ? normalizeText(cell) : normalizeText(cell?.text);
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
