# Workflow Specs

This document describes repository-supported workflows that users, integrators,
and maintainers can run today. It does not describe future enforcement as if it
already exists.

## CLI Conversion

Goal: convert one local PDF file to Markdown or JSON from a shell.

Primary command:

```sh
pdf-2-llm <input.pdf> [--output <path>] [--json] [--debug]
```

Local checkout command:

```sh
npm exec -- pdf-2-llm corpus/generated/synthetic-simple-text.pdf
```

Behavior:

- The CLI accepts local file paths only.
- Markdown is written to stdout unless `--output <path>` is supplied.
- `--json` writes the full `ConvertResult` object.
- Document-level PDF problems are normally represented as warnings in output.
- `--debug` writes an NDJSON trace under the system temp directory and prints
  the path to stderr. Use `--debug-trace <path>` for an explicit destination.
- Missing input or invalid CLI arguments exit non-zero.

Validation:

```sh
node packages/pdf2md/src/cli.mjs --help
npm exec -- pdf-2-llm corpus/generated/synthetic-simple-text.pdf
npm exec -- pdf-2-llm corpus/generated/synthetic-simple-text.pdf --debug --output .temp/simple.md
```

Use the JavaScript API instead when callers need password callbacks, custom
security limits, injected OCR results, raster planning, WebGPU controls,
attachment extraction, or table/asset options.

## JavaScript API Integration

Goal: convert caller-owned bytes in Node, browser, or worker code.

Node:

```js
import { readFile } from "node:fs/promises";
import { convertPdfToMarkdown } from "pdf-2-llm/node";

const bytes = await readFile("document.pdf");
const result = await convertPdfToMarkdown(bytes, {
  ocr: { enabled: false },
  security: { timeoutMs: 30_000 }
});
```

Browser:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/browser";

const result = await convertPdfToMarkdown(await file.arrayBuffer());
```

Behavior:

- The result contains `markdown`, `sourceMap`, `assets`, `ir`, `warnings`,
  `diagnostics`, and `confidence`.
- Warning codes and confidence values are intended for downstream policy gates.
- Path string input is Node-only.
- OCR model loading is not automatic; OCR text comes from
  `options.ocr.results`.
- WebGPU is optional and falls back to CPU unless a browser provider or supplied
  device is selected.

Validation:

```sh
node packages/pdf2md/examples/node-basic.mjs
npm run test:api
```

## Corpus Entry Workflow

Goal: add or update a PDF fixture that can become a release gate.

Required steps:

1. Put new external downloads in `corpus/raw/_incoming/` or local-only files in
   `corpus/raw/local-only/`.
2. Record provenance, license notes, redistribution status, SHA-256, byte size,
   page count, PDF version, features, and acceptance path in
   `corpus/manifest.json`.
3. Add or update `corpus/accepted/<id>.yaml`.
4. Add reviewed expected Markdown, IR, or sidecars when the gate needs exact
   output.
5. Generate or refresh baselines, oracles, and previews when the changed gate
   needs human review.

Validation:

```sh
npm run corpus:validate
npm run corpus:acceptance
npm run corpus:run:text
```

Use a narrower `node scripts/qa/run-corpus.mjs --id <id> --assert-markdown`
command when reviewing one case.

## Release Verification Workflow

Goal: prove the root npm package can be installed and used by a consumer.

Minimum proof:

1. Inspect the root `package.json` publish fields and `files` allowlist.
2. Build and validate the package surface.
3. Dry-run the root package tarball.
4. Install the packed tarball into a clean temp consumer project.
5. Verify CLI help, a real PDF conversion, and at least one public subpath
   import.

Useful commands:

```sh
npm run build
npm run qa:dependencies
npm run qa:package-size
npm pack --dry-run
```

For final publishability claims, include clean temp-consumer proof rather than
only manifest inspection.

## Review Queue Workflow

Goal: address findings recorded in `review/ISSUES.md`,
`review/OPTIMIZATIONS.md`, or `review/IMPROVEMENTS.md`.

Rules:

- Work one finding at a time unless the user explicitly asks for batching.
- Keep fixes scoped to the finding.
- Verify the fix before checking a review item.
- If the user asks for commit-per-finding proof, commit each verified fix before
  moving to the next item.
- Prefer `ISSUES.md` by severity, then `OPTIMIZATIONS.md`, then
  `IMPROVEMENTS.md` unless a task specifies a different order.

Stop check:

```sh
rg -n "^- \\[ \\]" review/ISSUES.md review/OPTIMIZATIONS.md review/IMPROVEMENTS.md
```

For a new review-only audit, rebuild the file inventory from tracked files
instead of reusing old `review/PROGRESS.md` entries.
