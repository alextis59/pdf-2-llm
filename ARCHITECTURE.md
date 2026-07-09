# Architecture

`pdf-2-llm` is a PDF-to-Markdown toolkit for Node, browser, worker, CLI, and
RAG-style ingestion workflows. The public package is the root npm package
`pdf-2-llm`; the implementation currently lives in the `packages/pdf2md`
workspace and a small Rust/WASM preflight crate.

The converter returns Markdown plus source maps, sidecar assets, document IR,
warnings, diagnostics, and confidence scores. Those shapes are public
contracts, not incidental debug output.

## Runtime Surfaces

| Surface | Files | Notes |
| --- | --- | --- |
| Root npm package | `package.json` | Publishes `pdf-2-llm`, CLI aliases, subpath exports, and a restricted file allowlist. |
| JavaScript workspace | `packages/pdf2md/` | Implementation package for source, tests, examples, fuzz smoke targets, and package-local scripts. |
| Node entrypoint | `packages/pdf2md/src/node.mjs` | Re-exports the converter for Node callers and supports local path input. |
| Browser entrypoint | `packages/pdf2md/src/browser.mjs` | Re-exports the converter for browser `ArrayBuffer` and `Uint8Array` inputs. |
| Worker entrypoint | `packages/pdf2md/src/worker.mjs` | Re-exports the converter for module worker integrations. |
| CLI | `packages/pdf2md/src/cli.mjs` | Local-file conversion only: `<input.pdf>`, `--output`, `--json`, and debug trace flags. |
| Schema entrypoint | `packages/pdf2md/src/schema.mjs` | Exports schema version, warning codes, document IR schema, and source-map schema. |
| WASM entrypoint | `packages/pdf2md/src/wasm-loader.mjs` | Loads the packaged Rust/WASM preflight module and resolves single/threaded load plans. |
| Rust crate | `crates/pdf2md-core/` | Current `rlib`/`cdylib` preflight bridge for PDF header/version checks, not the full parser. |

Public examples and docs should import from `pdf-2-llm`, `pdf-2-llm/node`,
`pdf-2-llm/browser`, `pdf-2-llm/worker`, `pdf-2-llm/schema`, or
`pdf-2-llm/wasm`.

## Conversion Flow

The main orchestration path is `convertPdfToMarkdown()` in
`packages/pdf2md/src/index.mjs`.

1. Normalize input from a Node path, `ArrayBuffer`, `Uint8Array`, or `{ bytes }`
   object.
2. Apply default security limits and validate caller-supplied limit values.
3. Hash the input, detect the PDF header/version, and parse the PDF when the
   header and security checks allow it.
4. Resolve password callbacks only for encrypted PDFs that request a password.
   Password values must not be copied into diagnostics.
5. Incrementally tokenize bounded content streams and extract page geometry,
   text lines, ruling lines, images, outlines, structure signals, forms,
   annotations, attachments, and signature metadata where supported.
6. Plan OCR, raster, WebGPU, and preprocessing diagnostics. OCR model loading
   is currently contract-first; OCR text comes from caller-supplied
   `options.ocr.results`.
7. Reconcile PDF text and OCR text, infer layout, tables, figures, equations,
   running content, and page source types.
8. Serialize Markdown and source maps from the reconciled content blocks. The
   same selected text lines and emitted tables populate page IR so suppressed
   PDF/OCR duplicates and table-cell text are not emitted twice.
9. Assemble sidecar assets, warnings, diagnostics, IR, and confidence scores.

Timeout and abort checkpoints throw `TimeoutError` or `AbortError`. Most
document-level failures return structured warnings and diagnostics so callers
can make policy decisions without losing the result object.

## Module Map

| Module | Responsibility |
| --- | --- |
| `runtime.mjs` | Runtime-neutral byte helpers, hashing, bounded native/portable Flate decoding, Node builtin access, encoding helpers, and fallback MD5. |
| `pdf-parser.mjs` | PDF byte reading, xref/object parsing and repair, encryption checks, page tree, outlines, structure, resources, and security parser limits. |
| `stream-filters.mjs` | Stream filter decoding and decoded-stream byte caps. |
| `content-stream.mjs` | Incremental PDF graphics/text operator interpretation with operation, output, and stack budgets for text, geometry, and drawing signals. |
| `font-encoding.mjs` | ToUnicode CMap parsing, encoding fallbacks, and trusted/simple encoding checks. |
| `text-extract.mjs` | Text extraction, layout grouping, Markdown/source-map serialization, page text/table IR projection, headings, lists, running content, equations, and table insertion. |
| `table-grid.mjs` | Ruling-line grid inference, cell assignment, spans, and table geometry. |
| `figure-detection.mjs` | Figure region detection, caption placement, figure Markdown insertion, and preview sidecars. |
| `document-interactions.mjs` | Form, annotation, attachment, and signature metadata extraction. |
| `scan-detection.mjs` | Page source-type classification for digital, scanned, and hybrid pages. |
| `raster-plan.mjs` | Metadata-only page/thumbnail raster planning and pixel-limit diagnostics. |
| `ocr-*.mjs` | OCR adapter metadata, language/model planning, preprocessing planning, caller-supplied OCR text, and PDF/OCR reconciliation. |
| `webgpu-*.mjs` | Capability detection, CPU fallback, execution planning, and optional preprocessing diagnostics. |
| `schema.mjs` | Public schema version, warning codes, document IR shape, source-map shape, and warning construction. |

## Corpus And QA Architecture

The `corpus/` directory is part of the product contract.

- `corpus/manifest.json` records provenance, license notes, redistribution
  status, hashes, features, acceptance paths, and source paths.
- `corpus/accepted/*.yaml` defines per-PDF gates, expected modes, must/must-not
  criteria, metrics, snippets, warnings, assets, and review metadata.
- `corpus/expected/` stores reviewed Markdown, IR, and sidecar expectations.
- `corpus/baselines/` stores analysis, oracle text, tool outputs, and page
  previews for review.
- `corpus/reports/` stores benchmark and release-evidence reports.

`scripts/corpus/` owns corpus retrieval, generation, analysis, preview, oracle,
manifest, acceptance, and review-audit workflows. `scripts/qa/` owns targeted
quality gates for rendered Markdown, oracle comparisons, tables, warnings,
security, WebGPU, package size, model size, dependencies, and performance.

## CI And Release Shape

CI installs Node and Rust, adds the `wasm32-unknown-unknown` target, runs
`npm ci`, and then runs `npm run check`. The full gate includes Rust tests,
WASM build, syntax lint, corpus validation and acceptance, corpus runs, QA
comparators, benchmark smoke checks, WebGPU fallback/preprocessing checks,
dependency/package/model-size checks, fuzz smoke, build, and API tests.

Publishing proof is separate from CI. Package-surface work should validate the
root package manifest, bin aliases, subpath exports, tarball contents, local CLI
execution, and a clean temp-consumer install before claiming publishability.

## Current Boundaries

- The full parser and extraction pipeline currently runs in JavaScript. The
  Rust/WASM module is a PDF preflight bridge, not the production parser.
- OCR model files are not bundled, downloaded, or executed by conversion.
  Automatic OCR execution is future work; caller-supplied OCR boxes are
  supported today.
- Raster support creates bounded metadata plans and diagnostics. It does not
  retain full rendered page image buffers.
- Node WebGPU falls back to CPU. Browser WebGPU needs a real browser provider
  or caller-supplied `GPUDevice`.
- The CLI intentionally exposes the simple local-file path. Use the JavaScript
  API for password callbacks, OCR result injection, custom limits, raster,
  WebGPU, attachments, and advanced table/asset controls.
