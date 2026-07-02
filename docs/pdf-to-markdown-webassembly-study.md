# WebAssembly + WebGPU PDF-to-Markdown Study

Source session: https://chatgpt.com/share/6a46b877-dd04-83eb-80ea-cb11eaccd654

Date extracted: 2026-07-02

## Executive Summary

The source session studied how to build a custom PDF-to-Markdown library from
scratch, package it as an npm dependency, and use WebAssembly plus WebGPU to
make it fast enough for browser and Node workloads.

The main conclusion is that a serious converter cannot be only a text extractor.
PDF is a presentation and exchange format, not a semantic authoring format. A
high-quality implementation must combine:

- A tolerant PDF parser.
- A content-stream interpreter.
- Font and Unicode recovery.
- Layout reconstruction.
- OCR for scanned or image-heavy pages.
- Table detection and table-structure recovery.
- Figure, image, form, annotation, and asset handling.
- Markdown serialization.
- A structured intermediate representation.
- Confidence scores, warnings, and diagnostics.

The product should expose Markdown as the most convenient output, but it should
also return structured JSON, extracted assets, source maps, warnings, and
confidence values. Markdown alone cannot faithfully represent every PDF feature,
especially complex tables, vector diagrams, signatures, attachments, forms,
layers, multi-column reading order, annotations, charts, and damaged object
graphs.

The recommended architecture is:

- Rust compiled to WebAssembly for the deterministic core.
- TypeScript for the public npm API, workers, browser and Node integration,
  asset adapters, model loading, and CLI.
- WebGPU as an optional acceleration layer for OCR, layout, table, equation, and
  image-preprocessing models.
- CPU fallbacks for every GPU-accelerated feature.
- Development-time differential testing against mature engines and document
  conversion systems.

The realistic promise is not "perfect Markdown for every PDF." The realistic
promise is:

> Fast local PDF-to-Markdown conversion with structured output, OCR, table and
> asset handling, confidence scores, and diagnostics. It runs in browser and Node
> through WebAssembly, and it accelerates selected ML workloads with WebGPU when
> available.

## Goals

The requested library should:

- Ship as a simple npm dependency.
- Run in browser and Node.
- Use WebAssembly for performance, portability, and a hardened parsing core.
- Use WebGPU where it materially improves throughput.
- Convert many PDF classes into structured Markdown.
- Handle long manuals, scanned documents, tables, forms, scientific papers,
  images, and other complex content.
- Be robust against malformed and hostile inputs.
- Be friendly to AI-agent implementation by splitting the work into narrow,
  testable modules.

Non-goals for the first production version:

- Pixel-perfect PDF rendering.
- Perfect semantic reconstruction for every PDF.
- Reimplementing all image codecs, OCR engines, ML runtimes, and reference PDF
  engines from scratch.
- Requiring WebGPU for correctness.
- Silently flattening unsupported PDF features into misleading Markdown.

## Core Product Shape

The public API should make the output contract explicit. A caller should be able
to ask for Markdown, assets, structured JSON, diagnostics, and optional OCR/GPU
features without caring how the internals are split across Rust, WebAssembly,
workers, or model runtimes.

Example API:

```ts
import { convertPdfToMarkdown } from "@your-scope/pdf2md";

const result = await convertPdfToMarkdown(pdfBytes, {
  markdown: {
    profile: "gfm",
    pageBreaks: true,
    includeFrontMatter: true,
    complexTables: "html",
  },
  assets: {
    extractImages: true,
    renderFigures: true,
    output: "virtual",
  },
  ocr: {
    mode: "auto",
    languages: ["eng", "fra"],
    minTextCoverage: 0.25,
    dpi: 300,
  },
  gpu: {
    mode: "auto",
    backend: "webgpu",
  },
  tables: {
    mode: "auto",
    output: "gfm-or-html",
  },
  diagnostics: {
    includePageJson: true,
    includeConfidence: true,
  },
});
```

Example result:

```ts
type ConvertResult = {
  markdown: string;
  assets: Array<{
    id: string;
    kind: "image" | "figure" | "table-csv" | "page-render";
    mime: string;
    data?: Uint8Array;
    href: string;
    page: number;
    bbox?: [number, number, number, number];
  }>;
  document: PdfMarkdownDocument;
  warnings: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    page?: number;
    message: string;
  }>;
  confidence: {
    overall: number;
    text: number;
    layout: number;
    tables: number;
    ocr: number | null;
  };
};
```

## Why PDF-to-Markdown Is Hard

PDFs usually contain drawing instructions, not authoring intent. A page may say
"draw glyph G from font F at position X/Y" or "draw this image at this rectangle"
without saying "this is the second paragraph of section 4."

A converter must infer structure from multiple sources:

- Object graph.
- Page tree and page boxes.
- Tagged PDF structure, if present.
- Marked-content spans.
- Glyph positions and baselines.
- Font sizes, weights, and styles.
- Content stream order.
- Page geometry.
- Vector paths and ruling lines.
- Rasterized page images.
- OCR text and OCR boxes.
- Layout-model predictions.
- Table-model predictions.
- Document-wide repetition patterns.

The implementation should assume that no single signal is reliable. Tagged PDFs
can be wrong. Content stream order can be unrelated to reading order. Hidden OCR
layers can be stale or misaligned. Font encodings can be custom or broken.
Tables can be drawn with lines, whitespace, vector paths, or images. Scanned
documents can be skewed, low contrast, or multilingual.

The converter should therefore be confidence-aware and diagnostic rather than
silent and overconfident.

## Required PDF And Content Coverage

The system should route each page through the best extraction path based on its
detected content type.

| PDF or content type | Detection signals | Conversion strategy | Expected fidelity |
| --- | --- | --- | --- |
| Simple born-digital text | Text operators, valid fonts, good ToUnicode maps | Extract glyphs, group lines and paragraphs, infer headings and lists | High |
| Tagged accessible PDF | StructTreeRoot, marked content, role maps | Prefer tags, verify against geometry | High when tags are accurate |
| Born-digital with broken fonts | Text exists but Unicode mapping is weak | Use ToUnicode, encoding heuristics, glyph-name fallback, OCR fallback | Medium |
| Scanned PDF | Page is mostly image, little or no embedded text | Rasterize, deskew, OCR, run layout analysis | Depends on scan quality |
| Searchable scanned PDF | Image plus hidden OCR text | Align hidden text against fresh OCR and geometry | Medium to high |
| Long manuals and books | Many pages, repeated headers, TOC, bookmarks | Stream pages, remove running headers, preserve anchors | High for text |
| Scientific papers | Multi-column layout, equations, captions, references | Segment layout, resolve reading order, preserve formulas and captions | Medium to high |
| Visible-border tables | Text boxes plus ruling lines or paths | Detect grid, assign cells, infer spans | High |
| Borderless tables | Aligned text and whitespace | ML table detector plus row/column inference | Medium |
| Complex tables | Spans, nested headers, notes | Output HTML table or image plus CSV sidecar | Medium |
| Forms | AcroForm widgets, field values, checkboxes | Extract fields and values, preserve widget metadata | Medium |
| Slides and brochures | Large text boxes, images, arbitrary visual order | Preserve page sections and warn on uncertain reading order | Medium |
| Diagrams, charts, CAD, vector pages | Many paths, little text | Extract or render assets; do not invent hidden semantics | Low to medium |
| Equations | Formula-like glyph density, math fonts, cropped regions | Preserve Unicode or use formula OCR to LaTeX where possible | Medium |
| Handwriting | Non-printed scanned text | Optional handwriting OCR behind confidence gates | Low to medium |
| RTL, CJK, vertical writing | Script and direction detection | Direction-aware line grouping and Unicode normalization | Medium to high |
| Damaged PDFs | Xref or object parse errors | Repair mode, object scan, structured warnings | Variable |
| Encrypted PDFs | Encrypt dictionary | Require password; do not bypass encryption | Password-dependent |
| Attachments, signatures, media, 3D | Catalog entries, annotations, embedded files | Extract metadata/assets; do not flatten misleadingly | Metadata only |

The phrase "handle all PDFs" should mean:

- Do not crash.
- Extract the best available representation.
- Preserve unsupported content as assets or sidecar JSON.
- Mark uncertainty with warnings and confidence.
- Degrade predictably under hostile or malformed input.

## Architecture Overview

The source session recommended an internal flow like this:

```text
PDF bytes
  -> preflight and security limits
  -> PDF parser
  -> page tree, resources, fonts, streams, images, tags, forms
  -> page content interpreter
  -> primitive page elements
  -> page triage
  -> page IR
  -> layout, reading order, tables, figures, equations
  -> document-level resolver
  -> Markdown AST
  -> Markdown, assets, JSON, warnings, confidence
```

The key internal artifacts should be a Page IR and Document IR. Markdown should
be the final serialization layer, not the place where structure is discovered.

Example Page IR:

```ts
type PageIr = {
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  sourceType: "digital" | "scanned" | "hybrid";
  elements: PageElement[];
};

type PageElement =
  | TextBlock
  | TableBlock
  | FigureBlock
  | EquationBlock
  | FormFieldBlock
  | AnnotationBlock
  | UnknownBlock;

type TextBlock = {
  kind: "text";
  role:
    | "title"
    | "heading"
    | "paragraph"
    | "list-item"
    | "caption"
    | "footnote"
    | "header"
    | "footer"
    | "code"
    | "unknown";
  bbox: BBox;
  spans: TextSpan[];
  readingOrder: number;
  confidence: number;
  source: "pdf-text" | "ocr" | "tagged-pdf" | "merged";
};

type TextSpan = {
  text: string;
  bbox: BBox;
  fontName?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  direction?: "ltr" | "rtl" | "ttb";
  confidence: number;
};
```

Everything downstream should consume this IR. The Markdown writer should not need
to know whether a text span came from a ToUnicode map, OCR, tagged PDF, or a
merged source. It should receive normalized structure plus provenance.

## Implementation Stack

Use a Rust + TypeScript split.

Rust compiled to WebAssembly should own:

- Byte tokenizer.
- PDF primitive parser.
- Indirect objects.
- Cross-reference tables and streams.
- Object streams.
- Stream-filter orchestration.
- Page tree and resource resolution.
- Font and CMap handling.
- Content stream interpretation.
- Glyph geometry.
- Layout heuristics that do not require ML.
- Basic table geometry heuristics.
- Markdown AST serialization primitives.
- Diagnostics and provenance data.

TypeScript should own:

- Public npm API.
- Browser and Node entrypoints.
- Worker orchestration.
- WASM loading.
- Model loading and caching.
- WebGPU feature detection.
- ONNX/WebGPU or other ML runtime integration.
- File-system, virtual, and callback asset adapters.
- CLI.
- Developer experience and examples.

This split keeps the parser and extraction core memory-safe, portable, and
deterministic while leaving packaging and runtime orchestration in the language
expected by npm consumers.

## WebAssembly Scope

WebAssembly is best for CPU-heavy deterministic work:

| Component | Suitability | Notes |
| --- | --- | --- |
| PDF tokenizer and parser | Excellent | Branch-heavy, byte-oriented, security-sensitive |
| Xref repair and object scan | Excellent | Needs hard bounds and fuzzing |
| Stream filters | Good | Use audited codecs where possible |
| Font and CMap decoding | Good | Complex but deterministic |
| Text geometry | Excellent | Numeric and stateful |
| Layout heuristics | Good | CPU path should exist even when ML is disabled |
| Table geometry heuristics | Good | Lines, boxes, alignment, spans |
| Markdown serialization | Good | Deterministic and testable |
| Full PDF rendering | Medium | Possible, but large and difficult |
| OCR inference | Medium | CPU fallback works, GPU is better for throughput |
| ML layout/table/equation inference | Medium | Better handled by GPU-capable model runtimes |

WebAssembly threads can help with page-level parallelism, but browser pthread
support depends on cross-origin isolation. Publish both a single-thread build and
a threaded build:

```text
pdf2md_single.wasm
pdf2md_threads.wasm
```

The single-thread build should work in ordinary secure contexts. The threaded
build should document the COOP and COEP headers required for SharedArrayBuffer.

## WebGPU Scope

WebGPU should be an acceleration layer, not the foundation of correctness.

Good WebGPU targets:

- OCR detection.
- OCR recognition.
- Layout segmentation.
- Table detection.
- Table-structure recognition.
- Equation recognition.
- Image preprocessing.
- Batch tensor operations.

Poor WebGPU targets:

- PDF object parsing.
- Xref repair.
- Font mapping.
- Markdown generation.
- Complex PDF graphics-state interpretation.

The recommended first implementation is for TypeScript to orchestrate model
inference, with the WASM core producing page images, crops, boxes, and tensors.
Only introduce Rust `wgpu` kernels after benchmarks show a concrete advantage.

Every WebGPU path must have:

- Feature detection.
- Device acquisition failure handling.
- CPU fallback.
- Test parity between CPU and GPU results.
- Batching to avoid tiny per-glyph or per-word GPU calls.

## PDF Parser Design

The parser must be tolerant. It should handle:

- Extra bytes before the PDF header.
- Incorrect line endings.
- Wrong stream lengths.
- Broken xref offsets.
- Incremental updates.
- Hybrid xrefs.
- Object streams.
- Xref streams.
- Truncated EOF markers.
- Producer-specific quirks.

Core modules:

```text
pdf_syntax
  tokenizer
  primitive objects
  arrays
  dictionaries
  names
  strings
  streams

pdf_objects
  indirect objects
  object references
  xref tables
  xref streams
  object streams
  repair scanner

pdf_doc
  catalog
  page tree
  outlines
  metadata
  encryption detection
  name trees

pdf_resources
  inherited resources
  fonts
  XObjects
  images
  color spaces
  patterns
  ExtGState

pdf_content
  graphics state
  text state
  transformation matrices
  path operators
  image placement
  marked content
```

The first renderer goal is not pixel-perfect output. The first goal is accurate
extraction geometry: glyphs, boxes, images, paths, marked-content spans, and
source provenance.

## Stream Filters And Codecs

A usable engine must support common stream filters:

- FlateDecode.
- ASCIIHexDecode.
- ASCII85Decode.
- RunLengthDecode.
- LZWDecode.
- DCTDecode / JPEG.
- JPXDecode / JPEG2000.
- CCITTFaxDecode.
- JBIG2Decode.
- Crypt filter.
- PNG and TIFF predictors.

Do not reimplement every codec from scratch unless that is explicitly a research
goal. Use audited, WASM-compatible decoders behind narrow interfaces. The
custom value is in the PDF-to-Markdown pipeline, not in writing new image codecs
for legacy compression formats.

## Text Extraction

Text extraction should produce glyphs with Unicode, geometry, confidence, and
mapping provenance.

Pipeline:

```text
content stream code
  -> font encoding
  -> CMap or descendant font
  -> ToUnicode map
  -> glyph-name fallback
  -> encoding heuristic fallback
  -> OCR fallback if confidence is low
```

Store:

```ts
type Glyph = {
  rawCode: number[];
  unicode: string;
  bbox: BBox;
  baseline: Line;
  confidence: number;
  mappingSource:
    | "ToUnicode"
    | "encoding"
    | "cmap"
    | "glyph-name"
    | "ocr"
    | "unknown";
};
```

Common problems:

- Ligatures.
- Custom embedded fonts.
- Missing ToUnicode maps.
- Subset font names.
- Symbol fonts.
- Math fonts.
- CJK CID fonts.
- RTL scripts.
- Vertical writing.
- Fake bold or italic.
- Text drawn as vector paths.
- Invisible OCR layers.

Line and paragraph reconstruction should use baseline proximity, font metrics,
word spacing, indentation, leading, columns, page regions, punctuation, and
document-wide patterns. It should not trust content stream order by itself.

## OCR For Scanned And Hybrid PDFs

OCR should be automatic but not always-on. Trigger OCR when:

- Text coverage is low.
- The page is image-dominant.
- Embedded text has poor Unicode confidence.
- Hidden OCR text conflicts with visible raster text.
- The user forces OCR.

OCR pipeline:

```text
page rasterization
  -> DPI selection
  -> grayscale and binarization
  -> deskew
  -> denoise
  -> orientation detection
  -> text region detection
  -> text-line crops
  -> OCR recognition
  -> box alignment
  -> layout role assignment
  -> merge with PDF text when hybrid
```

OCR results should carry confidence and provenance. For hybrid pages, align OCR
text with the PDF text layer and choose the better source per region rather than
blindly replacing the whole page.

## Layout Analysis

Born-digital layout should start with heuristics:

- Merge glyphs into words.
- Merge words into lines.
- Merge lines into blocks.
- Detect columns.
- Detect headings from font size, style, spacing, and numbering.
- Detect lists from markers, indentation, and alignment.
- Detect captions from position and labels.
- Remove repeated headers and footers.
- Preserve page anchors.

Complex pages and scans should use ML-assisted segmentation:

- Title.
- Heading.
- Paragraph.
- List.
- Table.
- Figure.
- Caption.
- Formula.
- Header.
- Footer.
- Footnote.

Reading order should be an explicit output, not an accidental side effect. The
engine should warn when reading order confidence is low, especially for
brochures, slides, multi-column pages, and visually dense scientific papers.

## Table Extraction

Tables are one of the highest-risk parts of the product because Markdown has
limited table expressiveness.

Table categories:

- Visible grid tables.
- Partially ruled tables.
- Borderless alignment tables.
- Financial statements.
- Multi-page tables.
- Nested header tables.
- Tables with row spans or column spans.
- Tables embedded in scans.
- Tables represented as images.

Born-digital extraction should combine:

- Text boxes.
- Ruling lines.
- Vector paths.
- Whitespace alignment.
- Font and baseline grouping.
- Header detection.
- Cell adjacency.
- Span inference.

Scanned and borderless extraction should combine:

- Raster line detection.
- ML table detection.
- ML table-structure recognition.
- OCR text boxes.
- Alignment heuristics.

Markdown serialization rules:

- Use GFM pipe tables only for simple rectangular tables.
- Use HTML tables when row spans, column spans, nested headers, or complex notes
  are required.
- Emit CSV sidecars for machine-readable table data when appropriate.
- Render table regions as assets when structure confidence is too low.
- Always preserve table metadata and confidence in JSON.

## Equations, Code, Figures, And Charts

Equations:

- Preserve Unicode equations when they are directly recoverable.
- Detect math-font and formula-heavy regions.
- Use formula OCR for raster equations where available.
- Prefer LaTeX output only when confidence is acceptable.
- Fall back to an image asset plus warning when recognition is weak.

Code blocks:

- Detect monospace fonts, indentation, preserved whitespace, and line grouping.
- Avoid paragraph reflow inside code-like regions.
- Escape Markdown carefully.

Figures:

- Extract native embedded images when possible.
- Render page regions when an image is composited, transformed, clipped, or mixed
  with vector paths.
- Group images with captions and labels.
- Link assets from Markdown and include structured JSON metadata.

Charts:

- Do not invent tabular data unless it is actually recoverable.
- Preserve the chart as an asset.
- Optionally include detected title, axes, legend, and caption.
- Gate chart-data reconstruction behind confidence scores.

## Forms, Annotations, Attachments, And Signatures

Forms:

- Extract AcroForm field names, types, values, checkboxes, widget boxes, and
  alternate names.
- Represent simple forms as Markdown checklists or field tables.
- Preserve full form details in JSON.

XFA:

- Detect XFA.
- Extract available XML packets when possible.
- Warn that visual rendering support is limited unless implemented.
- Fall back to page render plus OCR when needed.

Annotations:

- Extract links, highlights, comments, sticky notes, ink annotations, redaction
  annotations, and file attachments.
- Do not mix annotations into body text without provenance.

Signatures:

- Do not convert signatures into plain text.
- Preserve signature field presence and metadata.
- Include validation status only if a real validation module exists.
- Preserve visual signature appearances as assets where applicable.

## Packaging Plan

Recommended package layout:

```text
packages/
  pdf2md/
    src/
      index.ts
      browser.ts
      node.ts
      worker.ts
      wasm-loader.ts
      gpu.ts
      models.ts
    dist/
      browser/index.mjs
      node/index.mjs
      worker.mjs
      wasm/pdf2md_single.wasm
      wasm/pdf2md_threads.wasm

  pdf2md-core/
    rust/
      crates/
        pdf_syntax/
        pdf_objects/
        pdf_streams/
        pdf_fonts/
        pdf_content/
        pdf_layout/
        pdf_tables/
        md_ast/
        wasm_api/

  pdf2md-cli/
    src/cli.ts

  pdf2md-models-layout/
  pdf2md-models-ocr-en/
  pdf2md-models-ocr-multilingual/
  pdf2md-models-table/
```

Package exports:

```json
{
  "name": "@your-scope/pdf2md",
  "type": "module",
  "exports": {
    ".": {
      "browser": "./dist/browser/index.mjs",
      "node": "./dist/node/index.mjs",
      "default": "./dist/browser/index.mjs"
    },
    "./worker": "./dist/worker.mjs",
    "./wasm-single": "./dist/wasm/pdf2md_single.wasm",
    "./wasm-threads": "./dist/wasm/pdf2md_threads.wasm"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ]
}
```

Initialization:

```ts
await initPdf2Md({
  locateWasm: (name) => new URL(`./wasm/${name}`, import.meta.url),
  locateModel: async (modelName) => fetch(`/models/${modelName}`),
  worker: true,
  gpu: "auto",
});
```

Browser deployment constraints must be documented:

- WebAssembly baseline build works in ordinary secure browser contexts.
- Threaded WASM build requires cross-origin isolation.
- WebGPU requires `navigator.gpu` and successful adapter/device creation.
- CPU fallback must be available for all WebGPU features.
- Large model packages should be optional or lazy-loaded.

## Performance Strategy

The implementation must be streaming. Never rasterize a full long document into
memory. A single A4 page at 300 DPI can be tens of megabytes as raw RGBA pixels,
so a 1,000-page manual can exhaust memory immediately if processed naively.

Rules:

- Parse document metadata and page references once.
- Process pages through a bounded queue.
- Release raster buffers as soon as possible.
- Store compact IR, assets, and diagnostics incrementally.
- Use workers for page-level parallelism.
- Use adaptive concurrency based on memory pressure.
- Keep a fast path for born-digital PDFs that do not need OCR.
- Batch GPU inference calls across lines, regions, tables, or page thumbnails.

Fast path:

```text
parse page
  -> extract glyphs
  -> infer layout
  -> detect simple tables
  -> serialize Markdown
```

OCR path:

```text
render page
  -> preprocess
  -> OCR and layout
  -> reconcile with PDF text
  -> serialize Markdown and assets
```

## Confidence And Diagnostics

Every extracted element should have confidence. The system should expose both a
human-readable warning stream and structured per-element confidence.

Example confidence model:

```ts
type Confidence = {
  text: number;
  unicodeMapping: number;
  bbox: number;
  readingOrder: number;
  role: number;
  tableStructure?: number;
  ocr?: number;
};
```

Example warnings:

```json
{
  "code": "LOW_UNICODE_CONFIDENCE",
  "severity": "warning",
  "page": 17,
  "message": "Font F23 has no ToUnicode map; text was reconstructed using glyph-name and OCR fallback."
}
```

```json
{
  "code": "COMPLEX_TABLE_HTML_FALLBACK",
  "severity": "info",
  "page": 42,
  "message": "Table contains spans; emitted HTML instead of a GFM pipe table."
}
```

Warnings are part of the product. They prevent false confidence and let callers
choose whether a converted document is good enough for search, RAG ingestion,
human review, archival, or compliance workflows.

## Security Requirements

PDFs are attacker-controlled binary inputs. Treat them like image, archive, and
video formats, not like plain text.

Non-negotiable rules:

- Do not execute PDF JavaScript.
- Do not fetch external resources.
- Do not follow launch or file actions.
- Do not trust declared stream lengths.
- Do not allocate unbounded buffers.
- Do not recursively resolve objects without depth limits.
- Do not rasterize at unbounded DPI.
- Do not let image or compression bombs exhaust memory.
- Do not block the browser main thread.
- Do not crash Node on malformed input.

Expose hard limits:

```ts
limits: {
  maxPages: 5000,
  maxObjects: 2_000_000,
  maxStreamBytes: 256 * 1024 * 1024,
  maxImagePixels: 100_000_000,
  maxRenderDpi: 400,
  pageTimeoutMs: 30_000,
  documentTimeoutMs: 600_000,
  maxRecursionDepth: 128,
}
```

Create fuzz targets for:

- Tokenizer.
- Xref parser.
- Object parser.
- Stream decoder.
- CMap parser.
- Font parser.
- Content stream interpreter.
- Image metadata parser.
- Page tree resolver.
- Markdown serializer.

## Testing And Benchmark Plan

Build a corpus before over-optimizing the implementation. The corpus should
include:

- PDF 1.3, 1.4, 1.5, 1.7, and 2.0 files.
- Linearized PDFs.
- Incrementally updated PDFs.
- Object streams and xref streams.
- Encrypted PDFs with known passwords.
- Damaged xref PDFs.
- Tagged PDFs.
- PDF/UA examples.
- Simple born-digital text PDFs.
- Custom-font PDFs.
- CJK PDFs.
- RTL PDFs.
- Vertical-writing PDFs.
- Scanned PDFs.
- Searchable scanned PDFs.
- Bad OCR overlays.
- Long manuals over 1,000 pages.
- Scientific papers.
- Financial statements.
- Government forms.
- Invoices and receipts.
- Slides and brochures.
- CAD and vector-heavy pages.
- Annotations.
- Attachments.
- AcroForms.
- XFA samples.
- Rotated and cropped pages.
- Huge images.
- Tiny fonts.
- Tables split across pages.

Metrics:

| Area | Metrics |
| --- | --- |
| Text | Character error rate, word error rate, Unicode mapping accuracy |
| Paragraphs | Paragraph grouping F1, hyphenation accuracy |
| Layout | Block detection, role classification, reading-order edit distance |
| Headers/footers | Removal precision and recall |
| Tables | Detection, cell adjacency, span accuracy, CSV cell text accuracy |
| Markdown | AST diff, rendered HTML semantic diff, asset link validity |
| Performance | Pages per second, peak memory, startup time, GPU speedup |
| Security | No panics, bounded memory, timeout enforcement, fuzz stability |

Reference engines and systems to study or benchmark:

- PDF.js.
- PDFium.
- MuPDF.js.
- Tesseract.js.
- PaddleOCR.
- ONNX Runtime Web.
- Docling.
- Marker.
- MinerU.
- Mistral OCR.

Use these as quality baselines, differential oracles, and edge-case discovery
sources. Do not blindly ship them as production dependencies without license,
size, security, and browser-compatibility review.

## Licensing Strategy

The custom library should separate:

- Runtime dependencies.
- Optional model packages.
- Development-only oracle adapters.
- Test corpus licenses.
- Documentation and examples.

Recommended stance:

- Do not bundle engines with incompatible licenses unless that license is
  explicitly acceptable for the project.
- Keep model licenses separate and visible.
- Publish third-party notices.
- Use mature engines as differential oracles in CI where legally and
  practically acceptable.
- Keep the production core under the chosen project license.

## AI-Agent Implementation Plan

The source session emphasized that AI agents should not be asked to implement
"PDF-to-Markdown" as one broad task. Split the work into narrow modules with
contracts, tests, and definitions of done.

### Agent 1: PDF Syntax Core

Owns:

- Tokenizer.
- Primitive objects.
- Indirect objects.
- Xref tables.
- Xref streams.
- Trailers.
- Incremental updates.
- Object streams.
- Repair scanner.

Done when:

- Synthetic PDFs parse.
- Real corpus metadata parses.
- Fuzz tests do not panic.
- Object counts match reference oracles where practical.
- Malformed input returns structured errors.

### Agent 2: Stream Filters

Owns:

- Flate.
- ASCIIHex.
- ASCII85.
- RunLength.
- LZW.
- Predictors.
- Filter chaining.
- Bounded allocation.

Done when:

- Golden streams decode correctly.
- Corrupt streams return structured errors.
- Allocation limits are enforced.

### Agent 3: Page And Resource Resolver

Owns:

- Catalog.
- Pages tree.
- Resource inheritance.
- Page boxes.
- Rotation.
- XObjects.
- Images.
- Metadata.
- Outlines.
- Annotation skeleton.

### Agent 4: Text Extraction And Fonts

Owns:

- Font dictionaries.
- Encodings.
- ToUnicode CMaps.
- CID fonts.
- Glyph positioning.
- Text state.
- Unicode normalization.
- Mapping confidence.

### Agent 5: Layout Heuristics

Owns:

- Line grouping.
- Paragraph grouping.
- Columns.
- Headings.
- Lists.
- Headers and footers.
- Footnotes.
- Reading order.

### Agent 6: Table Geometry

Owns:

- Ruling-line detection.
- Text-alignment tables.
- Cell grid inference.
- Row and column spans.
- GFM versus HTML table decisions.
- CSV sidecar generation.

### Agent 7: OCR And WebGPU Adapter

Owns:

- WebGPU feature detection.
- ML runtime integration.
- Model loading.
- CPU fallback.
- Batching.
- Confidence propagation.
- OCR/PDF text reconciliation.

### Agent 8: Markdown AST And Writer

Owns:

- CommonMark/GFM serialization.
- Escaping.
- HTML fallback blocks.
- Asset links.
- Front matter.
- Page anchors.
- Source maps.

### Agent 9: QA, Fuzzing, And Differential Testing

Owns:

- Golden corpus.
- Oracle adapters.
- Fuzz harnesses.
- Snapshot tests.
- Rendered HTML diffs.
- Performance tracking.

### Agent 10: Packaging And Developer Experience

Owns:

- npm exports.
- Browser and Node builds.
- Workers.
- WASM loading.
- Threaded and single-thread builds.
- CLI.
- Examples.
- Documentation.

## Roadmap By Capability Gates

### Gate 0: Specification And Corpus

Deliver:

- IR schema.
- Markdown AST schema.
- Warning taxonomy.
- Test corpus layout.
- Oracle runner design.
- Benchmark CLI.

### Gate 1: Born-Digital Text MVP

Deliver:

- Basic parser.
- Page tree.
- Content stream text extraction.
- ToUnicode support.
- Line and paragraph grouping.
- Markdown output.
- OCR disabled.
- Assets disabled except basic metadata.

Target PDFs:

- Simple reports.
- Manual pages.
- Invoices with normal fonts.
- Academic papers without complex tables.

### Gate 2: Robust PDF Parsing

Deliver:

- Xref streams.
- Object streams.
- Incremental updates.
- Repair mode.
- More filters.
- Metadata.
- Outlines.
- Annotation skeleton.
- Encryption detection.
- Password handling.

### Gate 3: Layout And Document Structure

Deliver:

- Headings.
- Lists.
- Columns.
- Headers and footers.
- Footnotes.
- Page anchors.
- TOC and bookmark integration.
- Confidence model.

### Gate 4: Tables V1

Deliver:

- Visible-border table extraction.
- Alignment-based simple tables.
- GFM pipe tables.
- HTML fallback.
- CSV sidecars.

### Gate 5: Raster And OCR Path

Deliver:

- Page rasterization path.
- Scan detection.
- CPU OCR path.
- OCR text boxes.
- OCR/PDF text reconciliation.

### Gate 6: WebGPU Acceleration

Deliver:

- WebGPU feature detection.
- GPU inference provider integration.
- OCR acceleration.
- Layout-model acceleration.
- Batching.
- CPU fallback parity.

### Gate 7: Advanced Document Intelligence

Deliver:

- Table-structure model.
- Formula detection and OCR.
- Figure/caption grouping.
- Forms.
- Complex annotations.
- Multilingual expansion.

### Gate 8: Hardening

Deliver:

- Large manual benchmark.
- Fuzzing.
- Malformed PDF corpus.
- Memory caps.
- DoS protection.
- Performance dashboards.
- Browser compatibility matrix.

## Recommended Internal Data Flow

For each page:

```text
1. Resolve page resources.
2. Interpret content stream into primitive elements:
   - glyphs
   - images
   - paths
   - marked-content spans
3. Estimate page type:
   - digital
   - scanned
   - hybrid
4. If digital:
   - extract text from glyphs
   - run geometry layout
   - optionally render thumbnail for layout ML
5. If scanned:
   - render page
   - run OCR
   - run layout ML
6. If hybrid:
   - compare PDF text layer and OCR
   - align boxes
   - choose source per region
7. Detect tables and figures.
8. Build page-level reading order.
9. Merge into document-level structure.
10. Emit Markdown AST.
11. Serialize Markdown, assets, JSON, warnings, and confidence.
```

## From-Scratch Interpretation

There are three possible interpretations of "from scratch."

### Option A: Product From Scratch

Write the PDF-to-Markdown pipeline, IR, layout logic, table logic, OCR
orchestration, Markdown writer, npm packaging, and developer experience. Use
established dependencies for codecs, ML runtimes, optional model execution, and
development oracles.

This is the best business choice.

### Option B: PDF Engine From Scratch

Write the parser, text extractor, partial content interpreter, and conversion
pipeline while still using external image codecs and ML runtimes.

This is feasible and aligned with the source-session goal.

### Option C: Everything From Scratch

Write the PDF parser, every filter and image codec, full renderer, OCR models,
ML inference runtime, table models, Markdown writer, browser/Node packaging, and
all compatibility layers.

This is technically possible but not a pragmatic first product path. It delays
useful quality and increases security risk.

The recommended interpretation is Option B with carefully chosen dependencies
and full ownership of the document-conversion logic.

## Main Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Bad Unicode extraction | Markdown becomes gibberish | ToUnicode first, fallbacks, OCR reconciliation |
| Reading order errors | Multi-column documents become nonsense | Geometry plus layout models plus confidence |
| Complex tables | Markdown cannot represent spans | HTML fallback, CSV sidecar, rendered asset |
| Scan quality variation | OCR can fail badly | Preprocessing, multiple paths, confidence |
| Huge PDFs | Memory blowups | Streaming, bounded queues, page-level processing |
| Malformed PDFs | Crashes and security issues | Repair mode, fuzzing, timeouts, hard limits |
| WebGPU availability | Not universal enough for correctness | CPU fallback and feature detection |
| npm package size | OCR/layout models can be large | Optional packages and lazy loading |
| Licensing | Some engines/models may be incompatible | License review and oracle-only adapters |
| Overpromising | "All PDFs" can imply impossible fidelity | Diagnostics, confidence, asset preservation |

## Final Recommendation

Build the library around this shape:

```text
@your-scope/pdf2md
  TypeScript API
  browser and Node entrypoints
  worker orchestration
  WASM loading
  WebGPU and ML adapters
  model loading
  CLI

Rust/WASM core
  pdf_syntax
  pdf_objects
  pdf_streams
  pdf_fonts
  pdf_content
  pdf_layout
  pdf_tables
  md_ast
  diagnostics

Optional model packages
  OCR detector
  OCR recognizer
  layout detector
  table structure recognizer
  formula recognizer

Development-only oracle adapters
  PDF.js
  PDFium
  MuPDF
  Docling
  Marker
  MinerU
  Mistral OCR
```

The first useful milestone should not be "supports every PDF." It should be a
born-digital text MVP with a stable IR, bounded parser, good Markdown output,
diagnostics, and a corpus-driven test loop. From there, add robust parsing,
layout, tables, OCR, WebGPU acceleration, advanced document intelligence, and
hardening in separate gates.

The winning implementation will be fast on clean PDFs, transparent on uncertain
PDFs, resilient on malformed PDFs, and honest about content that Markdown cannot
represent.
