# Agent Instructions

Start by reading `ARCHITECTURE.md` and `docs/index.md`. Keep changes scoped to
the requested task, preserve existing behavior unless the issue asks otherwise,
and run the most relevant validation before finishing.

## Repository Priorities

- Treat PDFs as untrusted binary input. Keep parser, resource-limit, password,
  malformed-input, and warning-code behavior explicit.
- Preserve the public package contract: Markdown, source maps, assets, document
  IR, warnings, diagnostics, and confidence scores are all user-facing output.
- Use public docs and examples with `pdf-2-llm/*` imports. The
  `@pdf-2-llm/pdf2md` workspace name is an implementation package unless a task
  is specifically about the workspace package.
- Keep CPU output as the correctness baseline. WebGPU, threaded WASM, OCR, and
  future acceleration paths must preserve the same output shapes.
- Do not commit uncleared PDFs. Use `corpus/raw/_incoming/` for quarantine and
  `corpus/raw/local-only/` for local-only files.

## Common Work Areas

- Public API and conversion pipeline: `packages/pdf2md/src/index.mjs` and
  `packages/pdf2md/src/index.d.ts`.
- CLI: `packages/pdf2md/src/cli.mjs` and `docs/cli.md`.
- Node, browser, worker, schema, and WASM entrypoints:
  `packages/pdf2md/src/{node,browser,worker,schema,wasm-loader}.mjs`.
- Parser and extraction internals: `pdf-parser.mjs`, `content-stream.mjs`,
  `font-encoding.mjs`, `text-extract.mjs`, `table-grid.mjs`, and related OCR,
  raster, figure, WebGPU, and interaction modules.
- Rust/WASM preflight bridge: `crates/pdf2md-core/` plus
  `scripts/build/copy-wasm.mjs`.
- Corpus and acceptance workflow: `corpus/manifest.json`,
  `corpus/accepted/*.yaml`, `corpus/expected/`, `corpus/baselines/`, and
  `scripts/corpus/`.
- QA gates and reports: `scripts/qa/`, `.temp/qa/`, and `corpus/reports/`.

## Validation Guidance

Pick the narrowest command that covers the change, then broaden when the change
touches shared contracts.

- Docs-only changes: inspect links and run the closest lightweight check that
  still exercises referenced tooling when practical.
- JavaScript syntax or scripts: `npm run lint`.
- Public API, parser, extraction, warning, schema, or CLI changes:
  `npm run test:api`.
- Corpus metadata or acceptance changes:
  `npm run corpus:validate` and `npm run corpus:acceptance`.
- Accepted output behavior: run the relevant `corpus:run:*` or focused
  `scripts/qa/*` command before broad checks.
- Rust or WASM bridge changes: `npm run rust:test`, then `npm run wasm:build`
  when the `.wasm` artifact is affected.
- Package or release-surface changes: verify `npm run build`, package exports,
  CLI execution, and `npm pack --dry-run` before claiming publishability.
- Broad pre-merge confidence: `npm run check`.

## Documentation Expectations

- Update `ARCHITECTURE.md` when module boundaries, runtime surfaces, or data
  flow change.
- Update `docs/SECURITY.md` when security limits, password handling,
  filesystem behavior, dependency policy, corpus licensing, or hostile-input
  behavior changes.
- Update `docs/QUALITY.md` when validation commands, CI gates, reports, or
  release proof expectations change.
- Update `docs/tech-debt-tracker.md` for known gaps that remain intentionally
  open after a scoped change.
- Keep `docs/index.md` as the routing page for humans and agents.
