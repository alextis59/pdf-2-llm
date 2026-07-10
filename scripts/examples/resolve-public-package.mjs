const publicEntrypoints = new Map(
  Object.entries({
    "pdf-2-llm": "../../packages/pdf2md/src/index.mjs",
    "pdf-2-llm/browser": "../../packages/pdf2md/src/browser.mjs",
    "pdf-2-llm/node": "../../packages/pdf2md/src/node.mjs",
    "pdf-2-llm/schema": "../../packages/pdf2md/src/schema.mjs",
    "pdf-2-llm/wasm": "../../packages/pdf2md/src/wasm-loader.mjs",
    "pdf-2-llm/worker": "../../packages/pdf2md/src/worker.mjs"
  }).map(([specifier, target]) => [specifier, new URL(target, import.meta.url).href])
);

export function resolve(specifier, context, nextResolve) {
  const url = publicEntrypoints.get(specifier);
  if (url) {
    return { shortCircuit: true, url };
  }
  return nextResolve(specifier, context);
}
