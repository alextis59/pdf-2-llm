# PDF-to-Markdown Implementation Plan

Source study: [WebAssembly + WebGPU PDF-to-Markdown Study](pdf-to-markdown-webassembly-study.md)

This plan turns the study into a tracked implementation sequence for an
AI-agent-friendly PDF-to-Markdown npm package backed by a Rust/WebAssembly core,
TypeScript orchestration, optional OCR, and optional WebGPU acceleration.

The first implementation milestone is not code generation. It is a validation
corpus with clear acceptance criteria. PDF extraction quality cannot be judged
from generic unit tests alone because the hard parts are document-specific:
Unicode recovery, reading order, tables, scan quality, accessibility tags,
forms, annotations, and graceful failure on malformed files.

## Tracking Rules

- Do not check an item until its tests, fixtures, or review artifact exist.
- Every externally retrieved PDF must have source URL, retrieval date, license
  notes, redistribution status, SHA-256, and file size recorded in the corpus
  manifest.
- Every generated or mutated PDF must have a reproducible generator command.
- Every corpus PDF must have an acceptance file before it is used as a release
  gate.
- Unsupported content is acceptable only when the expected warning, sidecar, or
  asset fallback is documented.
- Markdown snapshots should be reviewed through rendered HTML as well as raw
  text.
- The core parser must return structured errors, never panics, for bad input.
- WebGPU is never required for correctness; CPU fallback parity is mandatory.

## Target Repository Shape

```text
pdf-2-llm/
  Cargo.toml
  crates/
    pdf2md_core/
    pdf2md_wasm/
    pdf2md_fuzz/
  packages/
    pdf2md/
      src/
      test/
      examples/
      package.json
  corpus/
    manifest.json
    raw/
    generated/
    mutated/
    accepted/
    expected/
    baselines/
    reports/
  scripts/
    corpus/
      retrieve.ts
      analyze.ts
      generate-fixtures.ts
      mutate-fixtures.ts
      compare-oracles.ts
    qa/
      run-corpus.ts
      render-markdown.ts
      diff-html.ts
  docs/
    pdf-to-markdown-webassembly-study.md
    pdf-to-markdown-implementation-plan.md
```

The exact package names can change later, but the implementation should keep
these boundaries:

- Rust owns PDF syntax, object resolution, content interpretation, geometry IR,
  deterministic layout logic, table geometry, warnings, and confidence.
- TypeScript owns package exports, worker orchestration, WASM loading, browser
  and Node entrypoints, CLI wiring, optional model loading, and user-facing API.
- OCR and ML adapters are optional modules with explicit CPU and WebGPU paths.
- Test and benchmark infrastructure is a product feature, not a one-off script.

## Phase 0: Corpus, Specification, And Acceptance Criteria

Goal: build the test corpus and define expected outcomes before implementing
the extraction pipeline.

### 0.1 Corpus Policy

- [x] Create `corpus/README.md` explaining how PDFs enter the corpus.
- [x] Create `corpus/manifest.json` with schema validation.
- [x] Add fields for `id`, `kind`, `source`, `retrievedAt`, `license`,
  `redistributable`, `sha256`, `bytes`, `pages`, `pdfVersion`, `features`,
  `acceptanceFile`, and `notes`.
- [x] Add a `redistributable: false` path for PDFs that can be used locally but
  must not be committed.
- [x] Add `.gitignore` rules for non-redistributable raw PDFs.
- [x] Add a rule that committed PDFs must be public domain, permissively
  licensed, self-generated, or otherwise cleared for redistribution.
- [x] Add a rule that external oracle outputs are not treated as ground truth
  until they have been reviewed.
- [x] Add a scriptable SHA-256 check so corpus drift is caught in CI.
- [x] Add a storage policy for large fixtures, including a size threshold for
  Git LFS or external artifact storage.

### 0.2 PDF Retrieval Matrix

Retrieve a deliberately mixed corpus. The first pass should be small enough to
review by hand, then it can expand after the pipeline stabilizes.

| Corpus group | Minimum count | Retrieval strategy | Why it matters |
| --- | ---: | --- | --- |
| Synthetic exact-output PDFs | 15 | Generate locally from HTML/Typst/LaTeX/ReportLab | Provides deterministic expected Markdown |
| Simple born-digital reports | 5 | Public reports with normal text | Baseline text, paragraphs, headings, links |
| Tagged accessible PDFs | 5 | Public tagged/PDF-UA examples | Tests tag preference and tag/geometry validation |
| Broken or unusual fonts | 5 | Public samples plus generated custom encodings | Tests ToUnicode and fallback confidence |
| PDF version/features | 10 | Public samples plus generated qpdf variants | Covers xref tables, xref streams, object streams |
| Linearized PDFs | 3 | Public samples or `qpdf --linearize` | Tests hint tables and streamed loading assumptions |
| Incremental updates | 3 | Generate with append-only edits | Tests newest object resolution |
| Encrypted PDFs | 3 | Generate with known passwords | Tests password handling without bypassing encryption |
| Damaged PDFs | 5 | Mutate known-good fixtures | Tests repair mode and structured errors |
| Scanned PDFs | 5 | Public-domain scans or generated page images | Tests raster path and OCR routing |
| Searchable scanned PDFs | 5 | Public OCR PDFs or generated OCR overlays | Tests hidden text/OCR reconciliation |
| Bad OCR overlays | 3 | Mutate OCR layer positions/text | Tests distrust of bad hidden text |
| Long manuals/books | 3 | Open manuals over 500 pages, one over 1,000 if practical | Tests streaming, repeated headers, memory |
| Scientific papers | 5 | Open papers with columns, formulas, references | Tests reading order, equations, captions |
| Visible-border tables | 5 | Generated plus public financial/government tables | Tests ruling-line table extraction |
| Borderless tables | 5 | Generated plus public reports | Tests whitespace/alignment inference |
| Complex tables | 5 | Generated span/nested-header cases | Tests HTML fallback and CSV sidecars |
| Government forms | 5 | Public forms with fields/check boxes | Tests AcroForm and field-value extraction |
| Invoices and receipts | 5 | Generated and permissive samples | Tests dense key-value layout |
| Slides and brochures | 5 | Public-domain or generated decks/brochures | Tests arbitrary visual order and warnings |
| Diagrams/charts/vector pages | 5 | Public-domain vector-heavy samples plus generated charts | Tests asset preservation and no hallucinated semantics |
| Equations | 5 | LaTeX-generated pages and open papers | Tests Unicode/LaTeX equation fallback |
| RTL scripts | 3 | Public or generated Arabic/Hebrew PDFs | Tests direction-aware grouping |
| CJK scripts | 3 | Public or generated Chinese/Japanese/Korean PDFs | Tests CID fonts and line grouping |
| Vertical writing | 2 | Generated or public Japanese vertical text | Tests writing mode handling |
| Rotated/cropped pages | 5 | Generated transformations | Tests coordinate normalization |
| Tiny fonts and huge images | 4 | Generated stress fixtures | Tests caps, scaling, and OCR behavior |
| Annotations and links | 5 | Generated plus public annotated PDFs | Tests link/comment extraction |
| Attachments | 3 | Generated embedded-file PDFs | Tests sidecar metadata extraction |
| Signatures | 3 | Public or generated signed samples | Tests metadata reporting without validation claims |
| XFA samples | 2 | Public samples if license permits; otherwise local-only | Tests explicit unsupported or fallback path |

Checklist:

- [x] Create initial candidate list for every corpus group.
- [x] Label each candidate as `commit-ok`, `local-only`, or `do-not-use`.
- [x] Prefer generated fixtures when exact expected output matters.
- [x] Prefer public-domain government or standards-adjacent PDFs for committed
  external fixtures.
- [x] Avoid committing copyrighted reports unless redistribution is explicitly
  allowed.
- [x] Store source URLs and retrieval commands before downloading.
- [x] Download candidates into `corpus/raw/_incoming/`.
- [x] Compute SHA-256 for every incoming PDF.
- [x] Run static analysis on every incoming PDF before acceptance review.
- [x] Move accepted raw PDFs into stable corpus group directories.
- [x] Remove or quarantine PDFs that cannot be legally retained or tested.

### 0.3 Retrieval Tooling

Implement retrieval as a reproducible script, not a manual browser download.

- [x] Add `scripts/corpus/retrieve.mjs`.
- [x] Add support for `--id`, `--group`, `--all`, and `--dry-run`.
- [x] Write downloads to a temporary file before moving into `corpus/raw/`.
- [x] Verify `Content-Type` and magic bytes.
- [x] Compute SHA-256 immediately after download.
- [x] Refuse to overwrite an existing PDF unless `--update` is passed.
- [x] Record HTTP status, final URL, and retrieval timestamp.
- [x] Support local file imports for generated or manually acquired PDFs.
- [x] Print license and redistribution status before accepting a candidate.
- [x] Make retrieval idempotent when hashes match.

### 0.4 Static PDF Analysis

Before writing expected Markdown, analyze every PDF so acceptance criteria are
based on what the file actually contains.

Recommended oracle tools for analysis only:

- `qpdf --json`
- `pdfinfo`
- `mutool show`
- `mutool draw`
- `pdftotext -bbox`
- `pdfimages -list`
- `exiftool`
- `ocrmypdf --sidecar` for OCR experiments
- Reference extractors such as PDF.js, PDFium, MuPDF, Docling, Marker, MinerU,
  and Tesseract where licensing and installation permit

Checklist:

- [x] Add `scripts/corpus/analyze.mjs`.
- [x] Extract page count, page boxes, rotation, version, encryption status, and
  linearization status.
- [x] Detect xref table versus xref stream where practical.
- [x] Detect object streams and compressed objects.
- [x] Detect tagged structure and role maps.
- [x] Detect AcroForm, XFA, annotations, outlines, attachments, signatures, and
  embedded files.
- [x] Count text operators and estimate glyph density per page.
- [x] Detect image-dominant pages and likely scanned pages.
- [x] Detect hidden OCR overlays by comparing text boxes with image-dominant
  pages.
- [x] Detect fonts, encodings, ToUnicode CMaps, CID fonts, and missing maps.
- [x] Detect path-heavy pages that likely contain tables, charts, or vector
  drawings.
- [x] Produce per-PDF analysis JSON under `corpus/baselines/<id>/analysis.json`.
- [x] Produce low-resolution page preview images for human review.
- [x] Produce oracle text outputs under `corpus/baselines/<id>/oracles/`.
- [x] Add analysis summaries to `corpus/reports/corpus-inventory.md`.

### 0.5 Acceptance Criteria Files

Every corpus PDF needs an acceptance file. The acceptance file defines what the
library must do for that PDF at a given capability gate.

Example:

```yaml
id: gov-form-w9-2026
gate: forms-v1
sourceType: digital
expectedMode: pdf-text
must:
  - extract_form_fields
  - preserve_checkbox_states
  - preserve_page_anchors
  - emit_markdown_without_binary_garbage
mustNot:
  - bypass_encryption
  - invent_missing_field_values
metrics:
  minTextCoverage: 0.98
  maxReadingOrderEdits: 5
  maxUnexpectedWarnings: 0
snippets:
  - page: 1
    contains: "Request for Taxpayer Identification Number"
  - page: 1
    contains: "Certification"
warnings:
  allowed:
    - unsupported_signature_validation
assets:
  required: []
review:
  humanReviewedBy: ""
  reviewedAt: ""
```

Checklist:

- [x] Add `corpus/accepted/<id>.yaml` files for the initial corpus.
- [x] Define gate labels such as `text-mvp`, `robust-parser`, `layout-v1`,
  `tables-v1`, `ocr-v1`, `webgpu-v1`, and `advanced-v1`.
- [x] Add `must` assertions for required extraction behavior.
- [x] Add `mustNot` assertions for hallucination, unsafe, or misleading output.
- [x] Add snippet assertions for critical text.
- [x] Add structural assertions for headings, lists, paragraphs, tables,
  fields, assets, links, and page anchors.
- [x] Add metric thresholds only when the oracle is reliable enough.
- [x] Add expected warnings for unsupported features.
- [x] Add explicit skip reasons for local-only or future-gate PDFs.
- [x] Require human review for every acceptance file before it becomes gating.

### 0.6 Initial Acceptance Review Workflow

For each accepted PDF:

- [ ] Open rendered page previews.
- [ ] Review oracle text from at least two tools.
- [ ] Identify the actual page reading order.
- [ ] Identify repeated headers, footers, page numbers, footnotes, and captions.
- [ ] Identify tables and classify them as GFM-safe, HTML-required, CSV sidecar,
  or image-only.
- [ ] Identify figures and decide whether captions are required.
- [ ] Identify forms, links, annotations, attachments, and metadata.
- [ ] Identify scripts and writing directions.
- [ ] Record expected warnings for content that should not be converted into
  Markdown semantics.
- [ ] Write representative expected Markdown snippets.
- [ ] Write a one-paragraph rationale for each metric threshold.
- [ ] Mark the PDF as `gating: true` only after review.

## Phase 1: Product Contracts And Scaffolding

Goal: create stable contracts so agents can implement modules independently.

### 1.1 Public API

- [x] Define `convertPdfToMarkdown(input, options)` TypeScript API.
- [x] Define browser, Node, worker, and CLI entrypoints.
- [x] Define `ConvertResult` with Markdown, assets, JSON IR, warnings,
  diagnostics, timing, and confidence.
- [x] Define option groups for OCR, WebGPU, assets, tables, security limits,
  page ranges, and output format.
- [x] Define streaming/progress callbacks for large PDFs.
- [x] Define cancellation with `AbortSignal`.
- [x] Define password callback behavior for encrypted PDFs.
- [x] Define deterministic output requirements for tests.

### 1.2 Internal IR Schemas

- [x] Define `DocumentIr`.
- [x] Define `PageIr`.
- [x] Define `PageElement` variants for text, table, figure, equation, form
  field, annotation, and asset reference.
- [x] Define `TextSpan` with Unicode text, glyph ids, font metadata, geometry,
  direction, confidence, and source.
- [x] Define table cell, row, column, span, and sidecar models.
- [x] Define warnings and diagnostics taxonomy.
- [x] Define source maps from Markdown back to page regions.
- [x] Add schema versioning.
- [x] Add JSON schema tests for serialized IR.

### 1.3 Build System

- [ ] Create Rust workspace.
- [x] Create TypeScript package workspace.
- [ ] Add `wasm-bindgen` or equivalent WASM bridge.
- [x] Add Node build target.
- [x] Add browser build target.
- [x] Add worker bundle target.
- [ ] Add single-threaded WASM build.
- [ ] Add threaded WASM build behind feature detection.
- [x] Add local examples for Node and browser.
- [ ] Add CI commands for Rust tests, TypeScript tests, lint, build, and corpus
  smoke tests.

### 1.4 Quality Gates

- [ ] Add unit test framework for Rust.
- [x] Add unit/integration test framework for TypeScript.
- [x] Add snapshot testing for Markdown.
- [x] Add snapshot testing for serialized IR.
- [x] Add rendered HTML diff helper.
- [x] Add oracle comparison helper.
- [x] Add corpus runner with `--gate`, `--id`, and `--update-snapshots`.
- [x] Add performance benchmark harness.
- [x] Add memory-limit and timeout tests.
- [x] Add fuzz target skeletons.

Definition of done:

- [x] `npm run build` succeeds.
- [ ] `cargo test --workspace` succeeds.
- [x] A synthetic single-page PDF can pass through a stub pipeline and return
  structured diagnostics.
- [x] The corpus runner can list accepted PDFs and skip future gates.

## Phase 2: Gate 1 - Born-Digital Text MVP

Goal: convert simple born-digital PDFs into usable Markdown without OCR or
assets.

### 2.1 PDF Syntax Core

- [x] Implement byte reader with bounded allocation.
- [x] Implement tokenizer for names, strings, hex strings, arrays,
  dictionaries, numbers, booleans, nulls, streams, and comments.
- [x] Implement indirect object parsing.
- [x] Implement xref table parsing.
- [x] Implement trailer parsing.
- [x] Implement object lookup.
- [x] Implement strict and tolerant parse modes.
- [x] Return structured errors with byte offsets.
- [x] Add unit tests for all primitive object types.
- [x] Add fuzz tests for tokenizer and object parser.

### 2.2 Basic Stream Filters

- [x] Implement or integrate Flate decode.
- [x] Implement ASCIIHex decode.
- [x] Implement ASCII85 decode.
- [x] Implement RunLength decode.
- [x] Implement PNG predictor handling for Flate streams.
- [x] Implement filter chains.
- [x] Enforce decoded-size limits.
- [x] Test corrupt stream behavior.

### 2.3 Page Tree And Resources

- [x] Resolve catalog.
- [x] Resolve pages tree.
- [x] Resolve inherited resources.
- [x] Resolve media box, crop box, rotation, and user unit.
- [x] Resolve content streams in order.
- [x] Resolve font dictionaries needed by text extraction.
- [x] Expose page metadata in IR.
- [x] Add tests for nested page trees and inherited resources.

### 2.4 Text Operators And Fonts

- [x] Implement graphics and text state stack needed for text extraction.
- [x] Interpret text showing operators.
- [x] Interpret text positioning operators.
- [x] Handle text matrices and current transformation matrix.
- [x] Parse simple fonts.
- [x] Parse ToUnicode CMaps.
- [x] Map glyphs to Unicode with confidence.
- [x] Preserve geometry for glyphs, spans, and lines.
- [x] Normalize common ligatures and whitespace.
- [x] Emit warnings for missing or suspicious Unicode maps.

### 2.5 Line, Paragraph, And Markdown MVP

- [x] Group glyphs into spans.
- [x] Group spans into lines.
- [x] Group lines into paragraphs.
- [x] Infer simple headings from size and spacing.
- [x] Infer simple bullet and numbered lists.
- [x] Remove obvious page numbers only when confidence is high.
- [x] Serialize CommonMark paragraphs, headings, and lists.
- [x] Escape Markdown metacharacters.
- [x] Add page anchors.
- [x] Preserve uncertain ordering with warnings.

Gate 1 acceptance:

- [x] All `text-mvp` synthetic PDFs pass exact or near-exact snapshots.
- [x] At least five simple public born-digital PDFs meet text coverage
  thresholds.
- [x] No parser panics on the full initial corpus.
- [x] Unsupported PDFs produce structured warnings or future-gate skips.
- [x] CLI can convert a local PDF to Markdown.
- [ ] Browser example can convert a small PDF through WASM.

## Phase 3: Gate 2 - Robust PDF Parsing

Goal: expand PDF compatibility before adding more semantic features.

### 3.1 Modern Object Structures

- [x] Implement xref streams.
- [x] Implement object streams.
- [x] Implement hybrid-reference files.
- [x] Implement incremental update resolution.
- [x] Prefer newest object revisions.
- [x] Add tests for generated qpdf variants.
- [x] Add corpus fixtures for xref stream and object stream PDFs.

### 3.2 More Filters And Encodings

- [x] Implement LZW decode if required by corpus.
- [x] Implement CCITT/JBIG2/JPEG/JPEG2000 metadata detection even before full
  raster support.
- [x] Implement predictor variants needed by image and object streams.
- [x] Add bounded allocation tests for all filters.
- [x] Add corrupt filter-chain tests.

### 3.3 Encryption And Password Handling

- [x] Detect encrypted PDFs.
- [x] Reject encrypted PDFs without a password.
- [x] Implement password callback path.
- [x] Implement supported standard security handlers as a scoped task.
- [x] Do not attempt bypasses.
- [x] Add known-password generated fixtures.
- [x] Add wrong-password tests.
- [x] Emit structured diagnostics for unsupported encryption.

### 3.4 Repair Mode

- [x] Implement object scanning fallback.
- [x] Recover from damaged xref tables when possible.
- [x] Distinguish repaired output from trusted output in diagnostics.
- [x] Add mutated damaged corpus fixtures.
- [x] Add timeout and max-object limits.
- [x] Add tests that unrecoverable files fail gracefully.

Gate 2 acceptance:

- [x] All robust-parser accepted PDFs either convert or fail with expected
  structured errors.
- [x] Generated xref-stream, object-stream, incremental-update, linearized, and
  encrypted fixtures pass.
- [x] Malformed corpus run has zero panics.
- [x] Fuzz targets run in CI smoke mode.

## Phase 4: Gate 3 - Layout And Document Structure

Goal: improve reading order and document structure for real-world documents.

### 4.1 Reading Order

- [x] Implement block segmentation from line geometry.
- [x] Detect single-column, multi-column, and mixed layouts.
- [x] Detect sidebars and callouts.
- [x] Detect footnotes.
- [x] Detect captions near figures and tables.
- [x] Resolve reading order within and across columns.
- [x] Add reading-order edit-distance metric.
- [x] Add visual debug overlays for block order.

### 4.2 Headers, Footers, And Repeated Content

- [x] Detect repeated page headers.
- [x] Detect repeated page footers.
- [x] Detect page numbers.
- [x] Preserve meaningful running titles when configured.
- [x] Remove repeated boilerplate only above a confidence threshold.
- [x] Add precision/recall tests against accepted manuals and reports.

### 4.3 Semantic Structure

- [x] Infer heading levels across the document.
- [x] Infer nested lists.
- [x] Infer code blocks from monospace text and indentation.
- [x] Preserve links.
- [x] Integrate outlines/bookmarks as optional structure signals.
- [x] Prefer tagged PDF structure when tags are consistent with geometry.
- [x] Warn when tags conflict with visible layout.

Gate 3 acceptance:

- [x] Multi-column scientific papers meet reading-order thresholds.
- [x] Long manual fixtures run within memory limits.
- [x] Header/footer removal meets accepted precision and recall targets.
- [x] Tagged PDFs use tags where reliable and fall back to geometry where not.
- [x] Markdown rendered HTML is readable for reports, manuals, and papers.

## Phase 5: Gate 4 - Tables V1

Goal: extract common tables without claiming impossible Markdown fidelity.

### 5.1 Visible-Border Tables

- [x] Detect ruling lines from path operators.
- [x] Merge near-collinear segments.
- [x] Infer grid rows and columns.
- [x] Assign text boxes to cells.
- [x] Detect row and column spans.
- [x] Export GFM tables when no spans are present.
- [x] Export HTML tables when spans are required.
- [x] Export CSV sidecars.

### 5.2 Borderless Tables

- [x] Detect aligned text columns.
- [x] Distinguish tables from multi-column prose.
- [x] Infer header rows.
- [x] Infer numeric alignment.
- [x] Track confidence per table.
- [x] Warn or preserve as preformatted text when confidence is low.

### 5.3 Table Quality Tests

- [x] Add cell adjacency metric.
- [x] Add span accuracy metric.
- [x] Add CSV cell text accuracy metric.
- [x] Add rendered HTML table diff helper.
- [x] Add fixtures for split-across-page tables.
- [x] Add fixtures for notes below tables.

Gate 4 acceptance:

- [x] Visible-border synthetic tables pass exact structure tests.
- [x] Simple public tables meet cell text and adjacency thresholds.
- [x] Complex tables use HTML or sidecar fallback instead of broken GFM.
- [x] Low-confidence tables emit warnings.

## Phase 6: Gate 5 - Raster And OCR Path

Goal: support scanned and hybrid PDFs through an OCR path.

### 6.1 Page Rasterization

- [x] Select rendering dependency or implement scoped rasterization path.
- [x] Render pages at configurable DPI.
- [x] Respect page boxes and rotation.
- [x] Enforce image pixel limits.
- [x] Add thumbnail render path for previews and layout models.
- [x] Add tests for rotated and cropped pages.

### 6.2 Scan Detection

- [x] Detect image-dominant pages.
- [x] Detect pages with little or no text.
- [x] Detect hidden OCR text overlays.
- [x] Detect mismatch between hidden text and visible image.
- [x] Route pages as digital, scanned, or hybrid.
- [x] Record routing decision and confidence in diagnostics.

### 6.3 OCR Integration

- [x] Select CPU OCR adapter.
- [x] Define OCR model loading and cache behavior.
- [x] Implement OCR text boxes with confidence.
- [x] Implement deskew/preprocessing where practical.
- [x] Reconcile PDF text layer and OCR text for hybrid pages.
- [x] Prefer PDF text only when it aligns with visible geometry.
- [x] Add OCR sidecar outputs for debugging.
- [x] Add language configuration.

Gate 5 acceptance:

- [x] Scanned text fixtures meet OCR character/word error thresholds.
- [x] Searchable scan fixtures choose reliable text per region.
- [x] Bad OCR overlay fixtures do not blindly trust hidden text.
- [x] OCR can be disabled and produces a clear warning.
- [x] Browser and Node paths both work for at least one scanned fixture.

## Phase 7: Gate 6 - WebGPU Acceleration

Goal: accelerate OCR/layout workloads where available without changing results.

### 7.1 Capability Detection

- [x] Detect WebGPU support in browser.
- [x] Detect supported adapters and limits.
- [x] Detect Node GPU support only if a stable path exists.
- [x] Fall back to CPU automatically.
- [x] Expose diagnostics showing selected provider.

### 7.2 GPU Providers

- [x] Integrate GPU execution provider for OCR or layout models.
- [x] Batch page images where memory allows.
- [x] Enforce GPU memory limits.
- [x] Handle device loss.
- [x] Keep model outputs compatible with CPU path.
- [x] Add provider parity tests.

### 7.3 Benchmarks

- [x] Benchmark OCR CPU versus WebGPU.
- [x] Benchmark layout model CPU versus WebGPU.
- [x] Track startup/model-load time separately from page throughput.
- [x] Track peak CPU and GPU memory.
- [x] Publish benchmark reports under `corpus/reports/`.

Gate 6 acceptance:

- [ ] CPU and WebGPU paths produce equivalent accepted outputs.
- [ ] WebGPU is measurably faster on selected workloads.
- [x] Unsupported WebGPU environments pass the same corpus through CPU fallback.
- [x] Device errors produce structured diagnostics.

## Phase 8: Gate 7 - Advanced Document Intelligence

Goal: expand high-value difficult content after the core pipeline is stable.

### 8.1 Equations

- [x] Detect equation-like regions.
- [x] Preserve Unicode equations when text extraction is reliable.
- [x] Add optional formula OCR to LaTeX.
- [x] Preserve equation images when OCR confidence is low.
- [x] Add source maps for equation regions.

### 8.2 Figures, Charts, And Diagrams

- [x] Group images and vector regions into figures.
- [x] Attach captions to figures.
- [x] Extract figure assets.
- [x] Preserve alt text from tagged PDFs where present.
- [x] Do not invent chart data from visual charts.
- [x] Emit asset links and warnings for low-semantic visual content.

### 8.3 Forms, Annotations, Attachments, And Signatures

- [x] Extract AcroForm fields and values.
- [x] Extract checkboxes and radio button states.
- [x] Preserve field labels where discoverable.
- [x] Detect XFA and report supported/unsupported status.
- [x] Extract links and text annotations.
- [x] Extract attachment metadata and optional sidecar assets.
- [x] Report signature metadata without claiming cryptographic validation unless
  validation is actually implemented.

### 8.4 Multilingual Expansion

- [x] Improve RTL grouping and bidi output.
- [x] Improve CJK line breaking.
- [x] Improve vertical writing support.
- [x] Add language/script-specific OCR settings.
- [x] Add normalization rules by script.

Gate 7 acceptance:

- [x] Equation fixtures preserve useful math representation or assets.
- [x] Figure fixtures preserve captions and asset links.
- [x] Government form fixtures extract fields and values.
- [x] Annotation and attachment fixtures produce expected sidecars.
- [x] RTL, CJK, and vertical fixtures meet script-specific acceptance criteria.

## Phase 9: Gate 8 - Hardening, Security, And Release

Goal: make the package safe and predictable enough for real use.

### 9.1 Security

- [x] Enforce max file size.
- [x] Enforce max page count.
- [x] Enforce max decoded stream size.
- [ ] Enforce max image pixels.
- [ ] Enforce max object count.
- [ ] Enforce parse and conversion timeouts.
- [ ] Enforce recursion/depth limits.
- [ ] Audit all unsafe Rust blocks.
- [ ] Run fuzzers for parser, streams, fonts, and content interpreter.
- [ ] Add malicious PDF regression fixtures.
- [ ] Add dependency license and vulnerability checks.

### 9.2 Performance

- [ ] Stream page processing where possible.
- [ ] Avoid retaining full page rasters unnecessarily.
- [ ] Add memory profile for long manuals.
- [ ] Add throughput benchmark for text-only PDFs.
- [ ] Add throughput benchmark for OCR PDFs.
- [ ] Add startup benchmark for browser and Node.
- [ ] Add package-size budget.
- [ ] Add model-size budget.
- [ ] Add performance regression threshold in CI.

### 9.3 Developer Experience

- [ ] Write API documentation.
- [ ] Write CLI documentation.
- [ ] Write browser example.
- [ ] Write Node example.
- [ ] Write worker example.
- [ ] Document WASM loading for bundlers.
- [ ] Document OCR model loading.
- [ ] Document WebGPU behavior and fallback.
- [ ] Document security limits.
- [ ] Document warnings and confidence scores.

### 9.4 Release Readiness

- [ ] Run full accepted corpus.
- [ ] Run full fuzz smoke suite.
- [ ] Run package build in a clean checkout.
- [ ] Run package install test in a separate fixture project.
- [ ] Run browser smoke test in Chromium and Firefox.
- [ ] Run Node smoke test on supported Node versions.
- [ ] Verify package exports.
- [ ] Verify source maps and TypeScript declarations.
- [ ] Verify README examples.
- [ ] Produce release notes with known limitations.

Gate 8 acceptance:

- [ ] No accepted corpus regressions.
- [ ] No known panics on malformed corpus.
- [ ] Security limits are documented and tested.
- [ ] Performance reports exist for representative text, table, long, scanned,
  and hybrid PDFs.
- [ ] Package can be installed and used as an npm dependency.

## Agent Workstream Map

Use this map to split work across AI agents. Each agent should own tests and
definition-of-done checks for its module.

| Agent | Workstream | Primary phases | Required outputs |
| --- | --- | --- | --- |
| A | Corpus and acceptance | 0, all gates | Manifest, retrieval scripts, analysis reports, acceptance YAML |
| B | Rust PDF syntax | 1, 2, 3, 9 | Parser, object model, xref, repair, fuzz tests |
| C | Stream filters | 2, 3, 9 | Decoders, bounds, corrupt-stream tests |
| D | Page/resources/content | 2, 3 | Catalog, pages, resources, content interpreter |
| E | Fonts and text | 2, 4 | Font parsing, Unicode mapping, text geometry |
| F | Layout | 2, 4 | Blocks, reading order, headers/footers, structure |
| G | Tables | 5 | Table detector, HTML/GFM/CSV output, metrics |
| H | OCR and raster | 6, 7 | Scan routing, OCR adapter, WebGPU provider |
| I | Markdown and API | 1, 2, all gates | Markdown AST, serializer, TypeScript API, CLI |
| J | QA and release | 0, all gates, 9 | Corpus runner, benchmarks, CI, release checks |

Coordination checklist:

- [ ] Each agent starts by reading the study and this plan.
- [ ] Each agent writes or updates tests before marking a module complete.
- [ ] Cross-agent contracts are changed through versioned IR/schema updates.
- [ ] Corpus regressions block completion of later phases.
- [ ] Performance changes include before/after benchmark reports.
- [ ] New unsupported behavior includes a warning code and documentation.

## Metrics And Release Gates

Core metrics:

- [ ] Character error rate for extracted text.
- [ ] Word error rate for OCR text.
- [ ] Unicode mapping accuracy for born-digital text.
- [ ] Paragraph grouping F1.
- [ ] Hyphenation repair accuracy.
- [ ] Reading-order edit distance.
- [x] Header/footer removal precision and recall.
- [ ] Table detection precision and recall.
- [ ] Table cell adjacency accuracy.
- [ ] Table span accuracy.
- [ ] CSV cell text accuracy.
- [ ] Markdown AST diff.
- [ ] Rendered HTML semantic diff.
- [ ] Asset link validity.
- [ ] Warning-code accuracy.
- [ ] Pages per second.
- [ ] Peak memory.
- [ ] Browser startup time.
- [ ] WASM size.
- [ ] Model download size.
- [ ] GPU speedup where available.
- [ ] Fuzz stability.

Minimum release bars for a first public alpha:

- [ ] Text MVP accepted corpus passes.
- [ ] Robust parser corpus has zero panics.
- [ ] At least one browser example and one Node example work.
- [ ] CLI converts a local PDF to Markdown.
- [ ] Warnings and confidence are visible in API and CLI output.
- [ ] Non-supported scanned PDFs do not silently produce empty success output.
- [ ] Security limits are enabled by default.
- [ ] Package exports and TypeScript declarations are verified.

Minimum release bars for a serious beta:

- [ ] Layout V1 accepted corpus passes.
- [ ] Tables V1 accepted corpus passes for simple and visible-border tables.
- [ ] OCR V1 accepted corpus passes for selected scanned and hybrid PDFs.
- [ ] Full corpus reports are generated in CI or release CI.
- [ ] Performance budgets are enforced.
- [ ] Browser fallback behavior is documented and tested.
- [ ] Known limitations are described with concrete warning codes.

## Immediate Next Actions

- [x] Create corpus directories and manifest schema.
- [x] Add retrieval and analysis script skeletons.
- [x] Generate the first synthetic exact-output PDFs.
- [x] Retrieve a small public-domain/public-license external PDF set.
- [x] Run static analysis and oracle extraction on the first corpus batch.
- [x] Write acceptance YAML for the first 10 PDFs.
- [ ] Implement project scaffolding and stub API.
- [x] Make the corpus runner list PDFs and report skipped gates.
- [ ] Start Gate 1 parser and text extraction work only after the first
  acceptance files exist.
