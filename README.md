# pdf-2-llm

## Study documents

- [WebAssembly + WebGPU PDF-to-Markdown study](docs/pdf-to-markdown-webassembly-study.md)
- [PDF-to-Markdown implementation plan](docs/pdf-to-markdown-implementation-plan.md)
- [API reference](docs/api.md)
- [CLI reference](docs/cli.md)
- [WASM loading for bundlers](docs/wasm-loading.md)
- [OCR model loading](docs/ocr-model-loading.md)

## Current package scaffold

- Package: `@pdf-2-llm/pdf2md`
- Validate: `npm run check`
- CLI stub: `node packages/pdf2md/src/cli.mjs corpus/generated/synthetic-simple-text.pdf --json`
- Browser example: `packages/pdf2md/examples/browser-basic.html`
- Node example: `node packages/pdf2md/examples/node-basic.mjs`
- Worker example: `node packages/pdf2md/examples/worker-basic.mjs`
