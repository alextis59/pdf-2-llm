# WASM Loading for Bundlers

This package ships a small single-threaded Rust/WebAssembly preflight core at
`pdf-2-llm/wasm`. The current browser, worker, Node, and CLI
conversion entrypoints still run the JavaScript parser and extraction pipeline;
the WASM module is a separately loaded bridge used for low-level PDF byte
preflight.

This document defines the bundler contract for the packaged WASM asset and the
future full Rust/WebAssembly parser path.

## Entrypoints

Use the most specific entrypoint for the runtime:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/browser";
```

```js
import { convertPdfToMarkdown } from "pdf-2-llm/worker";
```

```js
import { convertPdfToMarkdown } from "pdf-2-llm/node";
```

Bundlers should prefer `pdf-2-llm/browser` in browser UI code and
`pdf-2-llm/worker` inside module workers. Node scripts should use
`pdf-2-llm/node`.

The root export also has conditional `node` and `browser` targets, but explicit
subpath imports make application bundles easier to audit.

The WASM preflight export is:

```js
import { loadPdf2mdCoreWasm } from "pdf-2-llm/wasm";

const core = await loadPdf2mdCoreWasm();
const looksLikePdf = core.hasPdfHeader(await file.arrayBuffer());
```

## Browser Bundles Today

No special WASM loader configuration is required for the main browser
conversion entrypoint because it does not import the `.wasm` file directly.
Applications that import `pdf-2-llm/wasm` must let the bundler emit the
package-relative `.wasm` asset.

Use normal ESM bundling:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/browser";

const result = await convertPdfToMarkdown(await file.arrayBuffer());
```

For worker offloading, create a module worker from an application-owned worker
file:

```js
const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
  type: "module"
});
```

Then import the worker entrypoint inside `pdf-worker.mjs`:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/worker";
```

The repository examples show the same message-passing pattern:

- `packages/pdf2md/examples/browser-basic.html`
- `packages/pdf2md/examples/worker-basic.mjs`

## WASM Asset Contract

The package preserves these integration rules:

- Single-threaded WASM is the default browser build.
- Threaded WASM is selected only when the runtime is cross-origin isolated.
- WASM assets are loaded as external files, not inlined into JavaScript.
- The loader resolves package-relative assets with `new URL(..., import.meta.url)`.
- Applications can override the source with `loadPdf2mdCoreWasm({ source })`.
- Bundlers must copy emitted `.wasm` assets to the final build output.
- Servers must serve `.wasm` files with `Content-Type: application/wasm`.

The current packaged artifact is:

```txt
src/wasm/pdf2md_core.wasm
```

The optional threaded build removes its packaged destination before each build
attempt. If Cargo cannot produce the shared-memory artifact, the report records
`status: "unavailable"` and no stale `pdf2md_core.threaded.wasm` remains for a
later package build to include.

Future full-parser artifact names from the study are still expected to be split
into single-threaded and threaded modules.

## Vite

```js
import { convertPdfToMarkdown } from "pdf-2-llm/browser";
```

```js
import { loadPdf2mdCoreWasm } from "pdf-2-llm/wasm";
```

Vite should rewrite the loader's package-relative asset URL automatically.
Verify that the production build emits `pdf2md_core.wasm` as an external asset
rather than inlining it.

- Keep worker files as ESM module workers.
- Let Vite rewrite `new URL("./asset.wasm", import.meta.url)` references.
- Do not inline large `.wasm` files as base64 data URLs.
- Verify that the production build emits the `.wasm` asset under `dist/assets`
  or the configured asset directory.

## Webpack 5

The preflight loader fetches the `.wasm` asset as a URL, so projects can handle
the artifact as a resource:

```js
export default {
  experiments: {
    asyncWebAssembly: true
  },
  module: {
    rules: [
      {
        test: /\.wasm$/,
        type: "asset/resource"
      }
    ]
  }
};
```

Use application-specific equivalents if the project already centralizes asset
rules. The important requirements are external `.wasm` emission, stable public
URLs, and `application/wasm` serving.

## Rollup

- Preserve ESM output for browser and worker bundles.
- Emit `.wasm` files as assets.
- Keep worker entry files separate from the main bundle unless the application
  intentionally bundles workers.
- Verify generated asset URLs after `rollup -c`.

## Next.js and Other SSR Frameworks

Run PDF conversion from client-only code when using browser or worker
entrypoints. Server components and SSR loaders should use the Node entrypoint
instead.

Threaded WASM, once implemented, will require cross-origin isolation headers:

```txt
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Do not enable those headers casually across an existing application. They affect
iframes, cross-origin resources, analytics scripts, and document embedding.

## Node Bundles

Node scripts should use:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/node";
```

Node applications can load the preflight module from bytes or from a fetchable
URL:

```js
import { readFile } from "node:fs/promises";
import { loadPdf2mdCoreWasm } from "pdf-2-llm/wasm";

const wasm = await readFile(new URL("./pdf2md_core.wasm", import.meta.url));
const core = await loadPdf2mdCoreWasm(wasm);
```

If a deployment bundles Node code into a single file, copy the package's
external `.wasm` file next to the bundle or pass an explicit `source`.

## Verification Checklist

- Build the production bundle.
- When importing `pdf-2-llm/wasm`, confirm exactly one baseline `.wasm`
  file is requested.
- Confirm the response has HTTP 200 and `Content-Type: application/wasm`.
- Confirm worker bundles load through `new Worker(new URL(...), { type: "module" })`.
- Confirm non-isolated browsers use the single-threaded build.
- Confirm isolated browsers can select the threaded build only when enabled.
- Run a small conversion through the bundled app and compare the Markdown to the
  same conversion in Node.

## Common Failure Modes

`Failed to fetch dynamically imported module`

The worker file or package ESM chunk was not emitted where the browser expects
it. Check generated URLs and the server's static asset rules.

`WebAssembly.instantiateStreaming(): unsupported MIME type`

The server is not sending `application/wasm`. Fix the static asset MIME mapping.

`SharedArrayBuffer is not defined`

The runtime is not cross-origin isolated. Use the single-threaded build or add
the required COOP/COEP headers after checking application compatibility.

`String path input is only supported in Node runtimes`

Browser and worker bundles must pass `ArrayBuffer`, `Uint8Array`, or an object
with `bytes`. Local filesystem path strings are for the Node entrypoint.
