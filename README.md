# pdf-2-llm

`pdf-2-llm` is an implementation-stage PDF-to-Markdown toolkit for turning PDF
documents into Markdown plus machine-readable sidecars that are suitable for
LLM, search, RAG, archival, and review workflows.

The npm package in this repository is `pdf-2-llm`. It exposes a JavaScript API,
Node/browser/worker entrypoints, a local CLI, JSON schemas, and a small
Rust/WebAssembly preflight bridge. The project is built around an explicit
validation corpus: PDFs only become release gates after provenance, license
status, analysis outputs, reviewed acceptance criteria, and expected behavior
are recorded.

## Current Status

The root `pdf-2-llm` package currently declares version `1.1.0` and is
configured for public npm publishing, with the implementation kept in the
`packages/pdf2md` workspace. The project source is licensed under the
[Zero-Clause BSD license](LICENSE), so it can be used, copied, modified,
distributed, and sold for any purpose, including commercial use.

Current capabilities include:

- Parsed text extraction for supported born-digital PDFs.
- Markdown output with source-map entries back to page regions.
- Document IR, assets, warnings, diagnostics, and confidence scores.
- Layout heuristics for headings, paragraphs, running content, columns,
  captions, footnotes, RTL/CJK/vertical text cases, and reading order checks.
- Ruled-table detection with GFM table output, HTML fallback for spans, and CSV
  sidecar assets.
- Form, annotation, attachment, figure, equation, scan-detection, OCR-planning,
  raster-planning, and signature metadata diagnostics.
- Security limits, timeout checkpoints, tolerant parsing diagnostics, encrypted
  PDF warnings, malformed-corpus checks, and fuzz smoke tests.
- Optional WebGPU capability detection, OCR workload planning, supplied-device
  preprocessing diagnostics, CPU fallback parity, and a browser WebGPU
  preprocessing speed gate.
- A Rust/WASM preflight module for PDF header/version checks. The full
  extraction pipeline still runs through JavaScript in this snapshot.

Important current limitations:

- OCR model loading is contract-first. The converter reports `tesseract.js`
  planning diagnostics, but it does not download or execute OCR model files.
  OCR text is produced from caller-supplied `options.ocr.results`.
- Raster support creates bounded raster plans and diagnostics; it does not
  retain full rendered page image buffers.
- Node WebGPU falls back to CPU. Browser WebGPU acceleration requires a usable
  `navigator.gpu` adapter/device or a caller-supplied `GPUDevice`.
- The CLI intentionally exposes only the simple local-file conversion path.
  Advanced controls are available through the JavaScript API.

See [Release Notes](docs/release-notes.md) for the latest readiness snapshot and
known limitations.

## Quick Start

Prerequisites:

- Node.js with ESM support. The release snapshot was validated on Node 22, 24,
  and 26.
- npm.
- Rust and Cargo for the Rust tests and WASM bridge.
- The `wasm32-unknown-unknown` target for `npm run wasm:build`.

Install dependencies and build the WASM preflight module:

```sh
npm install
rustup target add wasm32-unknown-unknown
npm run wasm:build
```

Run the local CLI against a generated fixture:

```sh
npm exec -- pdf-2-llm corpus/generated/synthetic-simple-text.pdf
```

Write the full structured result as JSON:

```sh
npm exec -- pdf-2-llm corpus/generated/synthetic-simple-text.pdf --json --output .temp/simple.json
```

Run the Node example:

```sh
node packages/pdf2md/examples/node-basic.mjs
```

Run the complete validation gate:

```sh
npm run check
```

`npm run check` is intentionally broad. It runs Rust tests, builds WASM,
validates the corpus, runs corpus acceptance gates, checks Markdown/HTML/source
map/table/warning/security behavior, runs benchmark smoke checks, validates
WebGPU fallback/preprocessing behavior, runs fuzz smoke tests, builds the
package, and runs API tests.

## CLI

The package exposes a `pdf-2-llm` command, with `pdf2md` retained as an alias:

```sh
pdf-2-llm <input.pdf> [--output <path>] [--json]
```

Local development command from a checkout:

```sh
npm exec -- pdf-2-llm <input.pdf> [--output <path>] [--json]
```

By default, the CLI writes Markdown to stdout:

```sh
pdf-2-llm corpus/generated/synthetic-simple-text.pdf
```

Use `--json` to emit the full `ConvertResult` object:

```sh
pdf-2-llm corpus/generated/synthetic-simple-text.pdf --json
```

The CLI currently accepts local paths only and does not expose flags for OCR
result injection, password callbacks, parser mode, security limits, raster
planning, WebGPU configuration, table sidecar toggles, attachments, or asset
output directories. Use the JavaScript API for those controls.

See [CLI Reference](docs/cli.md).

## JavaScript API

The primary function is `convertPdfToMarkdown()`:

```ts
import { readFile } from "node:fs/promises";
import { convertPdfToMarkdown } from "pdf-2-llm/node";

const bytes = await readFile("document.pdf");
const result = await convertPdfToMarkdown(bytes, {
  markdown: {
    pageAnchors: true
  },
  tables: {
    csvSidecars: true
  },
  security: {
    timeoutMs: 30_000
  }
});

console.log(result.markdown);
console.log(result.warnings);
console.log(result.confidence);
```

Browser entrypoint:

```ts
import { convertPdfToMarkdown } from "pdf-2-llm/browser";

const file = document.querySelector("input[type=file]")?.files?.[0];
if (file) {
  const result = await convertPdfToMarkdown(await file.arrayBuffer());
  console.log(result.markdown);
}
```

Supported package entrypoints:

```ts
import { convertPdfToMarkdown } from "pdf-2-llm";
import { convertPdfToMarkdown as convertInNode } from "pdf-2-llm/node";
import { convertPdfToMarkdown as convertInBrowser } from "pdf-2-llm/browser";
import { convertPdfToMarkdown as convertInWorker } from "pdf-2-llm/worker";
import { warningCodes } from "pdf-2-llm/schema";
import { loadPdf2mdCoreWasm } from "pdf-2-llm/wasm";
```

The converter returns:

- `markdown`: converted Markdown.
- `sourceMap`: Markdown offsets mapped back to PDF page regions.
- `assets`: sidecar assets such as CSV tables, OCR debug JSON, equation or
  figure previews, and extracted attachments.
- `ir`: document intermediate representation.
- `warnings`: stable warning codes for downstream policy decisions.
- `diagnostics`: parser, extraction, security, OCR, raster, WebGPU, timing, and
  input metadata.
- `confidence`: overall and per-domain confidence scores.

See [API Reference](docs/api.md) for the full option and result contract.

## OCR, Raster, And WebGPU

OCR, rasterization, and WebGPU are designed as optional acceleration or
enrichment paths. They must not be required for Markdown correctness.

- OCR planning records selected adapter metadata, language/model names, page
  routing, preprocessing plans, and reconciliation diagnostics.
- Caller-supplied OCR boxes can be merged into output and emitted as debug
  sidecars.
- Raster planning records page/thumbnail targets and applies image-pixel
  security limits, but full page buffers are not retained in this snapshot.
- WebGPU selection records runtime capability, fallback reasons, adapter/device
  metadata, OCR batch planning, and preprocessing parity/speed diagnostics.
- CPU fallback remains the correctness baseline.

The browser WebGPU preprocessing harness validates a selected adaptive-threshold
RGBA workload with exact CPU/GPU parity and a measurable speedup when a real
browser WebGPU provider is available:

```sh
npm run qa:webgpu-preprocess
```

See [OCR Model Loading](docs/ocr-model-loading.md),
[WebGPU Behavior And Fallback](docs/webgpu-behavior.md), and
[WASM Loading For Bundlers](docs/wasm-loading.md).

## Validation Corpus

The `corpus/` directory is part of the product contract. Each gating PDF must
have:

- A manifest entry with source/provenance, retrieval or generation details,
  license notes, redistribution status, SHA-256, file size, page count, PDF
  version, features, and notes.
- A reviewed acceptance YAML file.
- Expected Markdown, sidecars, or documented unsupported behavior.
- Review artifacts such as oracle outputs and previews where applicable.

Generated fixtures cover exact-output scenarios. Retrieved and mutated PDFs
cover public, malformed, encrypted, scanned, hybrid, table-heavy, multilingual,
form, annotation, attachment, long-document, and layout-heavy cases.

Useful corpus commands:

```sh
npm run corpus:validate
npm run corpus:run:text
npm run corpus:run:tables
npm run corpus:run:layout
npm run corpus:run:all
```

See [Corpus README](corpus/README.md) and the
[Implementation Plan](docs/pdf-to-markdown-implementation-plan.md).

## Development Commands

Common commands:

```sh
npm run build
npm run lint
npm run test:api
npm run rust:test
npm run wasm:build
npm run fuzz:smoke
npm run check
```

Focused QA commands:

```sh
npm run qa:benchmark:smoke
npm run qa:compare-oracles
npm run qa:markdown-ast
npm run qa:warning-codes
npm run qa:table-detection
npm run qa:webgpu-comparison
npm run qa:webgpu-preprocess
```

Package examples:

```sh
node packages/pdf2md/examples/node-basic.mjs
node packages/pdf2md/examples/worker-basic.mjs
```

The browser example is at:

```text
packages/pdf2md/examples/browser-basic.html
```

## Repository Layout

```text
pdf-2-llm/
  Cargo.toml
  crates/
    pdf2md-core/              Rust/WASM preflight bridge
  packages/
    pdf2md/
      src/                    JavaScript converter, parser, schemas, CLI
      test/                   Node API and behavior tests
      examples/               Node, browser, and worker examples
  corpus/
    manifest.json             Corpus metadata
    generated/                Reproducible generated fixtures
    raw/                      Public, incoming, and local-only PDFs
    accepted/                 Per-PDF acceptance criteria
    expected/                 Reviewed expected Markdown/sidecars
    baselines/                Oracle outputs and preview artifacts
    reports/                  QA and benchmark reports
  scripts/
    corpus/                   Retrieval, analysis, oracle, preview scripts
    qa/                       Gates, benchmarks, audits, browser harnesses
  docs/                       API, CLI, behavior, policy, and study docs
```

## Documentation Index

- [WebAssembly + WebGPU PDF-to-Markdown Study](docs/pdf-to-markdown-webassembly-study.md)
- [PDF-to-Markdown Implementation Plan](docs/pdf-to-markdown-implementation-plan.md)
- [API Reference](docs/api.md)
- [CLI Reference](docs/cli.md)
- [WASM Loading For Bundlers](docs/wasm-loading.md)
- [OCR Model Loading](docs/ocr-model-loading.md)
- [WebGPU Behavior And Fallback](docs/webgpu-behavior.md)
- [Security Limits](docs/security-limits.md)
- [Warnings And Confidence Scores](docs/warnings-confidence.md)
- [Release Notes](docs/release-notes.md)
- [Corpus README](corpus/README.md)

## License

This project is licensed under the [Zero-Clause BSD license](LICENSE). It is a
permissive license with no attribution requirement and permits commercial use,
modification, distribution, and sale.

## Integration Guidance

- Treat warnings and confidence scores as first-class output. Downstream
  workflows should gate on warning codes and confidence thresholds instead of
  assuming every PDF has equal extraction quality.
- Keep CPU output as the correctness baseline. Optional WebGPU and future WASM
  acceleration paths must preserve Markdown, source maps, IR, assets, warnings,
  diagnostics, and confidence shapes.
- Review rendered Markdown and source maps for new document classes. PDF
  fidelity problems are often document-specific and cannot be captured by a
  single generic unit test.
- Do not commit non-redistributable PDFs. Use `corpus/raw/local-only/` for local
  files that are useful for testing but not cleared for repository storage.
