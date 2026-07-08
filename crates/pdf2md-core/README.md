# pdf2md-core

`pdf2md-core` is the Rust crate used to build the packaged WebAssembly preflight
module. It is not currently the full PDF parser or extraction engine. The full
conversion pipeline still runs through JavaScript in `packages/pdf2md/src/`.

## Current Scope

The crate exposes:

- PDF header/version parsing in Rust.
- A header predicate for native Rust tests.
- C ABI exports for the WASM bridge:
  - `pdf2md_core_version_major`
  - `pdf2md_core_version_minor`
  - `pdf2md_core_version_patch`
  - `pdf2md_alloc`
  - `pdf2md_dealloc`
  - `pdf2md_has_pdf_header`

The JavaScript loader is `packages/pdf2md/src/wasm-loader.mjs`, and the packaged
artifact is copied to `packages/pdf2md/src/wasm/pdf2md_core.wasm`.

## Validation

Run Rust tests:

```sh
cargo test -p pdf2md-core
```

Build and copy the single-threaded WASM preflight artifact:

```sh
npm run wasm:build
```

When changing the JS/WASM boundary, also run the WASM loader API tests:

```sh
node --test packages/pdf2md/test/wasm-loader.test.mjs
```

## Boundaries

- Do not document this crate as a production parser until parser behavior is
  implemented and corpus-gated through the public JS package.
- Keep exported memory functions paired and covered by tests.
- Keep single-threaded WASM as the default package artifact. Threaded WASM must
  remain opt-in and gated by runtime support checks.
