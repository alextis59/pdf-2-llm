import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  createDocumentIr,
  createMarkdownSourceMap,
  createPageIr,
  createWarning,
  documentIrJsonSchema,
  markdownSourceMapJsonSchema,
  schemaVersion,
  warningCodes
} from "./schema.mjs";
import { isTrustedSimpleEncoding } from "./font-encoding.mjs";
import {
  extractImageDraws,
  extractRulingLines,
  extractTextLines,
  linesToMarkdownWithSourceMap
} from "./text-extract.mjs";
import {
  createFigureAssets,
  createFigureDetections,
  figureElementsByPage,
  insertFigureMarkdown
} from "./figure-detection.mjs";
import { extractDocumentInteractions } from "./document-interactions.mjs";
import {
  assignTextLinesToGridCells,
  detectTableCellSpans,
  inferRulingGrids
} from "./table-grid.mjs";
import { parsePdfDocument, PdfSyntaxError } from "./pdf-parser.mjs";
import { selectOcrAdapter } from "./ocr-adapter.mjs";
import { createOcrLanguageConfig } from "./ocr-language.mjs";
import { createOcrPreprocessingPlan } from "./ocr-preprocess.mjs";
import { reconcileOcrTextLines } from "./ocr-reconcile.mjs";
import { createOcrTextExtraction } from "./ocr-text.mjs";
import { createRasterPlan } from "./raster-plan.mjs";
import { createScanDetection } from "./scan-detection.mjs";
import { detectWebGpuCapabilities } from "./webgpu-capability.mjs";
import { createWebGpuExecutionPlan } from "./webgpu-provider.mjs";

const defaultSecurityLimits = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxPages: 5000,
  maxObjects: 100000,
  maxImagePixels: 100_000_000,
  timeoutMs: 120000
});

export { documentIrJsonSchema, markdownSourceMapJsonSchema, schemaVersion, warningCodes };

export async function convertPdfToMarkdown(input, options = {}) {
  const startedAt = performance.now();
  const security = {
    ...defaultSecurityLimits,
    ...(options.security ?? {})
  };
  validateSecurityLimits(security);
  const deadline = createDeadline(security.timeoutMs, startedAt);
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);
  emitProgress(options, "start", 0);

  const normalized = await normalizeInput(input);
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);

  const warnings = [];
  let inputTooLarge = false;
  if (normalized.bytes.byteLength > security.maxBytes) {
    inputTooLarge = true;
    warnings.push(
      createWarning(warningCodes.InputTooLarge, "Input exceeds configured maxBytes.", {
        maxBytes: security.maxBytes,
        bytes: normalized.bytes.byteLength
      })
    );
  }

  const pdfVersion = readPdfVersion(normalized.bytes);
  if (!pdfVersion) {
    warnings.push(
      createWarning(warningCodes.InvalidPdfHeader, "Input does not start with a PDF header.")
    );
  }

  let pdfDocument = null;
  let parseWarning = null;
  let extractionBlockedBySecurityLimit = inputTooLarge;
  if (inputTooLarge) {
    parseWarning = createInputTooLargeParseWarning(normalized.bytes.byteLength, security.maxBytes);
    warnings.push(parseWarning);
  } else if (pdfVersion) {
    const parserOptions = {
      maxBytes: security.maxBytes,
      maxObjects: security.maxObjects,
      deadline,
      mode: options.parser?.mode ?? "strict"
    };
    try {
      pdfDocument = parsePdfDocument(normalized.bytes, parserOptions);
    } catch (error) {
      if (error instanceof PdfSyntaxError) {
        if (error.code === "pdf.encryption.password_required" && options.password != null) {
          const password = await resolvePasswordOption(options.password);
          throwIfAborted(options.signal);
          throwIfTimedOut(deadline);
          if (password.provided) {
            try {
              pdfDocument = parsePdfDocument(normalized.bytes, {
                ...parserOptions,
                passwordProvided: true,
                password: password.value
              });
            } catch (retryError) {
              if (!(retryError instanceof PdfSyntaxError)) {
                throw retryError;
              }
              parseWarning = createParseWarning(retryError, {
                passwordProvided: true,
                passwordSource: password.source
              });
            }
          } else {
            parseWarning = createParseWarning(error, {
              passwordProvided: false,
              passwordSource: password.source
            });
          }
        } else {
          parseWarning = createParseWarning(error);
        }
        if (parseWarning) {
          warnings.push(parseWarning);
        }
      } else {
        throw error;
      }
    }
    if (pdfDocument && pdfDocument.pages.length > security.maxPages) {
      parseWarning = createPageCountWarning(pdfDocument.pages.length, security.maxPages);
      warnings.push(parseWarning);
      pdfDocument = null;
      extractionBlockedBySecurityLimit = true;
    } else if (isSecurityLimitParseWarning(parseWarning)) {
      extractionBlockedBySecurityLimit = true;
    }
  }
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);

  if (options.ocr?.enabled === false) {
    warnings.push(createWarning(warningCodes.OcrDisabled, "OCR is disabled by options."));
  }

  const webgpuCapabilities = await detectWebGpuCapabilities(options.webgpu ?? {});
  if (options.webgpu?.required === true && webgpuCapabilities.selectedProvider !== "webgpu") {
    warnings.push(
      createWarning(
        warningCodes.WebGpuUnavailable,
        "WebGPU execution is unavailable; CPU fallback was selected.",
        {
          status: webgpuCapabilities.status,
          fallbackReason: webgpuCapabilities.fallbackReason,
          runtime: webgpuCapabilities.runtime,
          selectedProvider: webgpuCapabilities.selectedProvider
        }
      )
    );
  }
  const ocrAdapter = selectOcrAdapter(options.ocr ?? {});

  const encryptedWithoutText =
    parseWarning?.code === warningCodes.PasswordRequired ||
    parseWarning?.code === warningCodes.PasswordIncorrect ||
    parseWarning?.code === warningCodes.UnsupportedEncryption;
  const canExtractPdfContent = pdfVersion && !encryptedWithoutText && !extractionBlockedBySecurityLimit;
  const textLines =
    canExtractPdfContent
      ? extractTextLines(normalized.bytes, { document: pdfDocument })
      : [];
  const rulingLines =
    canExtractPdfContent
      ? extractRulingLines(normalized.bytes, { document: pdfDocument })
      : [];
  const imageDraws =
    canExtractPdfContent
      ? extractImageDraws(normalized.bytes, { document: pdfDocument })
      : [];
  const rulingGrids = inferRulingGrids(rulingLines);
  const rulingTables = detectTableCellSpans(
    assignTextLinesToGridCells(rulingGrids, textLines),
    rulingLines
  );
  const rasterPlan = createRasterPlan(pdfDocument?.pages ?? [], {
    enabled: options.raster?.enabled === true,
    renderer: options.raster?.renderer,
    dpi: options.raster?.dpi,
    thumbnailDpi: options.raster?.thumbnailDpi,
    maxPixels: security.maxImagePixels
  });
  const scanDetection = createScanDetection(pdfDocument?.pages ?? [], {
    textLines,
    imageDraws
  });
  const webgpuExecution = createWebGpuExecutionPlan({
    options: options.webgpu ?? {},
    rasterPlan,
    scanDetection,
    webgpu: webgpuCapabilities
  });
  const ocrLanguage = createOcrLanguageConfig({
    adapter: ocrAdapter,
    options: options.ocr ?? {},
    scanDetection
  });
  const ocrPreprocessing = createOcrPreprocessingPlan({
    adapter: ocrAdapter,
    options: options.ocr?.preprocessing ?? {},
    pages: pdfDocument?.pages ?? [],
    rasterPlan,
    scanDetection
  });
  const ocrTextExtraction = createOcrTextExtraction({
    adapter: ocrAdapter,
    options: options.ocr ?? {},
    pages: pdfDocument?.pages ?? [],
    rasterPlan,
    scanDetection
  });
  const textReconciliation = reconcileOcrTextLines({
    ocrTextLines: ocrTextExtraction.lines,
    pdfTextLines: textLines,
    scanDetection
  });
  const markdownTextLines = textReconciliation.lines;
  const ocrDebugSidecars = createOcrDebugSidecars(ocrTextExtraction.lines, {
    enabled: options.ocr?.debugSidecars === true
  });
  const tableCsvSidecars = createTableCsvSidecars(rulingTables, {
    enabled: options.tables?.enabled !== false && options.tables?.csvSidecars !== false
  });
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);
  let markdownResult = linesToMarkdownWithSourceMap(markdownTextLines, {
    pageAnchors: options.markdown?.pageAnchors === true,
    preserveRunningTitles: options.markdown?.preserveRunningTitles === true,
    rulingTables,
    outlines: pdfDocument?.outlines ?? [],
    equations: {
      imageFallbackConfidence: options.equations?.imageFallbackConfidence,
      formulaOcr: options.equations?.formulaOcr,
      assetIdPrefix: assetSlugFromSource(normalized.source)
    }
  });
  const figureDetections = createFigureDetections({
    imageDraws,
    layout: markdownResult.layout,
    pages: pdfDocument?.pages ?? [],
    rulingLines,
    source: normalized.source
  });
  markdownResult = insertFigureMarkdown(markdownResult, figureDetections.figures);
  const figureAssets = createFigureAssets(figureDetections.figures);
  const equationAssets = createEquationAssets(markdownResult.equations?.equations ?? []);
  const figureElements = figureElementsByPage(figureDetections.figures);
  const equationElements = equationElementsByPage(markdownResult.equations?.equations ?? []);
  const documentInteractions = extractDocumentInteractions(pdfDocument, {
    extractAttachmentAssets: options.attachments?.extract === true
  });
  const assets = [
    ...tableCsvSidecars.assets,
    ...ocrDebugSidecars.assets,
    ...equationAssets,
    ...figureAssets,
    ...documentInteractions.assets
  ];
  const markdown = markdownResult.markdown;
  const sourceMap = createMarkdownSourceMap(markdownResult.sourceMap);
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);
  warnings.push(...unicodeMappingWarnings(textLines));
  warnings.push(...textOrderingWarnings(markdownTextLines));
  warnings.push(...taggedStructureConflictWarnings(markdownResult.taggedStructureConflicts));
  warnings.push(...lowConfidenceTableWarnings(markdownResult.lowConfidenceTables));
  warnings.push(...equationImageFallbackWarnings(markdownResult.equations?.equations ?? []));
  warnings.push(...lowSemanticFigureWarnings(figureDetections.figures));
  warnings.push(...rasterPixelLimitWarnings(rasterPlan));

  if (textReconciliation.diagnostics.selectedPdfTextLines > 0) {
    warnings.push(
      createWarning(
        warningCodes.HeuristicTextExtraction,
        pdfDocument
          ? "Text was extracted from parsed content streams."
          : "Text was extracted with the fallback uncompressed-stream scanner."
      )
    );
  } else if (ocrTextExtraction.lines.length === 0) {
    warnings.push(
      createWarning(
        warningCodes.ConversionNotImplemented,
        "The scaffold validates input and returns contracts, but PDF conversion is not implemented yet."
      )
    );
  }

  const scanPagesByIndex = new Map(
    scanDetection.pages.map((page) => [page.pageIndex, page])
  );
  const ir = createDocumentIr({
    sourceType: pdfDocument?.pages?.length
      ? scanDetection.sourceType
      : pdfVersion
        ? "digital"
        : "unknown"
  });
  if (pdfDocument?.pages) {
    ir.pages = pdfDocument.pages.map((page) =>
      createPageIr({
        pageIndex: page.pageIndex,
        widthPt: page.widthPt,
        heightPt: page.heightPt,
        rotation: page.rotation,
        sourceType: scanPagesByIndex.get(page.pageIndex)?.sourceType ?? "unknown",
        elements: [
          ...(ocrTextExtraction.elementsByPage.get(page.pageIndex) ?? []),
          ...(equationElements.get(page.pageIndex) ?? []),
          ...(figureElements.get(page.pageIndex) ?? []),
          ...(documentInteractions.elementsByPage.get(page.pageIndex) ?? [])
        ]
      })
    );
  }
  ir.assets = assets;
  ir.warnings = warnings;
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);

  const elapsedMs = performance.now() - startedAt;
  const result = {
    markdown,
    sourceMap,
    assets,
    ir,
    warnings,
    diagnostics: {
      schemaVersion,
      input: {
        bytes: normalized.bytes.byteLength,
        sha256: sha256(normalized.bytes),
        source: normalized.source,
        pdfVersion
      },
      options: summarizeOptions(options, rasterPlan, ocrAdapter, security),
      timing: {
        elapsedMs
      },
      acceleration: {
        webgpu: {
          ...webgpuCapabilities,
          execution: webgpuExecution
        }
      },
      extraction: {
        textLines: markdownTextLines.length,
        mode: extractionMode({
          ocrTextLines: textReconciliation.diagnostics.selectedOcrTextLines,
          pdfDocument,
          textLines: textReconciliation.diagnostics.selectedPdfTextLines
        }),
        outlines: pdfDocument?.outlines ?? [],
        structure: summarizeStructure(pdfDocument?.structure),
        taggedStructureConflicts: markdownResult.taggedStructureConflicts.length,
        layout: markdownResult.layout,
        ocr: {
          ...ocrAdapter,
          language: ocrLanguage,
          preprocessing: ocrPreprocessing,
          reconciliation: textReconciliation.diagnostics,
          sidecars: ocrDebugSidecars.diagnostics,
          textBoxes: ocrTextExtraction.diagnostics
        },
        tables: markdownResult.tables,
        lowConfidenceTables: markdownResult.lowConfidenceTables,
        raster: rasterPlan,
        scanDetection,
        rulingLines: summarizeRulingLines(rulingLines),
        rulingGrids: summarizeRulingGrids(rulingGrids),
        rulingTables: summarizeRulingTables(rulingTables, tableCsvSidecars.byTable),
        equations: markdownResult.equations,
        figures: figureDetections,
        forms: documentInteractions.forms,
        annotations: documentInteractions.annotations,
        attachments: documentInteractions.attachments,
        signatures: documentInteractions.signatures,
        parser: pdfDocument
          ? {
              mode: pdfDocument.xrefMode,
              objects: pdfDocument.objects.size,
              streams: pdfDocument.streams.length,
              pages: pdfDocument.pages.length,
              startXref: pdfDocument.startXref,
              repaired: pdfDocument.repaired,
              repairReason: pdfDocument.repairReason
            }
          : {
              mode: parseWarning ? "unavailable" : "not-run",
              warning: parseWarning?.details ?? null
            }
      },
      pages: pdfDocument
        ? pdfDocument.pages.map((page) => ({
            pageIndex: page.pageIndex,
            objectNumber: page.objectNumber,
            widthPt: page.widthPt,
            heightPt: page.heightPt,
            rotation: page.rotation,
            userUnit: page.userUnit,
            mediaBox: page.mediaBox,
            cropBox: page.cropBox,
            contentStreams: page.contentStreams.length,
            fonts: Object.keys(page.resources.fonts),
            images: summarizePageImages(page)
          }))
        : []
    },
    confidence: {
      overall: markdownTextLines.length > 0 ? 0.25 : 0,
      text: textConfidence({ ocrTextExtraction, textReconciliation }),
      layout: markdownResult.layout.pages.length > 0 ? 0.35 : 0,
      tables: tableConfidence(markdownResult.tables)
    }
  };

  emitProgress(options, "complete", 1);
  return result;
}

function summarizePageImages(page) {
  return Object.entries(page.resources.xobjects ?? {})
    .filter(([, xobject]) => xobject.subtype === "Image")
    .map(([name, image]) => ({
      name,
      objectNumber: image.objectNumber,
      width: image.width,
      height: image.height,
      bitsPerComponent: image.bitsPerComponent,
      colorSpace: image.colorSpace,
      filters: image.filters,
      skippedFilters: image.skippedFilters.map((item) => item.filter),
      mediaType: image.mediaType,
      rawLength: image.rawLength,
      decodedLength: image.decodedLength
    }));
}

function equationElementsByPage(equations) {
  const byPage = new Map();
  for (const equation of equations) {
    if (!Number.isInteger(equation.pageIndex)) {
      continue;
    }
    const elements = byPage.get(equation.pageIndex) ?? [];
    const element = {
      type: "equation",
      text: equation.text
    };
    for (const key of ["latex", "assetId", "x", "y", "width", "height"]) {
      if (equation[key] != null) {
        element[key] = equation[key];
      }
    }
    elements.push(element);
    byPage.set(equation.pageIndex, elements);
  }
  return byPage;
}

function createEquationAssets(equations) {
  return equations
    .filter((equation) => equation.output === "image" && equation.assetId && equation.assetPath)
    .map((equation) => ({
      id: equation.assetId,
      kind: "equation-preview",
      path: equation.assetPath,
      mediaType: equation.assetMediaType ?? "image/png",
      pageIndex: equation.pageIndex
    }));
}

function summarizeRulingLines(rulingLines) {
  const pages = new Map();
  for (const line of rulingLines) {
    const pageIndex = line.pageIndex ?? null;
    const page = pages.get(pageIndex) ?? {
      pageIndex,
      total: 0,
      horizontal: 0,
      vertical: 0
    };
    page.total += 1;
    if (line.orientation === "horizontal") {
      page.horizontal += 1;
    }
    if (line.orientation === "vertical") {
      page.vertical += 1;
    }
    pages.set(pageIndex, page);
  }

  return {
    total: rulingLines.length,
    horizontal: rulingLines.filter((line) => line.orientation === "horizontal").length,
    vertical: rulingLines.filter((line) => line.orientation === "vertical").length,
    pages: [...pages.values()].sort((left, right) => {
      if (left.pageIndex === null) {
        return 1;
      }
      if (right.pageIndex === null) {
        return -1;
      }
      return left.pageIndex - right.pageIndex;
    })
  };
}

function summarizeRulingGrids(rulingGrids) {
  const pages = new Map();
  for (const grid of rulingGrids) {
    const pageIndex = grid.pageIndex ?? null;
    const page = pages.get(pageIndex) ?? {
      pageIndex,
      total: 0,
      complete: 0,
      grids: []
    };
    page.total += 1;
    if (grid.complete) {
      page.complete += 1;
    }
    page.grids.push({
      rows: grid.rows,
      columns: grid.columns,
      cells: grid.cells,
      x1: grid.x1,
      y1: grid.y1,
      x2: grid.x2,
      y2: grid.y2,
      complete: grid.complete
    });
    pages.set(pageIndex, page);
  }

  return {
    total: rulingGrids.length,
    complete: rulingGrids.filter((grid) => grid.complete).length,
    pages: [...pages.values()].sort((left, right) => {
      if (left.pageIndex === null) {
        return 1;
      }
      if (right.pageIndex === null) {
        return -1;
      }
      return left.pageIndex - right.pageIndex;
    })
  };
}

function createTableCsvSidecars(rulingTables, options = {}) {
  const assets = [];
  const byTable = new Map();
  if (options.enabled === false) {
    return { assets, byTable };
  }

  const tableCountsByPage = new Map();
  for (const table of rulingTables) {
    const pageKey = table.pageIndex ?? "unknown";
    const tableNumber = (tableCountsByPage.get(pageKey) ?? 0) + 1;
    tableCountsByPage.set(pageKey, tableNumber);
    const pageLabel = Number.isInteger(table.pageIndex) ? `page-${table.pageIndex + 1}` : "page-unknown";
    const id = `table-${pageLabel}-${tableNumber}-csv`;
    const asset = {
      id,
      kind: "table-csv",
      path: `assets/${id}.csv`,
      mediaType: "text/csv",
      content: serializeRulingTableCsv(table),
      pageIndex: table.pageIndex ?? null,
      tableIndex: table.gridIndex ?? tableNumber - 1
    };
    assets.push(asset);
    byTable.set(table, asset);
  }

  return { assets, byTable };
}

function serializeRulingTableCsv(table) {
  return rulingTableCsvRows(table)
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n") + "\n";
}

function rulingTableCsvRows(table) {
  const cellsByPosition = new Map(
    table.cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell])
  );
  const rows = [];
  for (let rowIndex = 0; rowIndex < table.rows; rowIndex += 1) {
    const row = [];
    for (let columnIndex = 0; columnIndex < table.columns; columnIndex += 1) {
      const cell = cellsByPosition.get(`${rowIndex}:${columnIndex}`);
      row.push(cell && !cell.coveredBy ? normalizeCellText(cell.text) : "");
    }
    rows.push(row);
  }
  return rows;
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeCellText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function tableConfidence(tables) {
  if (!Array.isArray(tables) || tables.length === 0) {
    return 0;
  }
  const total = tables.reduce((sum, table) => sum + (table.confidence ?? 0), 0);
  return Number((total / tables.length).toFixed(3));
}

function summarizeRulingTables(rulingTables, csvSidecarsByTable = new Map()) {
  const pages = new Map();
  for (const table of rulingTables) {
    const csvSidecar = csvSidecarsByTable.get(table) ?? null;
    const pageIndex = table.pageIndex ?? null;
    const page = pages.get(pageIndex) ?? {
      pageIndex,
      total: 0,
      assignedTextLines: 0,
      nonEmptyCells: 0,
      rowSpans: 0,
      columnSpans: 0,
      coveredCells: 0,
      csvSidecars: 0,
      tables: []
    };
    page.total += 1;
    page.assignedTextLines += table.assignedTextLines;
    page.nonEmptyCells += table.nonEmptyCells;
    page.rowSpans += table.rowSpans;
    page.columnSpans += table.columnSpans;
    page.coveredCells += table.coveredCells;
    if (csvSidecar) {
      page.csvSidecars += 1;
    }
    page.tables.push({
      rows: table.rows,
      columns: table.columns,
      assignedTextLines: table.assignedTextLines,
      nonEmptyCells: table.nonEmptyCells,
      rowSpans: table.rowSpans,
      columnSpans: table.columnSpans,
      coveredCells: table.coveredCells,
      hasSpans: table.hasSpans,
      csvSidecarAssetId: csvSidecar?.id ?? null,
      cells: table.cells
        .filter((cell) => !cell.coveredBy && (cell.lineCount > 0 || cell.rowSpan > 1 || cell.columnSpan > 1))
        .map((cell) => ({
          rowIndex: cell.rowIndex,
          columnIndex: cell.columnIndex,
          text: cell.text,
          lineCount: cell.lineCount,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan
        }))
    });
    pages.set(pageIndex, page);
  }

  return {
    total: rulingTables.length,
    assignedTextLines: rulingTables.reduce((sum, table) => sum + table.assignedTextLines, 0),
    nonEmptyCells: rulingTables.reduce((sum, table) => sum + table.nonEmptyCells, 0),
    rowSpans: rulingTables.reduce((sum, table) => sum + table.rowSpans, 0),
    columnSpans: rulingTables.reduce((sum, table) => sum + table.columnSpans, 0),
    coveredCells: rulingTables.reduce((sum, table) => sum + table.coveredCells, 0),
    csvSidecars: rulingTables.filter((table) => csvSidecarsByTable.has(table)).length,
    pages: [...pages.values()].sort((left, right) => {
      if (left.pageIndex === null) {
        return 1;
      }
      if (right.pageIndex === null) {
        return -1;
      }
      return left.pageIndex - right.pageIndex;
    })
  };
}

function summarizeStructure(structure) {
  return {
    tagged: structure?.tagged === true,
    roleMap: structure?.roleMap ?? {},
    elements: structure?.elements?.length ?? 0,
    markedContent: structure?.markedContent?.length ?? 0,
    roles: summarizeStructureRoles(structure?.elements ?? [])
  };
}

function summarizeStructureRoles(elements) {
  const counts = {};
  for (const element of elements) {
    if (!element.role) {
      continue;
    }
    counts[element.role] = (counts[element.role] ?? 0) + 1;
  }
  return counts;
}

function unicodeMappingWarnings(textLines) {
  const warnings = [];
  const seen = new Set();
  for (const line of textLines) {
    const font = line.font;
    if (!font || font.hasToUnicode || isTrustedSimpleEncoding(font)) {
      continue;
    }

    const key = `${line.pageIndex ?? ""}:${line.fontName ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    warnings.push(
      createWarning(
        warningCodes.TextUnicodeMappingSuspect,
        "Text was extracted from a font without a trusted Unicode map.",
        {
          pageIndex: line.pageIndex,
          fontName: line.fontName,
          baseFont: font.baseFont,
          encoding: font.encoding
        }
      )
    );
  }
  return warnings;
}

function textOrderingWarnings(textLines) {
  const warnings = [];
  const seenPages = new Set();
  for (let index = 1; index < textLines.length; index += 1) {
    const previous = textLines[index - 1];
    const current = textLines[index];
    if (
      !samePage(previous, current) ||
      seenPages.has(current.pageIndex) ||
      !Number.isFinite(previous.x) ||
      !Number.isFinite(previous.y) ||
      !Number.isFinite(current.x) ||
      !Number.isFinite(current.y)
    ) {
      continue;
    }

    const upwardJump = current.y - previous.y;
    const horizontalShift = Math.abs(current.x - previous.x);
    if (upwardJump > Math.max(6, current.fontSize * 0.5) && horizontalShift > 96) {
      seenPages.add(current.pageIndex);
      warnings.push(
        createWarning(
          warningCodes.TextOrderingUncertain,
          "Text order may require layout analysis beyond content stream order.",
          {
            pageIndex: current.pageIndex,
            previous: {
              text: previous.text,
              x: previous.x,
              y: previous.y
            },
            current: {
              text: current.text,
              x: current.x,
              y: current.y
            }
          }
        )
      );
    }
  }
  return warnings;
}

function taggedStructureConflictWarnings(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return [];
  }
  return [
    createWarning(
      warningCodes.TaggedStructureConflict,
      "Tagged PDF structure conflicts with visible layout; affected tag signals were ignored.",
      {
        conflicts: conflicts.length,
        samples: conflicts.slice(0, 5)
      }
    )
  ];
}

function lowConfidenceTableWarnings(tables) {
  if (!Array.isArray(tables) || tables.length === 0) {
    return [];
  }

  return tables.map((table) =>
    createWarning(
      warningCodes.TableLowConfidence,
      "Potential table was preserved as text because table confidence was low.",
      table
    )
  );
}

function equationImageFallbackWarnings(equations) {
  return equations
    .filter((equation) => equation.output === "image")
    .map((equation) =>
      createWarning(
        warningCodes.EquationLowOcrConfidence,
        "Equation OCR confidence was low; the equation was preserved as an image asset.",
        {
          equationIndex: equation.equationIndex,
          pageIndex: equation.pageIndex,
          assetId: equation.assetId,
          confidence: equation.confidence,
          threshold: equation.fallbackThreshold,
          reason: equation.fallbackReason
        }
      )
    );
}

function lowSemanticFigureWarnings(figures) {
  return figures.map((figure) =>
    createWarning(
      warningCodes.FigureLowSemanticContent,
      "Figure was preserved as a visual asset; semantic chart or diagram data was not inferred.",
      {
        figureIndex: figure.figureIndex,
        pageIndex: figure.pageIndex,
        assetId: figure.assetId,
        kind: figure.kind,
        caption: figure.caption,
        reason: "visual-preview-only"
      }
    )
  );
}

function assetSlugFromSource(source) {
  if (source?.type === "path" && typeof source.value === "string") {
    const basename = source.value.split(/[\\/]/).pop() ?? "document";
    return slugifyAssetPrefix(basename.replace(/\.pdf$/i, ""));
  }
  return "document";
}

function slugifyAssetPrefix(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function samePage(left, right) {
  return (left.pageIndex ?? null) === (right.pageIndex ?? null);
}

async function normalizeInput(input) {
  if (typeof input === "string") {
    return {
      bytes: new Uint8Array(await readFile(input)),
      source: {
        type: "path",
        value: input
      }
    };
  }

  if (input instanceof ArrayBuffer) {
    return {
      bytes: new Uint8Array(input),
      source: {
        type: "array-buffer"
      }
    };
  }

  if (ArrayBuffer.isView(input)) {
    return {
      bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
      source: {
        type: "uint8-array"
      }
    };
  }

  if (input && ArrayBuffer.isView(input.bytes)) {
    return {
      bytes: new Uint8Array(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      source: {
        type: input.sourceType ?? "object"
      }
    };
  }

  throw new TypeError("input must be a path, ArrayBuffer, Uint8Array, or object with bytes");
}

function readPdfVersion(bytes) {
  if (bytes.byteLength < 8) {
    return null;
  }
  const header = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 32))).toString("ascii");
  const match = header.match(/^%PDF-(\d\.\d)/);
  return match ? match[1] : null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function summarizeOptions(options, rasterPlan, ocrAdapter, security) {
  return {
    pageRange: options.pageRange ?? null,
    output: options.output ?? "markdown",
    pageAnchors: options.markdown?.pageAnchors === true,
    preserveRunningTitles: options.markdown?.preserveRunningTitles === true,
    parserMode: options.parser?.mode ?? "strict",
    passwordProvided: options.password != null,
    ocrEnabled: ocrAdapter.enabled,
    ocrAdapter: ocrAdapter.adapter?.id ?? ocrAdapter.requested,
    ocrAdapterStatus: ocrAdapter.status,
    ocrLanguages: ocrAdapter.languages,
    webgpuRequired: options.webgpu?.required ?? false,
    webgpuPreferred: options.webgpu?.preferred ?? false,
    tablesEnabled: options.tables?.enabled ?? null,
    tableCsvSidecars:
      options.tables?.enabled === false ? false : options.tables?.csvSidecars ?? true,
    rasterEnabled: options.raster?.enabled === true,
    rasterRenderer: options.raster?.renderer ?? "internal-page-geometry",
    rasterDpi: rasterPlan.dpi,
    rasterThumbnailDpi: rasterPlan.thumbnailDpi,
    maxBytes: security.maxBytes,
    maxPages: security.maxPages,
    maxObjects: security.maxObjects,
    maxImagePixels: rasterPlan.maxPixels,
    ocrDebugSidecars: options.ocr?.debugSidecars === true,
    assetsEnabled: options.assets?.enabled ?? null
  };
}

function createOcrDebugSidecars(ocrTextLines, options = {}) {
  const assets = [];
  const pages = [];
  if (options.enabled !== true) {
    return {
      assets,
      diagnostics: {
        enabled: false,
        assets: 0,
        pages
      }
    };
  }

  const linesByPage = groupLinesByPage(ocrTextLines);
  for (const [pageIndex, lines] of linesByPage) {
    const pageLabel = Number.isInteger(pageIndex) ? `page-${pageIndex + 1}` : "page-unknown";
    const id = `ocr-${pageLabel}-json`;
    const boxes = lines.map(ocrLineToDebugBox);
    assets.push({
      id,
      kind: "ocr-debug-json",
      path: `assets/${id}.json`,
      mediaType: "application/json",
      content: JSON.stringify({ pageIndex, boxes }, null, 2),
      pageIndex
    });
    pages.push({
      pageIndex,
      assetId: id,
      boxes: boxes.length
    });
  }

  return {
    assets,
    diagnostics: {
      enabled: true,
      assets: assets.length,
      pages
    }
  };
}

function groupLinesByPage(lines) {
  const pages = new Map();
  for (const line of lines) {
    const pageIndex = Number.isInteger(line.pageIndex) ? line.pageIndex : null;
    const pageLines = pages.get(pageIndex) ?? [];
    pageLines.push(line);
    pages.set(pageIndex, pageLines);
  }
  return new Map(
    [...pages.entries()].sort(([left], [right]) => {
      if (left === null) {
        return 1;
      }
      if (right === null) {
        return -1;
      }
      return left - right;
    })
  );
}

function ocrLineToDebugBox(line) {
  return {
    text: line.text,
    confidence: line.confidence,
    x: line.x,
    y: line.y,
    width: line.width,
    height: line.height,
    direction: line.direction ?? "unknown",
    language: line.language ?? null,
    coordinateSpace: line.coordinateSpace ?? "page"
  };
}

function extractionMode({ ocrTextLines, pdfDocument, textLines }) {
  if (textLines > 0 && ocrTextLines > 0) {
    return pdfDocument ? "parsed-content-streams+ocr" : "fallback-uncompressed-stream-scan+ocr";
  }
  if (textLines > 0) {
    return pdfDocument ? "parsed-content-streams" : "fallback-uncompressed-stream-scan";
  }
  return ocrTextLines > 0 ? "ocr" : "none";
}

function textConfidence({ ocrTextExtraction, textReconciliation }) {
  if (textReconciliation.diagnostics.selectedPdfTextLines > 0) {
    return 0.4;
  }
  return ocrTextExtraction.diagnostics.averageConfidence ?? 0;
}

function rasterPixelLimitWarnings(rasterPlan) {
  if (!rasterPlan.enabled || (rasterPlan.limitedPages === 0 && rasterPlan.limitedThumbnails === 0)) {
    return [];
  }

  const pageWarnings = rasterPlan.pages
    .filter((page) => page.exceedsPixelLimit)
    .map((page) =>
      createWarning(
        warningCodes.ImagePixelsExceeded,
        "Page raster target exceeds configured maxImagePixels and was skipped.",
        {
          pageIndex: page.pageIndex,
          widthPx: page.widthPx,
          heightPx: page.heightPx,
          pixelCount: page.pixelCount,
          maxImagePixels: page.maxPixels,
          dpi: page.dpi,
          target: "page"
        }
      )
    );

  const thumbnailWarnings = rasterPlan.pages
    .filter((page) => page.thumbnail.exceedsPixelLimit)
    .map((page) =>
      createWarning(
        warningCodes.ImagePixelsExceeded,
        "Page thumbnail raster target exceeds configured maxImagePixels and was skipped.",
        {
          pageIndex: page.pageIndex,
          widthPx: page.thumbnail.widthPx,
          heightPx: page.thumbnail.heightPx,
          pixelCount: page.thumbnail.pixelCount,
          maxImagePixels: page.thumbnail.maxPixels,
          dpi: page.thumbnail.dpi,
          target: "thumbnail"
        }
      )
    );

  return [...pageWarnings, ...thumbnailWarnings];
}

function createParseWarning(error, extraDetails = {}) {
  if (error.code === "pdf.encryption.password_required") {
    return createWarning(warningCodes.PasswordRequired, error.message, {
      code: error.code,
      offset: error.offset,
      ...extraDetails
    });
  }

  if (error.code === "pdf.encryption.password_incorrect") {
    return createWarning(warningCodes.PasswordIncorrect, error.message, {
      code: error.code,
      offset: error.offset,
      ...extraDetails
    });
  }

  if (error.code === "pdf.encryption.unsupported") {
    return createWarning(warningCodes.UnsupportedEncryption, error.message, {
      code: error.code,
      offset: error.offset,
      ...extraDetails
    });
  }

  return createWarning(warningCodes.PdfParseFailed, error.message, {
    code: error.code,
    offset: error.offset,
    ...extraDetails
  });
}

function createInputTooLargeParseWarning(bytes, maxBytes) {
  return createWarning(warningCodes.PdfParseFailed, "PDF input exceeds parser byte limit.", {
    code: "pdf.input_too_large",
    offset: maxBytes,
    bytes,
    maxBytes
  });
}

function createPageCountWarning(pages, maxPages) {
  return createWarning(
    warningCodes.PageCountExceeded,
    "PDF page count exceeds configured maxPages.",
    {
      code: warningCodes.PageCountExceeded,
      pages,
      maxPages
    }
  );
}

function isSecurityLimitParseWarning(warning) {
  return (
    warning?.details?.code === "pdf.input_too_large" ||
    warning?.details?.code === "pdf.object_limit_exceeded" ||
    warning?.details?.code === warningCodes.PageCountExceeded
  );
}

async function resolvePasswordOption(passwordOption) {
  if (typeof passwordOption === "string") {
    return {
      provided: true,
      source: "string",
      value: passwordOption
    };
  }

  if (typeof passwordOption === "function") {
    const value = await passwordOption({ reason: "encrypted-pdf" });
    return {
      provided: typeof value === "string",
      source: "callback",
      value: typeof value === "string" ? value : null
    };
  }

  throw new TypeError("options.password must be a string or function");
}

function emitProgress(options, stage, progress) {
  if (typeof options.onProgress === "function") {
    options.onProgress({ stage, progress });
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
}

function validateSecurityLimits(security) {
  if (!Number.isInteger(security.maxPages) || security.maxPages < 0) {
    throw new RangeError("security.maxPages must be a non-negative integer");
  }
}

function createDeadline(timeoutMs, startedAt) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("security.timeoutMs must be a non-negative finite number");
  }
  return startedAt + timeoutMs;
}

function throwIfTimedOut(deadline) {
  if (performance.now() >= deadline) {
    throw new DOMException("Operation timed out", "TimeoutError");
  }
}
