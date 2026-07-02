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
  extractRulingLines,
  extractTextLines,
  linesToMarkdownWithSourceMap
} from "./text-extract.mjs";
import {
  assignTextLinesToGridCells,
  detectTableCellSpans,
  inferRulingGrids
} from "./table-grid.mjs";
import { parsePdfDocument, PdfSyntaxError } from "./pdf-parser.mjs";

const defaultSecurityLimits = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxPages: 5000,
  maxObjects: 100000,
  timeoutMs: 120000
});

export { documentIrJsonSchema, markdownSourceMapJsonSchema, schemaVersion, warningCodes };

export async function convertPdfToMarkdown(input, options = {}) {
  const startedAt = performance.now();
  const security = {
    ...defaultSecurityLimits,
    ...(options.security ?? {})
  };
  const deadline = createDeadline(security.timeoutMs, startedAt);
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);
  emitProgress(options, "start", 0);

  const normalized = await normalizeInput(input);
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);

  const warnings = [];
  if (normalized.bytes.byteLength > security.maxBytes) {
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
  if (pdfVersion) {
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
  }
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);

  if (options.ocr?.enabled === false) {
    warnings.push(createWarning(warningCodes.OcrDisabled, "OCR is disabled by options."));
  }

  if (options.webgpu?.required === true) {
    warnings.push(
      createWarning(
        warningCodes.WebGpuUnavailable,
        "WebGPU execution is not available in the scaffold implementation."
      )
    );
  }

  const encryptedWithoutText =
    parseWarning?.code === warningCodes.PasswordRequired ||
    parseWarning?.code === warningCodes.PasswordIncorrect ||
    parseWarning?.code === warningCodes.UnsupportedEncryption;
  const textLines =
    pdfVersion && !encryptedWithoutText
      ? extractTextLines(normalized.bytes, { document: pdfDocument })
      : [];
  const rulingLines =
    pdfVersion && !encryptedWithoutText
      ? extractRulingLines(normalized.bytes, { document: pdfDocument })
      : [];
  const rulingGrids = inferRulingGrids(rulingLines);
  const rulingTables = detectTableCellSpans(
    assignTextLinesToGridCells(rulingGrids, textLines),
    rulingLines
  );
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);
  const markdownResult = linesToMarkdownWithSourceMap(textLines, {
    pageAnchors: options.markdown?.pageAnchors === true,
    preserveRunningTitles: options.markdown?.preserveRunningTitles === true,
    rulingTables,
    outlines: pdfDocument?.outlines ?? []
  });
  const markdown = markdownResult.markdown;
  const sourceMap = createMarkdownSourceMap(markdownResult.sourceMap);
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);
  warnings.push(...unicodeMappingWarnings(textLines));
  warnings.push(...textOrderingWarnings(textLines));
  warnings.push(...taggedStructureConflictWarnings(markdownResult.taggedStructureConflicts));

  if (textLines.length > 0) {
    warnings.push(
      createWarning(
        warningCodes.HeuristicTextExtraction,
        pdfDocument
          ? "Text was extracted from parsed content streams."
          : "Text was extracted with the fallback uncompressed-stream scanner."
      )
    );
  } else {
    warnings.push(
      createWarning(
        warningCodes.ConversionNotImplemented,
        "The scaffold validates input and returns contracts, but PDF conversion is not implemented yet."
      )
    );
  }

  const ir = createDocumentIr({ sourceType: pdfVersion ? "digital" : "unknown" });
  if (pdfDocument?.pages) {
    ir.pages = pdfDocument.pages.map((page) =>
      createPageIr({
        pageIndex: page.pageIndex,
        widthPt: page.widthPt,
        heightPt: page.heightPt,
        rotation: page.rotation,
        sourceType: "digital",
        elements: []
      })
    );
  }
  ir.warnings = warnings;
  throwIfAborted(options.signal);
  throwIfTimedOut(deadline);

  const elapsedMs = performance.now() - startedAt;
  const result = {
    markdown,
    sourceMap,
    assets: [],
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
      options: summarizeOptions(options),
      timing: {
        elapsedMs
      },
      extraction: {
        textLines: textLines.length,
        mode:
          textLines.length > 0
            ? pdfDocument
              ? "parsed-content-streams"
              : "fallback-uncompressed-stream-scan"
            : "none",
        outlines: pdfDocument?.outlines ?? [],
        structure: summarizeStructure(pdfDocument?.structure),
        taggedStructureConflicts: markdownResult.taggedStructureConflicts.length,
        layout: markdownResult.layout,
        rulingLines: summarizeRulingLines(rulingLines),
        rulingGrids: summarizeRulingGrids(rulingGrids),
        rulingTables: summarizeRulingTables(rulingTables),
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
      overall: textLines.length > 0 ? 0.25 : 0,
      text: textLines.length > 0 ? 0.4 : 0,
      layout: markdownResult.layout.pages.length > 0 ? 0.35 : 0,
      tables: 0
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

function summarizeRulingTables(rulingTables) {
  const pages = new Map();
  for (const table of rulingTables) {
    const pageIndex = table.pageIndex ?? null;
    const page = pages.get(pageIndex) ?? {
      pageIndex,
      total: 0,
      assignedTextLines: 0,
      nonEmptyCells: 0,
      rowSpans: 0,
      columnSpans: 0,
      coveredCells: 0,
      tables: []
    };
    page.total += 1;
    page.assignedTextLines += table.assignedTextLines;
    page.nonEmptyCells += table.nonEmptyCells;
    page.rowSpans += table.rowSpans;
    page.columnSpans += table.columnSpans;
    page.coveredCells += table.coveredCells;
    page.tables.push({
      rows: table.rows,
      columns: table.columns,
      assignedTextLines: table.assignedTextLines,
      nonEmptyCells: table.nonEmptyCells,
      rowSpans: table.rowSpans,
      columnSpans: table.columnSpans,
      coveredCells: table.coveredCells,
      hasSpans: table.hasSpans,
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

function summarizeOptions(options) {
  return {
    pageRange: options.pageRange ?? null,
    output: options.output ?? "markdown",
    pageAnchors: options.markdown?.pageAnchors === true,
    preserveRunningTitles: options.markdown?.preserveRunningTitles === true,
    parserMode: options.parser?.mode ?? "strict",
    passwordProvided: options.password != null,
    ocrEnabled: options.ocr?.enabled ?? null,
    webgpuRequired: options.webgpu?.required ?? false,
    tablesEnabled: options.tables?.enabled ?? null,
    assetsEnabled: options.assets?.enabled ?? null
  };
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
