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
    adapter?: "tesseract.js";
    languages?: string[];
    modelBaseUrl?: string;
    results?: OcrPageResult[];
    debugSidecars?: boolean;
    pageLanguages?: OcrPageLanguageOverride[];
    preprocessing?: {
      enabled?: boolean;
      deskew?: boolean;
      minDeskewDegrees?: number;
      maxDeskewDegrees?: number;
      binarize?: boolean;
      denoise?: boolean;
    };
    cache?: {
      enabled?: boolean;
      strategy?: "adapter-default" | "none";
      directory?: string;
    };
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
    ocr: OcrDiagnostics;
    raster: RasterDiagnostics;
    scanDetection: ScanDetectionDiagnostics;
    parser: Record<string, unknown>;
  };
  pages: PageDiagnostics[];
};

export type OcrDiagnostics = {
  enabled: boolean;
  requested: string;
  status: "disabled" | "selected" | "unsupported";
  languages: string[];
  language: OcrLanguageDiagnostics;
  modelLoading: OcrModelLoadingDiagnostics;
  preprocessing: OcrPreprocessingDiagnostics;
  reconciliation: OcrReconciliationDiagnostics;
  sidecars: OcrSidecarDiagnostics;
  textBoxes: OcrTextBoxDiagnostics;
  adapter: OcrAdapterDiagnostics | null;
};

export type OcrPageResult = {
  pageIndex: number;
  language?: string;
  coordinateSpace?: "page" | "raster";
  widthPx?: number;
  heightPx?: number;
  boxes?: OcrTextBoxInput[];
  lines?: OcrTextBoxInput[];
  words?: OcrTextBoxInput[];
};

export type OcrPageLanguageOverride = {
  pageIndex: number;
  languages: string[];
};

export type OcrLanguageDiagnostics = {
  enabled: boolean;
  status: "disabled" | "unsupported" | "no-routed-pages" | "configured";
  defaultLanguages: string[];
  modelLanguages: string[];
  workerLanguage: string;
  pageOverrides: OcrLanguagePageOverrideDiagnostics[];
  pages: OcrLanguagePageDiagnostics[];
};

export type OcrLanguagePageOverrideDiagnostics = {
  pageIndex: number;
  languages: string[];
  workerLanguage: string;
  modelFiles: string[];
};

export type OcrLanguagePageDiagnostics = {
  pageIndex: number;
  sourceType: "scanned" | "hybrid";
  languages: string[];
  workerLanguage: string;
  modelFiles: string[];
};

export type OcrTextBoxInput = {
  text: string;
  confidence?: number;
  direction?: "ltr" | "rtl" | "vertical" | "unknown";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bbox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
    x0?: number;
    y0?: number;
    x1?: number;
    y1?: number;
  };
};

export type OcrTextBoxDiagnostics = {
  enabled: boolean;
  status:
    | "disabled"
    | "unsupported"
    | "no-routed-pages"
    | "pending"
    | "partial"
    | "completed";
  source: "none" | "options.ocr.results";
  routedPages: number;
  completedPages: number;
  totalBoxes: number;
  averageConfidence: number | null;
  pages: OcrTextBoxPageDiagnostics[];
};

export type OcrTextBoxPageDiagnostics = {
  pageIndex: number;
  sourceType: "scanned" | "hybrid";
  status: "pending" | "completed" | "empty";
  coordinateSpace: "page" | "raster" | null;
  language: string | null;
  boxes: number;
  averageConfidence: number | null;
};

export type OcrPreprocessingDiagnostics = {
  enabled: boolean;
  status:
    | "disabled"
    | "unsupported"
    | "no-routed-pages"
    | "metadata-only"
    | "planned"
    | "skipped";
  strategy: "metadata-first";
  thresholds: {
    minDeskewDegrees: number;
    maxDeskewDegrees: number;
  };
  pages: OcrPreprocessingPageDiagnostics[];
};

export type OcrPreprocessingPageDiagnostics = {
  pageIndex: number;
  sourceType: "scanned" | "hybrid";
  status: "metadata-only" | "planned" | "skipped-pixel-limit";
  rasterStatus: "not-planned" | "planned" | "skipped-pixel-limit" | "missing";
  pageRotationDegrees: number;
  rotationCorrectionDegrees: number;
  deskewDegrees: number;
  deskewConfidence: number;
  operations: Array<"normalize-page-rotation" | "estimate-deskew" | "binarize" | "denoise">;
  deferredOperations: Array<"estimate-deskew" | "binarize" | "denoise">;
};

export type OcrReconciliationDiagnostics = {
  status: "no-pages" | "completed";
  strategy: "page-source-selection";
  selectedPdfTextLines: number;
  selectedOcrTextLines: number;
  suppressedPdfTextLines: number;
  suppressedOcrTextLines: number;
  pages: OcrReconciliationPageDiagnostics[];
};

export type OcrReconciliationPageDiagnostics = {
  pageIndex: number | null;
  sourceType: "digital" | "scanned" | "hybrid" | "unknown";
  selected: "pdf" | "ocr" | "combined" | "none";
  reason:
    | "no-text"
    | "scanned-page-ocr"
    | "scanned-page-no-ocr"
    | "digital-page-pdf"
    | "digital-page-no-pdf"
    | "pdf-visible-geometry-aligned"
    | "pdf-visible-geometry-mismatch"
    | "hybrid-region-source-selection"
    | "hybrid-pdf-text-fallback"
    | "hybrid-no-pdf-text"
    | "unknown-source-combined"
    | "single-source-available";
  pdfTextLines: number;
  ocrTextLines: number;
  pdfVisibleTextLines: number;
  pdfHiddenTextLines: number;
  pdfHiddenImageAlignedTextLines: number;
  pdfHiddenImageUnalignedTextLines: number;
  pdfVisibleGeometryAligned: boolean;
  selectedPdfTextLines: number;
  selectedOcrTextLines: number;
  suppressedPdfTextLines: number;
  suppressedOcrTextLines: number;
};

export type OcrSidecarDiagnostics = {
  enabled: boolean;
  assets: number;
  pages: OcrSidecarPageDiagnostics[];
};

export type OcrSidecarPageDiagnostics = {
  pageIndex: number | null;
  assetId: string;
  boxes: number;
};

export type OcrModelLoadingDiagnostics = {
  strategy: "lazy";
  trigger: "routed-scanned-or-hybrid-pages";
  workerLifecycle: "reuse-worker-per-language-set";
  source: string;
  languages: string[];
  modelFiles: string[];
  cache: {
    enabled: boolean;
    strategy: "adapter-default" | "none";
    directory: string | null;
    keyPrefix: string;
    browser: "adapter-default-indexeddb" | "disabled";
    node: "adapter-default-filesystem" | "disabled";
  };
};

export type OcrAdapterDiagnostics = {
  id: "tesseract.js";
  kind: "cpu";
  packageName: "tesseract.js";
  version: string;
  license: "Apache-2.0";
  runtimes: Array<"browser" | "node" | "worker">;
  output: "ocr-plan";
  notes: string;
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
  sourceType: "digital" | "scanned" | "hybrid" | "unknown";
  sourceTypeCounts: {
    digital: number;
    scanned: number;
    hybrid: number;
    unknown: number;
  };
  routingConfidence: number;
  thresholds: {
    imageCoverageRatio: number;
    minTextLines: number;
    minTextAreaRatio: number;
    minHiddenTextLines: number;
    minHiddenTextImageOverlapRatio: number;
  };
  imageDominantPages: number;
  littleOrNoTextPages: number;
  hiddenOcrOverlayPages: number;
  hiddenTextImageMismatchPages: number;
  pages: ScanDetectionPageDiagnostics[];
};

export type ScanDetectionPageDiagnostics = {
  pageIndex: number;
  sourceType: "digital" | "scanned" | "hybrid" | "unknown";
  routingConfidence: number;
  routingReasons: string[];
  textLineCount: number;
  textArea: number | null;
  textAreaRatio: number | null;
  noText: boolean;
  littleText: boolean;
  littleOrNoText: boolean;
  hiddenTextLineCount: number;
  hiddenTextArea: number | null;
  hiddenTextAreaRatio: number | null;
  hiddenOcrOverlayLikely: boolean;
  hiddenTextImageMismatchLineCount: number;
  hiddenTextImageMismatchLikely: boolean;
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
