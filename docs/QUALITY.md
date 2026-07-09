# Quality

Quality in this repository is corpus-backed. Unit tests are necessary, but PDF
correctness also depends on reviewed fixtures, acceptance YAML, oracle outputs,
rendered Markdown, warning codes, diagnostics, and benchmark reports.

## CI Gate

GitHub Actions runs on pushes and pull requests to `main` using Node 22 and the
stable Rust toolchain with the `wasm32-unknown-unknown` target. CI installs with
`npm ci`, runs `npm run check`, and uploads `.temp/qa`,
`.temp/layout-overlays`, and `corpus/reports` artifacts when present.

`npm run check` is intentionally broad. It includes Rust tests, WASM build,
syntax lint, corpus validation and analysis dry runs, acceptance validation,
corpus runs, rendered Markdown checks, oracle comparisons, table checks,
warning checks, WebGPU checks, benchmarks, dependency/package/model-size gates,
fuzz smoke, build, and API tests.

## Validation Ladder

| Change type | Focused validation |
| --- | --- |
| Documentation only | Inspect changed links and run a nearby lightweight command when docs reference behavior. |
| JavaScript syntax or scripts | `npm run lint` |
| Public API or package entrypoints | `npm run test:api` |
| CLI behavior | `node packages/pdf2md/src/cli.mjs --help` plus a fixture conversion, then `npm run test:api` when parsing/output changed. |
| Parser, stream filters, fonts, or text extraction | Focused `node --test packages/pdf2md/test/<area>.test.mjs`, then `npm run test:api`. |
| Security limits or malformed PDFs | `node --test packages/pdf2md/test/security-limits.test.mjs packages/pdf2md/test/malicious-pdf.test.mjs` and `npm run qa:malformed`. |
| Corpus manifest or files | `npm run corpus:validate` |
| Acceptance YAML | `npm run corpus:acceptance` |
| Accepted Markdown behavior | Relevant `npm run corpus:run:*` command with `--assert-markdown` behavior where the script supports it. |
| Tables | `npm run corpus:run:tables`, `npm run qa:table-detection`, and related table adjacency/span/CSV checks when touched. |
| OCR planning or injected OCR text | OCR-focused API tests and `npm run qa:benchmark:ocr-throughput` when performance is relevant. |
| WebGPU | `npm run qa:webgpu-comparison` and `npm run qa:webgpu-preprocess`; speedup is meaningful only when a real browser provider is selected. |
| Rust/WASM bridge | `npm run rust:test`, `npm run wasm:build`, and WASM loader tests when the JS bridge changes. |
| Package or release surface | `npm run build`, package export smoke checks, CLI smoke, `npm pack --dry-run`, and a clean temp-consumer install for publishability claims. |

## Corpus Expectations

- Every gating PDF must have a manifest entry and acceptance file.
- External oracle outputs are review aids, not ground truth by themselves.
- Unsupported behavior is acceptable only when the expected warning, sidecar, or
  fallback is documented.
- `--update-snapshots` in `scripts/qa/run-corpus.mjs` is reserved and currently
  rejected; update corpus fixtures through reviewed file changes.
- Gating corpus runs execute every declared `must`, `mustNot`, metric,
  structure, asset, snippet, warning, source-type, and expected-mode assertion.
  Unknown criteria fail closed; recognizing a criterion name is not evidence
  that it passed.
- Text coverage uses a reviewed Markdown snapshot when one exists and otherwise
  falls back to the stored text oracle. Raw text oracles remain the reference
  for repeated running-content removal checks.
- Text-only corpus runs can emit baseline warnings such as `ocr.disabled` and
  `text.heuristic_content_stream`; do not treat those as unexpected unless the
  acceptance file or test says so.

## Reports

Use `.temp/qa/` for ephemeral local summaries. Use `corpus/reports/` only for
representative reports that are part of release evidence or stable baselines.

Performance-sensitive changes need one of:

- Before/after benchmark reports.
- A relevant smoke benchmark showing the touched path still gates.
- A short not-applicable rationale when the change cannot affect runtime,
  memory, or package size.

## Release Readiness

Before claiming that the package can be published or installed:

1. Inspect the root `package.json`, not only `packages/pdf2md/package.json`.
2. Run the relevant package-size and dependency checks.
3. Run `npm pack --dry-run` from the publish root.
4. Install the packed tarball into a clean temp project.
5. Verify `pdf-2-llm --help`, a real fixture conversion, and a public subpath
   import such as `pdf-2-llm/node`.

## Documentation Quality

Docs must match verified behavior. When a feature is contract-first or planned,
say so directly instead of documenting it as enforced runtime behavior. Update
`docs/tech-debt-tracker.md` when a known gap remains open after a scoped task.
