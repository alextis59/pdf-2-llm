export type SourceType = "digital" | "scanned" | "hybrid" | "unknown";

export type Warning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type PageIr = {
  pageIndex: number;
  widthPt: number | null;
  heightPt: number | null;
  rotation: number;
  sourceType: SourceType;
  elements: unknown[];
};

export type DocumentIr = {
  schemaVersion: typeof schemaVersion;
  sourceType: SourceType;
  pages: PageIr[];
  metadata: Record<string, unknown>;
  assets: unknown[];
  warnings: Warning[];
};

export type SourceRegion = {
  pageIndex: number;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  source: string;
};

export type MarkdownSourceMapEntry = {
  markdownStart: number;
  markdownEnd: number;
  kind: string;
  regions: SourceRegion[];
};

export type MarkdownSourceMap = {
  schemaVersion: typeof schemaVersion;
  target: "markdown";
  entries: MarkdownSourceMapEntry[];
};

export declare const schemaVersion: "0.1.0";

export declare const warningCodes: Readonly<{
  ConversionNotImplemented: "conversion.not_implemented";
  InvalidPdfHeader: "pdf.invalid_header";
  InputTooLarge: "security.input_too_large";
  PageCountExceeded: "security.page_count_exceeded";
  ImagePixelsExceeded: "security.image_pixels_exceeded";
  PasswordRequired: "security.password_required";
  PasswordIncorrect: "security.password_incorrect";
  UnsupportedEncryption: "security.unsupported_encryption";
  OcrDisabled: "ocr.disabled";
  WebGpuUnavailable: "webgpu.unavailable";
  HeuristicTextExtraction: "text.heuristic_content_stream";
  TextUnicodeMappingSuspect: "text.unicode_mapping_suspect";
  TextOrderingUncertain: "text.ordering_uncertain";
  TableLowConfidence: "table.low_confidence";
  EquationLowOcrConfidence: "equation.low_ocr_confidence";
  FigureLowSemanticContent: "figure.low_semantic_content";
  TaggedStructureConflict: "structure.tagged_layout_conflict";
  PdfParseFailed: "pdf.parse_failed";
}>;

export declare function createWarning(
  code: string,
  message: string,
  details?: Record<string, unknown>
): Warning;

export declare function createDocumentIr(options?: {
  sourceType?: SourceType;
  pages?: PageIr[];
}): DocumentIr;

export declare function createPageIr(options: {
  pageIndex: number;
  widthPt?: number | null;
  heightPt?: number | null;
  rotation?: number;
  sourceType?: SourceType;
  elements?: unknown[];
}): PageIr;

export declare function createMarkdownSourceMap(options?: {
  entries?: MarkdownSourceMapEntry[];
}): MarkdownSourceMap;

export declare const warningJsonSchema: Readonly<Record<string, unknown>>;
export declare const assetJsonSchema: Readonly<Record<string, unknown>>;
export declare const pageElementJsonSchema: Readonly<Record<string, unknown>>;
export declare const pageIrJsonSchema: Readonly<Record<string, unknown>>;
export declare const documentIrJsonSchema: Readonly<Record<string, unknown>>;
export declare const markdownSourceMapJsonSchema: Readonly<Record<string, unknown>>;
