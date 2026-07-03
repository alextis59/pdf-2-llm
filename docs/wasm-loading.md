# WASM Loading for Bundlers

This package currently ships JavaScript sources only. There is no packaged
`.wasm` artifact, no `./wasm-*` package export, and no public `locateWasm`
option yet. The current browser, worker, Node, and CLI entrypoints all run the
JavaScript parser and extraction pipeline.

This document defines the bundler contract to keep examples and application
integration stable while the Rust/WebAssembly bridge is added later.

## Entrypoints

Use the most specific entrypoint for the runtime:

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/browser";
```

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/worker";
```

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/node";
```

Bundlers should prefer `@pdf-2-llm/pdf2md/browser` in browser UI code and
`@pdf-2-llm/pdf2md/worker` inside module workers. Node scripts should use
`@pdf-2-llm/pdf2md/node`.

The root export also has conditional `node` and `browser` targets, but explicit
subpath imports make application bundles easier to audit.

## Browser Bundles Today

No special WASM loader configuration is required today because no `.wasm` file
is imported by the package.

Use normal ESM bundling:

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/browser";

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
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/worker";
```

The repository examples show the same message-passing pattern:

- `packages/pdf2md/examples/browser-basic.html`
- `packages/pdf2md/examples/worker-basic.mjs`

## Planned WASM Asset Contract

When the WASM bridge is implemented, the package should preserve these
integration rules:

- Single-threaded WASM is the default browser build.
- Threaded WASM is selected only when the runtime is cross-origin isolated.
- WASM assets are loaded as external files, not inlined into JavaScript.
- The loader resolves package-relative assets with `new URL(..., import.meta.url)`.
- Applications can override asset resolution with an explicit locator option
  once that option exists.
- Bundlers must copy emitted `.wasm` assets to the final build output.
- Servers must serve `.wasm` files with `Content-Type: application/wasm`.

Expected future artifact names from the study are:

```txt
pdf2md_single.wasm
pdf2md_threads.wasm
```

These files are not present in the package yet.

## Vite

Current package state:

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/browser";
```

No Vite WASM configuration is required until the package imports a `.wasm`
asset.

Future WASM bridge expectations:

- Keep worker files as ESM module workers.
- Let Vite rewrite `new URL("./asset.wasm", import.meta.url)` references.
- Do not inline large `.wasm` files as base64 data URLs.
- Verify that the production build emits the `.wasm` asset under `dist/assets`
  or the configured asset directory.

## Webpack 5

Current package state requires no Webpack WASM experiment.

Future WASM bridge expectations:

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

Current package state requires no Rollup WASM plugin.

Future WASM bridge expectations:

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
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/node";
```

If a future deployment bundles Node code into a single file, copy the package's
external `.wasm` files next to the bundle or configure the future locator option
to point at deployed assets.

## Verification Checklist

- Build the production bundle.
- Confirm no `.wasm` request exists for the current package version.
- Once WASM ships, confirm exactly one baseline `.wasm` file is requested for a
  simple conversion.
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
