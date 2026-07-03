# Release Notes

## 0.0.0 Alpha Readiness Snapshot

Date: 2026-07-03

This is a release-readiness snapshot for `@pdf-2-llm/pdf2md`, not an npm
publish event. The package manifest still has `"private": true` and
`"license": "UNLICENSED"`, so publishing requires an explicit metadata and
licensing decision first.

### Scope

This snapshot covers the JavaScript PDF-to-Markdown package:

- Node, browser, worker, schema, and CLI entrypoints.
- Markdown output, source maps, document IR, assets, warnings, diagnostics, and
  confidence scores.
- Parsed text extraction, layout heuristics, table handling, forms,
  annotations, attachments, signatures metadata, scan detection, OCR planning,
  raster planning, and WebGPU fallback diagnostics.

### Validation Summary

The release checklist was validated from the repository and from packed package
fixtures:

- `npm run check` passed, including corpus gates, QA checks, fuzz smoke, build,
  and 221 API tests.
- Full accepted corpus passed with 31 converted entries and 2 documented skips.
- Fuzz smoke passed 4 targets with 100 iterations each.
- Representative performance reports exist for text, table, long-document, and
  scanned/hybrid OCR workloads.
- Clean checkout build passed.
- Packed package install passed in a separate fixture project.
- Browser smoke passed in Chromium and Firefox against
  `packages/pdf2md/examples/browser-basic.html?fixture=1`.
- Node API and CLI smoke passed on Node 22.23.1, 24.18.0, and 26.4.0.
- Package exports were verified for `.`, `./node`, `./browser`, `./worker`, and
  `./schema`, including a negative internal-path export check.
- Source-map output was verified against a real conversion, and TypeScript
  declarations were verified from a packed consumer project.
- README examples were run as documented.

### Known Limitations

#### Packaging And Publishing

- The package is private and unlicensed for npm publishing until the manifest is
  intentionally changed.
- The current package ships JavaScript sources only. There is no packaged
  `.wasm` artifact, `./wasm-*` export, or `locateWasm` option yet.

#### Text Extraction

- `text.heuristic_content_stream` is common in the current JavaScript parser and
  means text was reconstructed through heuristic content stream interpretation.
  Review output for ordering, encoding, and layout edge cases before high-stakes
  use.
- `text.unicode_mapping_suspect` marks font mappings without trusted Unicode
  coverage.
- `text.ordering_uncertain` marks geometry that may not match visual reading
  order.

#### OCR And Raster

- OCR model loading is contract-first. The converter reports `tesseract.js`
  diagnostics and lazy model names, but it does not download or execute OCR
  model files.
- OCR text is produced from caller-supplied `options.ocr.results`; scanned or
  hybrid pages without supplied OCR boxes remain diagnostic/planned work.
- Raster support creates bounded plans and diagnostics, not full image buffers.
  Oversized raster targets are reported with `security.image_pixels_exceeded`.

#### WebGPU

- WebGPU currently performs capability detection and OCR batch planning only; it
  does not execute GPU kernels.
- Node always falls back to CPU with
  `node-stable-gpu-path-unavailable`.
- Browser WebGPU unavailability falls back to CPU. When `webgpu.required` is
  true, the user-visible warning is `webgpu.unavailable`.

#### PDF Feature Coverage

- Unsupported or locked encryption is reported with
  `security.password_required`, `security.password_incorrect`, or
  `security.unsupported_encryption`.
- Security and resource limits can intentionally produce empty Markdown with
  warnings such as `security.input_too_large`, `security.page_count_exceeded`,
  `security.image_pixels_exceeded`, and `pdf.parse_failed`.
- XFA is detected as unsupported. Signature fields are extracted as metadata,
  but cryptographic validation is not performed.

#### Markdown Fidelity

- Complex tables may use HTML fallback and CSV sidecars. Low-confidence table
  candidates are reported with `table.low_confidence`.
- Low-confidence OCR equations can be preserved as image assets and reported
  with `equation.low_ocr_confidence`.
- Figure regions with weak semantic content are reported with
  `figure.low_semantic_content`.

#### CLI

- The CLI currently accepts local file paths only.
- Advanced options such as password callbacks, OCR result injection, parser
  mode, custom security limits, raster planning, WebGPU configuration, table
  sidecar toggles, attachment extraction, and asset output directories require
  the JavaScript API.

### Release Notes For Integrators

- Prefer explicit subpath imports:
  `@pdf-2-llm/pdf2md/node`, `@pdf-2-llm/pdf2md/browser`, or
  `@pdf-2-llm/pdf2md/worker`.
- Treat warnings as part of the conversion contract. Downstream RAG, indexing,
  archival, and compliance workflows should gate on warning codes and
  confidence scores.
- Keep CPU fallback as the correctness baseline. WebGPU and future WASM paths
  must preserve Markdown, IR, source-map, asset, warning, and diagnostic shapes.
