# API Reference

This document describes the current public API for `pdf-2-llm`.
The source of truth for the full type surface is
`packages/pdf2md/src/index.d.ts`.

## Entrypoints

All runtime entrypoints currently re-export the same API:

```ts
import { convertPdfToMarkdown } from "pdf-2-llm";
import { convertPdfToMarkdown as convertInNode } from "pdf-2-llm/node";
import { convertPdfToMarkdown as convertInBrowser } from "pdf-2-llm/browser";
import { convertPdfToMarkdown as convertInWorker } from "pdf-2-llm/worker";
```

The schema entrypoint exports JSON schemas and warning constants:

```ts
import {
  documentIrJsonSchema,
  markdownSourceMapJsonSchema,
  schemaVersion,
  warningCodes
} from "pdf-2-llm/schema";
```

## Main Function

```ts
async function convertPdfToMarkdown(
  input: PdfInput,
  options?: ConvertOptions
): Promise<ConvertResult>;
```

`convertPdfToMarkdown` always resolves to a `ConvertResult` object when
conversion is able to return a structured result. Some control failures reject
instead:

- A pre-aborted `AbortSignal` rejects with `AbortError`.
- A timed-out conversion checkpoint rejects with `TimeoutError`.
- Invalid security limit values reject with `RangeError`.
- Invalid input types reject with `TypeError`.

PDF parse failures, password problems, unsupported encryption, image pixel
limits, and similar document-level issues are usually returned as structured
warnings and diagnostics instead of thrown exceptions.

## Inputs

```ts
type PdfInput =
  | string
  | ArrayBuffer
  | Uint8Array
  | {
      bytes: Uint8Array;
      sourceType?: string;
    };
```

- `string`: treated as a local filesystem path in Node.
- `ArrayBuffer`: useful for browser `File.arrayBuffer()` and `fetch()`.
- `Uint8Array`: useful when bytes are already loaded.
- `{ bytes, sourceType }`: preserves a caller-defined source label in
  diagnostics.

The input is hashed with SHA-256 and summarized under
`result.diagnostics.input`.

## Basic Usage

Node:

```ts
import { readFile } from "node:fs/promises";
import { convertPdfToMarkdown } from "pdf-2-llm";

const bytes = await readFile("document.pdf");
const result = await convertPdfToMarkdown(bytes, {
  ocr: { enabled: false }
});

console.log(result.markdown);
console.log(result.warnings);
```

Browser:

```ts
import { convertPdfToMarkdown } from "pdf-2-llm/browser";

const input = document.querySelector("input[type=file]");
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  const result = await convertPdfToMarkdown(await file.arrayBuffer());
  console.log(result.markdown);
});
```

## Convert Options

### Lifecycle

```ts
{
  signal?: AbortSignal;
  onProgress?: (event: { stage: "start" | "complete"; progress: number }) => void;
}
```

`signal` is checked at conversion checkpoints. `onProgress` currently emits a
`start` event with progress `0` and a `complete` event with progress `1`.

### Markdown

```ts
{
  markdown?: {
    pageAnchors?: boolean;
    preserveRunningTitles?: boolean;
  };
}
```

- `pageAnchors` inserts Markdown page anchors where supported by the layout
  serializer.
- `preserveRunningTitles` keeps detected running titles instead of removing
  them as headers/footers.

### Parser And Passwords

```ts
{
  parser?: {
    mode?: "strict" | "tolerant";
  };
  password?: string | ((request: { reason: "encrypted-pdf" }) => string | Promise<string>);
}
```

- `parser.mode: "strict"` is the default.
- `parser.mode: "tolerant"` enables repair behavior for supported damaged xref
  cases.
- `password` can be a string or a callback. Password values are not copied into
  diagnostics or warnings.

Unsupported encryption is reported as `security.unsupported_encryption`. Wrong
passwords are reported as `security.password_incorrect`. Missing passwords are
reported as `security.password_required`. The implemented Standard revision 2
RC4-40 path decrypts content streams and indirect-object strings used by
outlines, forms, annotations, structure, and other parsed metadata.

### Security Limits

```ts
{
  security?: {
    maxBytes?: number;
    maxDecodedStreamBytes?: number;
    maxTotalDecodedStreamBytes?: number;
    maxPages?: number;
    maxObjects?: number;
    maxDepth?: number;
    maxCMapMappings?: number;
    maxContentStreamOperations?: number;
    maxContentStreamOutputs?: number;
    maxImagePixels?: number;
    timeoutMs?: number;
  };
}
```

Defaults:

| Option | Default |
| --- | ---: |
| `maxBytes` | `104857600` |
| `maxDecodedStreamBytes` | `52428800` |
| `maxTotalDecodedStreamBytes` | `209715200` |
| `maxPages` | `5000` |
| `maxObjects` | `100000` |
| `maxDepth` | `100` |
| `maxCMapMappings` | `65536` |
| `maxContentStreamOperations` | `1000000` |
| `maxContentStreamOutputs` | `1000000` |
| `maxImagePixels` | `100000000` |
| `timeoutMs` | `120000` |

Security limit violations are reported with warnings and parser diagnostics
when the converter can return a structured result. `timeoutMs` is enforced by
throwing `TimeoutError` at checkpoints.

### OCR

```ts
{
  ocr?: {
    enabled?: boolean;
    adapter?: "tesseract.js";
    languages?: string[];
    scripts?: Array<
      | "latin"
      | "rtl"
      | "arabic"
      | "hebrew"
      | "cjk"
      | "chinese"
      | "japanese"
      | "korean"
      | "vertical"
    >;
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
}
```

Current OCR behavior is contract-first:

- The CPU adapter is `tesseract.js` and is reported in diagnostics.
- Model loading is lazy and represented in diagnostics as model file names such
  as `eng.traineddata`.
- The current converter does not download or execute OCR model files.
- OCR text output is produced from caller-supplied `options.ocr.results`.

`ocr.results` accepts page-level text boxes in page or raster coordinates:

```ts
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    results: [
      {
        pageIndex: 0,
        language: "eng",
        coordinateSpace: "page",
        lines: [
          {
            text: "Scanned text",
            confidence: 0.98,
            x: 72,
            y: 96,
            width: 220,
            height: 18
          }
        ]
      }
    ],
    debugSidecars: true
  }
});
```

When `debugSidecars` is true, OCR box sidecars are returned in `result.assets`
as JSON assets.

### Raster Planning

```ts
{
  raster?: {
    enabled?: boolean;
    renderer?: "internal-page-geometry";
    dpi?: number;
    thumbnailDpi?: number;
  };
}
```

Raster support currently creates bounded raster plans and diagnostics. It does
not render full image buffers. Page and thumbnail targets that exceed
`security.maxImagePixels` are skipped and reported with
`security.image_pixels_exceeded` warnings.

### WebGPU

```ts
{
  webgpu?: {
    required?: boolean;
    preferred?: boolean;
    powerPreference?: "low-power" | "high-performance";
    maxBatchPixels?: number;
    maxMemoryBytes?: number;
    device?: unknown;
    preprocessing?: {
      enabled?: boolean;
      workload?: "binarize-rgba" | "adaptive-threshold-rgba";
      threshold?: number;
      radius?: number;
      bias?: number;
      maxSamplePixelsPerPage?: number;
      minSpeedup?: number;
      runner?: WebGpuPreprocessingRunner;
    };
  };
}
```

The WebGPU path performs capability detection, OCR batch planning, and
conversion-routed OCR preprocessing diagnostics. In Node, the stable GPU
execution path falls back to CPU unless a caller supplies a concrete browser
`GPUDevice`. Browser support depends on `navigator.gpu`, adapter/device
creation, and device health. If `required` is true but WebGPU is unavailable,
the converter records `webgpu.unavailable` and continues with CPU fallback.

### Tables

```ts
{
  tables?: {
    enabled?: boolean;
    htmlFallback?: boolean;
    csvSidecars?: boolean;
  };
}
```

Table detection and serialization are enabled by default. Set `tables.enabled`
to `false` to leave table-shaped source lines as ordinary text and skip ruled
grid/span detection, table diagnostics, table IR, and CSV sidecars.

Detected ruled tables are emitted as GFM tables when possible. HTML fallback is
enabled by default for spans and one-row tables. When `tables.htmlFallback` is
`false`, those tables use a lossy GFM projection with covered span cells left
empty; document IR still preserves the original row and column spans. CSV
sidecars are enabled by default unless `tables.csvSidecars` is false or table
detection is disabled.

### Equations

```ts
{
  equations?: {
    imageFallbackConfidence?: number;
    formulaOcr?: {
      enabled?: boolean;
      results?: Array<{
        equationIndex?: number;
        pageIndex?: number;
        latex: string;
        confidence?: number;
        source?: string;
      }>;
    };
  };
}
```

Text equations are preserved when confidence is high. Low-confidence OCR
equations use an explicit metadata-only Markdown fallback and emit
`equation.low_ocr_confidence`; caller-supplied formula OCR results can provide
LaTeX output instead. The current raster planner does not return equation
preview bytes, so these fallbacks do not create broken image links or assets.

### Attachments And Assets

```ts
{
  attachments?: {
    extract?: boolean;
  };
  assets?: {
    enabled?: boolean;
    outputDir?: string;
  };
}
```

`attachments.extract` enables embedded file sidecar assets. Assets are returned
in memory through `result.assets`; the conversion API does not write asset files
to `assets.outputDir` yet. `assets.enabled` and `assets.outputDir` are reserved
for asset adapter work and are currently diagnostic/contract fields only.

### Reserved Contract Fields

These options are accepted by the TypeScript contract and summarized in
diagnostics, but they do not currently change conversion behavior:

- `pageRange`
- `output`
- `assets.enabled`
- `assets.outputDir`

The function always returns the full `ConvertResult` object.

## Result Object

```ts
type ConvertResult = {
  markdown: string;
  sourceMap: MarkdownSourceMap;
  assets: AssetResult[];
  ir: DocumentIr;
  warnings: Warning[];
  diagnostics: Diagnostics;
  confidence: Confidence;
};
```

### `markdown`

The converted Markdown string. It may include GFM tables, raw HTML tables for
spans, metadata-only figure/equation fallback markers, and optional page
anchors.

### `sourceMap`

Maps Markdown string offsets back to page regions. The schema is exported as
`markdownSourceMapJsonSchema`. Text, span, glyph, and source-map regions use
axis-aligned page-space bounds after applying the content stream's text matrix
and current transformation matrix, including rotation and skew. Font advances
come from each original PDF character code before its ToUnicode text is placed
in that region, including mappings that expand one glyph into multiple Unicode
characters. Text, paths, and images invoked through nested Form XObjects use
their composed Form matrices and local resources in the same page coordinate
space.

### `assets`

Sidecar assets generated during conversion. Common asset kinds include:

- `table-csv`
- `ocr-debug-json`
- `attachment`

Assets may include `content` inline, or a `path` that names the expected sidecar
path. `equation-preview` and `figure-preview` are reserved kinds; conversion
does not return them until the raster path can supply renderable content.

### `ir`

Structured document IR with pages, page elements, assets, metadata, and
warnings. Page text elements come from the reconciled PDF/OCR lines selected
for Markdown, and emitted tables become table elements instead of duplicated
text elements. Table elements reference their CSV sidecar asset when one is
enabled. The schema is exported as `documentIrJsonSchema`.

### `warnings`

Warnings are part of the API contract. Callers should inspect them before using
converted content for RAG, indexing, archival, or compliance workflows.

Current warning codes:

| Constant | Code |
| --- | --- |
| `ConversionNotImplemented` | `conversion.not_implemented` |
| `InvalidPdfHeader` | `pdf.invalid_header` |
| `InputTooLarge` | `security.input_too_large` |
| `PageCountExceeded` | `security.page_count_exceeded` |
| `ImagePixelsExceeded` | `security.image_pixels_exceeded` |
| `PasswordRequired` | `security.password_required` |
| `PasswordIncorrect` | `security.password_incorrect` |
| `UnsupportedEncryption` | `security.unsupported_encryption` |
| `OcrDisabled` | `ocr.disabled` |
| `WebGpuUnavailable` | `webgpu.unavailable` |
| `HeuristicTextExtraction` | `text.heuristic_content_stream` |
| `TextUnicodeMappingSuspect` | `text.unicode_mapping_suspect` |
| `TextOrderingUncertain` | `text.ordering_uncertain` |
| `TableLowConfidence` | `table.low_confidence` |
| `EquationLowOcrConfidence` | `equation.low_ocr_confidence` |
| `FigureLowSemanticContent` | `figure.low_semantic_content` |
| `TaggedStructureConflict` | `structure.tagged_layout_conflict` |
| `PdfParseFailed` | `pdf.parse_failed` |

### `diagnostics`

Diagnostics include:

- Input size, hash, PDF version, and source.
- Effective options and security limits.
- Timing.
- WebGPU capability and execution planning.
- Parser mode, object counts, stream counts, page counts, and repair status.
- Extraction summaries for text, layout, OCR, raster planning, scan detection,
  tables, equations, figures, forms, annotations, attachments, and signatures.
- Per-page geometry and resource summaries.

### `confidence`

Confidence currently reports coarse scores for overall, text, layout, and
tables. Treat these as stability signals rather than calibrated probabilities.

## Schema And Validation

The package exports:

- `schemaVersion`
- `warningCodes`
- `documentIrJsonSchema`
- `markdownSourceMapJsonSchema`

The repository tests serialize conversion outputs against these schemas, so
callers can use the same schemas to validate persisted IR/source-map payloads.

## WASM Preflight

The optional `pdf-2-llm/wasm` entrypoint loads the packaged
single-threaded Rust/WebAssembly preflight module:

```js
import { loadPdf2mdCoreWasm } from "pdf-2-llm/wasm";

const core = await loadPdf2mdCoreWasm();
const looksLikePdf = core.hasPdfHeader(bytes);
```

This module currently exposes version reporting and PDF header preflight only.
Conversion output still comes from the JavaScript parser and extraction
pipeline.

## Operational Notes

- PDFs are attacker-controlled binary inputs. Keep security limits enabled.
- OCR model binaries are not bundled. Model-size checks enforce this in QA.
- WebGPU is optional and must not be required for accepted CPU output.
- Passwords should be supplied out-of-band; avoid logging callback inputs or
  option objects that may contain secrets.
- Asset paths are logical output paths unless the caller writes returned assets
  to disk.
