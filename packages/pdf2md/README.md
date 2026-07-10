# @pdf-2-llm/pdf2md Workspace

This workspace contains the JavaScript implementation behind the root
`pdf-2-llm` npm package. Public documentation and downstream examples should
import from `pdf-2-llm/*`; the scoped workspace name is for repository-local
implementation, tests, and package scripts.

## Layout

```text
packages/pdf2md/
  src/       converter, parser, schemas, runtime entrypoints, CLI, WASM loader
  test/      Node test suite for API, parser, corpus, QA helpers, and behavior
  examples/  Node, browser, and worker examples
  fuzz/      deterministic JavaScript fuzz smoke targets
```

## Important Entry Points

- `src/index.mjs`: `convertPdfToMarkdown()` orchestration and public exports.
- `src/index.d.ts`: TypeScript contract for inputs, options, results,
  diagnostics, assets, warnings, and confidence.
- `src/node.mjs`, `src/browser.mjs`, `src/worker.mjs`: runtime-specific public
  entrypoints.
- `src/schema.mjs`: schema version, warning codes, document IR schema, and
  source-map schema.
- `src/wasm-loader.mjs`: package-relative WASM loading and threaded-load-plan
  diagnostics.
- `src/cli.mjs`: `pdf-2-llm` and `pdf2md` command implementation.

## Local Scripts

Run from the repository root:

```sh
npm run build --workspace @pdf-2-llm/pdf2md
npm run test --workspace @pdf-2-llm/pdf2md
npm run fuzz:smoke --workspace @pdf-2-llm/pdf2md
```

Root aliases:

```sh
npm run build
npm run test:api
npm run fuzz:smoke
```

## Development Rules

- Preserve public result shapes unless the task explicitly changes the API
  contract.
- Add or update `src/index.d.ts` and schema tests when serialized shapes change.
- Keep warning codes stable and documented.
- Keep CPU behavior as the correctness baseline for optional OCR, WebGPU, and
  WASM paths.
- Use focused tests first, then broaden to `npm run test:api` or `npm run
  check` when shared behavior changes.

## Examples

```sh
npm run example:node
npm run example:worker
```

The checkout scripts register a local resolver for the same public
`pdf-2-llm/*` imports that installed consumers resolve through the export map.
The browser example is `packages/pdf2md/examples/browser-basic.html`; its
import map points those public specifiers at the checkout files.
