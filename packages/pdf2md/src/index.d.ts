export type PdfInput =
  | string
  | ArrayBuffer
  | Uint8Array
  | {
      bytes: Uint8Array;
      sourceType?: string;
    };

export type PasswordRequest = {
  reason: "encrypted-pdf";
};

export type ConvertOptions = {
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  pageRange?: {
    start?: number;
    end?: number;
  };
  output?: "markdown" | "json";
  markdown?: {
    pageAnchors?: boolean;
    preserveRunningTitles?: boolean;
  };
  parser?: {
    mode?: "strict" | "tolerant";
  };
  password?: string | ((request: PasswordRequest) => string | Promise<string>);
  security?: {
    maxBytes?: number;
    maxPages?: number;
    maxObjects?: number;
    maxImagePixels?: number;
    timeoutMs?: number;
  };
  ocr?: {
    enabled?: boolean;
    languages?: string[];
  };
  raster?: {
    enabled?: boolean;
    renderer?: "internal-page-geometry";
    dpi?: number;
    thumbnailDpi?: number;
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
  sourceMap: MarkdownSourceMap;
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
    outlines: OutlineDiagnostics[];
    structure: StructureDiagnostics;
    taggedStructureConflicts: number;
    layout: LayoutDiagnostics;
    raster: RasterDiagnostics;
    scanDetection: ScanDetectionDiagnostics;
    parser: Record<string, unknown>;
  };
  pages: PageDiagnostics[];
};

export type RasterDiagnostics = {
  enabled: boolean;
  dpi: number;
  thumbnailDpi: number;
  maxPixels: number;
  limitedPages: number;
  limitedThumbnails: number;
  renderer: RasterRendererDiagnostics;
  pages: RasterPageDiagnostics[];
};

export type RasterRendererDiagnostics = {
  id: string;
  kind: "scoped-internal";
  dependency: string | null;
  environments: string[];
  output: "raster-plan";
  status: "selected" | "unsupported";
  requested: string;
  notes: string;
};

export type RasterPageDiagnostics = {
  pageIndex: number;
  status: "planned" | "skipped-pixel-limit";
  sourceBox: "cropBox" | "mediaBox" | "unknown";
  boxPt: number[] | null;
  sourceWidthPt: number | null;
  sourceHeightPt: number | null;
  widthPt: number | null;
  heightPt: number | null;
  dpi: number;
  scale: number;
  widthPx: number | null;
  heightPx: number | null;
  pixelCount: number | null;
  maxPixels: number;
  exceedsPixelLimit: boolean;
  thumbnail: RasterTargetDiagnostics;
  rotation: number;
  quarterTurn: boolean;
  userUnit: number;
};

export type RasterTargetDiagnostics = {
  status: "planned" | "skipped-pixel-limit";
  dpi: number;
  scale: number;
  widthPx: number | null;
  heightPx: number | null;
  pixelCount: number | null;
  maxPixels: number;
  exceedsPixelLimit: boolean;
};

export type ScanDetectionDiagnostics = {
  thresholds: {
    imageCoverageRatio: number;
    minTextLines: number;
    minTextAreaRatio: number;
  };
  imageDominantPages: number;
  littleOrNoTextPages: number;
  pages: ScanDetectionPageDiagnostics[];
};

export type ScanDetectionPageDiagnostics = {
  pageIndex: number;
  textLineCount: number;
  textArea: number | null;
  textAreaRatio: number | null;
  noText: boolean;
  littleText: boolean;
  littleOrNoText: boolean;
  imageResourceCount: number;
  imageDrawCount: number;
  pageArea: number | null;
  totalImageArea: number | null;
  maxImageArea: number | null;
  imageCoverageRatio: number | null;
  maxImageCoverageRatio: number | null;
  imageDominant: boolean;
  imageDominanceConfidence: number;
  imageDraws: ImageDrawDiagnostics[];
};

export type ImageDrawDiagnostics = {
  name: string;
  objectNumber: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
  imageWidth: number | null;
  imageHeight: number | null;
  imagePixels: number | null;
  streamIndex: number | null;
  source: "xobject-do";
};

export type OutlineDiagnostics = {
  title: string;
  depth: number;
  objectNumber?: number | null;
  generationNumber?: number | null;
};

export type StructureDiagnostics = {
  tagged: boolean;
  roleMap: Record<string, string>;
  elements: number;
  markedContent: number;
  roles: Record<string, number>;
};

export type LayoutDiagnostics = {
  pages: PageLayoutDiagnostics[];
};

export type PageLayoutDiagnostics = {
  pageIndex: number | null;
  kind: "single-column" | "multi-column" | "mixed" | "unknown";
  rows: number;
  blocks: number;
  columns: LayoutColumnDiagnostics[];
  sidebars: LayoutRegionDiagnostics[];
  callouts: LayoutRegionDiagnostics[];
  footnotes: LayoutRegionDiagnostics[];
  captions: LayoutRegionDiagnostics[];
  pageNumbers: LayoutRegionDiagnostics[];
};

export type LayoutColumnDiagnostics = {
  index: number;
  x: number;
  rows: number;
};

export type LayoutRegionDiagnostics = {
  kind: "sidebar" | "callout" | "footnote" | "caption" | "page-number";
  x: number;
  y: number;
  width: number;
  height: number;
  rows: number;
  columnIndex?: number;
  target?: "figure" | "table";
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
  images: PageImageDiagnostics[];
};

export type PageImageDiagnostics = {
  name: string;
  objectNumber: number | null;
  width: number | null;
  height: number | null;
  bitsPerComponent: number | null;
  colorSpace: string | null;
  filters: string[];
  skippedFilters: string[];
  mediaType: string;
  rawLength: number | null;
  decodedLength: number | null;
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

export type MarkdownSourceMap = {
  schemaVersion: string;
  target: "markdown";
  entries: MarkdownSourceMapEntry[];
};

export type MarkdownSourceMapEntry = {
  markdownStart: number;
  markdownEnd: number;
  kind: string;
  regions: SourceRegion[];
};

export type SourceRegion = {
  pageIndex: number;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  source: string;
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
  kind?: string;
  content?: string;
  pageIndex?: number | null;
  tableIndex?: number;
};

export declare const schemaVersion: string;
export declare const warningCodes: Readonly<Record<string, string>>;
export declare const documentIrJsonSchema: Record<string, unknown>;
export declare const markdownSourceMapJsonSchema: Record<string, unknown>;
export declare function convertPdfToMarkdown(
  input: PdfInput,
  options?: ConvertOptions
): Promise<ConvertResult>;
