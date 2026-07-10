export const schemaVersion = "0.1.0";

const sourceTypes = Object.freeze(["digital", "scanned", "hybrid", "unknown"]);

export const warningCodes = Object.freeze({
  ConversionNotImplemented: "conversion.not_implemented",
  InvalidPdfHeader: "pdf.invalid_header",
  InputTooLarge: "security.input_too_large",
  PageCountExceeded: "security.page_count_exceeded",
  ImagePixelsExceeded: "security.image_pixels_exceeded",
  PasswordRequired: "security.password_required",
  PasswordIncorrect: "security.password_incorrect",
  UnsupportedEncryption: "security.unsupported_encryption",
  OcrDisabled: "ocr.disabled",
  WebGpuUnavailable: "webgpu.unavailable",
  HeuristicTextExtraction: "text.heuristic_content_stream",
  TextUnicodeMappingSuspect: "text.unicode_mapping_suspect",
  TextOrderingUncertain: "text.ordering_uncertain",
  TableLowConfidence: "table.low_confidence",
  EquationLowOcrConfidence: "equation.low_ocr_confidence",
  FigureLowSemanticContent: "figure.low_semantic_content",
  TaggedStructureConflict: "structure.tagged_layout_conflict",
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

export function createMarkdownSourceMap({ entries = [] } = {}) {
  return {
    schemaVersion,
    target: "markdown",
    entries
  };
}

export const warningJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    details: { type: "object" }
  }
});

export const assetJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "path", "mediaType"],
  properties: {
    id: { type: "string" },
    path: { type: "string" },
    mediaType: { type: "string" },
    kind: { type: "string" },
    content: { type: "string" },
    encoding: { enum: ["base64", "utf8"] },
    altText: { type: "string" },
    altTextSource: { type: "string" },
    pageIndex: { type: ["integer", "null"] },
    tableIndex: { type: "integer" }
  }
});

const textSpanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "x", "y", "width", "height", "direction", "confidence", "source"],
  properties: {
    text: { type: "string" },
    glyphIds: { type: "array", items: { type: "integer" } },
    fontName: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    direction: { enum: ["ltr", "rtl", "vertical", "unknown"] },
    confidence: { type: "number" },
    source: { enum: ["pdf-text", "ocr", "tagged-pdf"] }
  }
};

const tableCellJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "rowSpan", "colSpan"],
  properties: {
    text: { type: "string" },
    rowSpan: { type: "integer" },
    colSpan: { type: "integer" }
  }
};

const optionalGeometryProperties = {
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" }
};

export const pageElementJsonSchema = Object.freeze({
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "spans"],
      properties: {
        type: { const: "text" },
        spans: { type: "array", items: textSpanJsonSchema }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "rows", "confidence"],
      properties: {
        type: { const: "table" },
        rows: {
          type: "array",
          items: { type: "array", items: tableCellJsonSchema }
        },
        confidence: { type: "number" },
        htmlFallback: { type: "string" },
        csvSidecarAssetId: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "figure" },
        caption: { type: "string" },
        assetId: { type: "string" },
        altText: { type: "string" },
        altTextSource: { type: "string" },
        ...optionalGeometryProperties
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "equation" },
        text: { type: "string" },
        latex: { type: "string" },
        assetId: { type: "string" },
        ...optionalGeometryProperties
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "name"],
      properties: {
        type: { const: "form-field" },
        name: { type: "string" },
        value: { type: "string" },
        label: { type: ["string", "null"] },
        fieldType: { type: "string" },
        buttonType: { type: "string" },
        checked: { type: "boolean" },
        selectedValue: { type: ["string", "null"] },
        ...optionalGeometryProperties
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "subtype"],
      properties: {
        type: { const: "annotation" },
        subtype: { type: "string" },
        contents: { type: "string" },
        uri: { type: "string" },
        ...optionalGeometryProperties
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "assetId"],
      properties: {
        type: { const: "asset-reference" },
        assetId: { type: "string" }
      }
    }
  ]
});

export const pageIrJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["pageIndex", "widthPt", "heightPt", "rotation", "sourceType", "elements"],
  properties: {
    pageIndex: { type: "integer" },
    widthPt: { type: ["number", "null"] },
    heightPt: { type: ["number", "null"] },
    rotation: { type: "number" },
    sourceType: { enum: sourceTypes },
    elements: {
      type: "array",
      items: pageElementJsonSchema
    }
  }
});

export const documentIrJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.invalid/pdf-2-llm/document-ir.schema.json",
  title: "PDF-to-Markdown Document IR",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sourceType", "pages", "metadata", "assets", "warnings"],
  properties: {
    schemaVersion: { const: schemaVersion },
    sourceType: { enum: sourceTypes },
    pages: {
      type: "array",
      items: pageIrJsonSchema
    },
    metadata: { type: "object" },
    assets: {
      type: "array",
      items: assetJsonSchema
    },
    warnings: {
      type: "array",
      items: warningJsonSchema
    }
  }
});

export const markdownSourceMapJsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.invalid/pdf-2-llm/markdown-source-map.schema.json",
  title: "PDF-to-Markdown Markdown Source Map",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "target", "entries"],
  properties: {
    schemaVersion: { const: schemaVersion },
    target: { const: "markdown" },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["markdownStart", "markdownEnd", "kind", "regions"],
        properties: {
          markdownStart: { type: "integer" },
          markdownEnd: { type: "integer" },
          kind: { type: "string" },
          regions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pageIndex", "x", "y", "width", "height", "source"],
              properties: {
                pageIndex: { type: "integer" },
                x: { type: ["number", "null"] },
                y: { type: ["number", "null"] },
                width: { type: ["number", "null"] },
                height: { type: ["number", "null"] },
                source: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
});
