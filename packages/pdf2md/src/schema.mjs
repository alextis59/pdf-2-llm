export const schemaVersion = "0.1.0";

export const warningCodes = Object.freeze({
  ConversionNotImplemented: "conversion.not_implemented",
  InvalidPdfHeader: "pdf.invalid_header",
  InputTooLarge: "security.input_too_large",
  PasswordRequired: "security.password_required",
  OcrDisabled: "ocr.disabled",
  WebGpuUnavailable: "webgpu.unavailable",
  HeuristicTextExtraction: "text.heuristic_uncompressed_stream",
  PdfParseFailed: "pdf.parse_failed"
});

export function createWarning(code, message, details = {}) {
  return {
    code,
    message,
    details
  };
}

export function createDocumentIr({ sourceType = "unknown", pages = [] } = {}) {
  return {
    schemaVersion,
    sourceType,
    pages,
    metadata: {},
    assets: [],
    warnings: []
  };
}

export function createPageIr({
  pageIndex,
  widthPt = null,
  heightPt = null,
  rotation = 0,
  sourceType = "unknown",
  elements = []
}) {
  return {
    pageIndex,
    widthPt,
    heightPt,
    rotation,
    sourceType,
    elements
  };
}
