# Tech Debt Tracker

This tracker records practical gaps that are known from the current repository
state. Keep entries specific enough to validate, and close them only with a
command or artifact that proves the behavior changed.

| Area | Debt | Current Evidence | Next Validation | Status |
| --- | --- | --- | --- | --- |
| Rust/WASM parser path | The Rust crate is a preflight bridge, while the full parser and extraction pipeline still run in JavaScript. | `crates/pdf2md-core/src/lib.rs` exposes header/version helpers; `docs/wasm-loading.md` documents preflight scope. | Add Rust parser behavior behind a public contract, then run `npm run rust:test`, `npm run wasm:build`, WASM loader tests, and corpus gates. | Open |
| OCR execution | OCR model loading is contract-first; conversion does not download or execute OCR models. | `docs/ocr-model-loading.md` and `packages/pdf2md/src/ocr-*.mjs` route caller-supplied OCR boxes. | Add adapter execution with external model loading policy, then run OCR API tests, model-size checks, OCR corpus gates, and throughput benchmarks. | Open |
| Raster rendering | Raster support creates bounded metadata plans and diagnostics, not full rendered page or thumbnail buffers. | `docs/security-limits.md`, `docs/api.md`, and `raster-plan.mjs` describe metadata-only raster plans. | Add renderer-backed outputs with pixel-limit coverage, then run raster, security-limit, asset-link, and corpus checks. | Open |
| Asset output adapter | `assets.enabled` and `assets.outputDir` are contract fields; conversion returns assets in memory instead of writing sidecar files. | `docs/api.md` lists these fields as reserved contract fields. | Implement explicit writer or adapter behavior, then add CLI/API tests and asset-link validation. | Open |
| CLI advanced controls | The CLI exposes local path, `--output`, `--json`, and debug trace flags only. API-only controls include password callbacks, OCR results, security limits, raster, WebGPU, attachments, and table sidecar toggles. | `docs/cli.md` and `packages/pdf2md/src/cli.mjs`. | Add narrowly scoped flags with tests and fixture conversions; keep help text and docs aligned. | Open |
| Threaded WASM | Threaded WASM selection is planned through loader diagnostics, but the stable full threaded parser path is not promoted. | `docs/wasm-loading.md` and `wasm-loader.mjs` support load-plan diagnostics and fallback. | Validate threaded artifacts only with SharedArrayBuffer, cross-origin isolation, and shared-memory support; keep single-thread fallback tested. | Open |
| Review-ledger artifacts | `review/` contains completed review artifacts from prior audits. They are useful history but are not the source of truth for current architecture. | `review/PROGRESS.md`, `review/ISSUES.md`, `review/IMPROVEMENTS.md`, and `review/OPTIMIZATIONS.md`. | Rebuild review inventories from `git ls-files` when starting a new review-only audit instead of trusting stale checklists. | Historical |
