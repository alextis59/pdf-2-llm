import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  createDocumentIr,
  createPageIr,
  createWarning,
  schemaVersion,
  warningCodes
} from "./schema.mjs";
import { isTrustedSimpleEncoding } from "./font-encoding.mjs";
import { extractTextLines, linesToMarkdown } from "./text-extract.mjs";
import { parsePdfDocument, PdfSyntaxError } from "./pdf-parser.mjs";

const defaultSecurityLimits = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxPages: 5000,
  timeoutMs: 120000
});

export { schemaVersion, warningCodes };

export async function convertPdfToMarkdown(input, options = {}) {
  const startedAt = performance.now();
  throwIfAborted(options.signal);
  emitProgress(options, "start", 0);

  const normalized = await normalizeInput(input);
  throwIfAborted(options.signal);

  const security = {
    ...defaultSecurityLimits,
    ...(options.security ?? {})
  };

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
    try {
      pdfDocument = parsePdfDocument(normalized.bytes, {
        maxBytes: security.maxBytes
      });
    } catch (error) {
      if (error instanceof PdfSyntaxError) {
        parseWarning = createWarning(warningCodes.PdfParseFailed, error.message, {
          code: error.code,
          offset: error.offset
        });
        warnings.push(parseWarning);
      } else {
        throw error;
      }
    }
  }

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

  const textLines = pdfVersion ? extractTextLines(normalized.bytes, { document: pdfDocument }) : [];
  const markdown = linesToMarkdown(textLines, {
    pageAnchors: options.markdown?.pageAnchors === true
  });
  warnings.push(...unicodeMappingWarnings(textLines));

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

  const elapsedMs = performance.now() - startedAt;
  const result = {
    markdown,
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
        parser: pdfDocument
          ? {
              mode: "classic-xref",
              objects: pdfDocument.objects.size,
              streams: pdfDocument.streams.length,
              pages: pdfDocument.pages.length,
              startXref: pdfDocument.startXref
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
            fonts: Object.keys(page.resources.fonts)
          }))
        : []
    },
    confidence: {
      overall: textLines.length > 0 ? 0.25 : 0,
      text: textLines.length > 0 ? 0.4 : 0,
      layout: 0,
      tables: 0
    }
  };

  emitProgress(options, "complete", 1);
  return result;
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
    ocrEnabled: options.ocr?.enabled ?? null,
    webgpuRequired: options.webgpu?.required ?? false,
    tablesEnabled: options.tables?.enabled ?? null,
    assetsEnabled: options.assets?.enabled ?? null
  };
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
