export type PdfInput =
  | string
  | ArrayBuffer
  | Uint8Array
  | {
      bytes: Uint8Array;
      sourceType?: string;
    };

export type ConvertOptions = {
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  pageRange?: {
    start?: number;
    end?: number;
  };
  output?: "markdown" | "json";
  password?: string | (() => string | Promise<string>);
  security?: {
    maxBytes?: number;
    maxPages?: number;
    timeoutMs?: number;
  };
  ocr?: {
    enabled?: boolean;
    languages?: string[];
  };
  webgpu?: {
    required?: boolean;
    preferred?: boolean;
  };
  tables?: {
    enabled?: boolean;
    htmlFallback?: boolean;
    csvSidecars?: boolean;
  };
  assets?: {
    enabled?: boolean;
    outputDir?: string;
  };
};

export type ProgressEvent = {
  stage: "start" | "complete";
  progress: number;
};

export type ConvertResult = {
  markdown: string;
  assets: AssetResult[];
  ir: DocumentIr;
  warnings: Warning[];
  diagnostics: Diagnostics;
  confidence: Confidence;
};

export type Warning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type Diagnostics = {
  schemaVersion: string;
  input: {
    bytes: number;
    sha256: string;
    source: Record<string, unknown>;
    pdfVersion: string | null;
  };
  options: Record<string, unknown>;
  timing: {
    elapsedMs: number;
  };
  extraction: {
    textLines: number;
    mode: string;
    parser: Record<string, unknown>;
  };
  pages: PageDiagnostics[];
};

export type PageDiagnostics = {
  pageIndex: number;
  objectNumber: number;
  widthPt: number | null;
  heightPt: number | null;
  rotation: number;
  userUnit: number;
  mediaBox: number[] | null;
  cropBox: number[] | null;
  contentStreams: number;
  fonts: string[];
};

export type Confidence = {
  overall: number;
  text: number;
  layout: number;
  tables: number;
};

export type DocumentIr = {
  schemaVersion: string;
  sourceType: "digital" | "scanned" | "hybrid" | "unknown";
  pages: PageIr[];
  metadata: Record<string, unknown>;
  assets: AssetResult[];
  warnings: Warning[];
};

export type PageIr = {
  pageIndex: number;
  widthPt: number | null;
  heightPt: number | null;
  rotation: number;
  sourceType: "digital" | "scanned" | "hybrid" | "unknown";
  elements: PageElement[];
};

export type PageElement =
  | TextBlock
  | TableBlock
  | FigureBlock
  | EquationBlock
  | FormFieldBlock
  | AnnotationBlock
  | AssetReferenceBlock;

export type TextBlock = {
  type: "text";
  spans: TextSpan[];
};

export type TextSpan = {
  text: string;
  glyphIds?: number[];
  fontName?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: "ltr" | "rtl" | "vertical" | "unknown";
  confidence: number;
  source: "pdf-text" | "ocr" | "tagged-pdf";
};

export type TableBlock = {
  type: "table";
  rows: TableCell[][];
  confidence: number;
  htmlFallback?: string;
  csvSidecarAssetId?: string;
};

export type TableCell = {
  text: string;
  rowSpan: number;
  colSpan: number;
};

export type FigureBlock = {
  type: "figure";
  caption?: string;
  assetId?: string;
};

export type EquationBlock = {
  type: "equation";
  text?: string;
  latex?: string;
  assetId?: string;
};

export type FormFieldBlock = {
  type: "form-field";
  name: string;
  value?: string;
  fieldType?: string;
};

export type AnnotationBlock = {
  type: "annotation";
  subtype: string;
  contents?: string;
};

export type AssetReferenceBlock = {
  type: "asset-reference";
  assetId: string;
};

export type AssetResult = {
  id: string;
  path: string;
  mediaType: string;
};

export declare const schemaVersion: string;
export declare const warningCodes: Readonly<Record<string, string>>;
export declare function convertPdfToMarkdown(
  input: PdfInput,
  options?: ConvertOptions
): Promise<ConvertResult>;
