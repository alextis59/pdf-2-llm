import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { convertPdfToMarkdown } from "../src/index.mjs";

const browserExample = new URL("../examples/browser-basic.html", import.meta.url);
const nodeExample = new URL("../examples/node-basic.mjs", import.meta.url);
const workerExample = new URL("../examples/worker-basic-worker.mjs", import.meta.url);

test("published browser example includes a convertible one-click fixture", async () => {
  const html = await readFile(browserExample, "utf8");
  const encodedFixture = html.match(/const samplePdfBase64 = "([A-Za-z0-9+/=]+)";/)?.[1];

  assert.ok(encodedFixture, "browser example should embed its sample PDF");
  assert.doesNotMatch(html, /corpus\/generated\//);

  const result = await convertPdfToMarkdown(Buffer.from(encodedFixture, "base64"));
  assert.equal(
    result.markdown,
    "# Synthetic Simple Text\n\nThis fixture validates basic paragraph extraction.\n\nThe expected output is deterministic.\n"
  );
});

test("published examples import only public package subpaths", async () => {
  const [html, nodeSource, workerSource] = await Promise.all([
    readFile(browserExample, "utf8"),
    readFile(nodeExample, "utf8"),
    readFile(workerExample, "utf8")
  ]);
  const browserModuleSource = html.match(
    /<script type="module">([\s\S]*?)<\/script>/
  )?.[1] ?? "";

  assert.doesNotMatch(
    `${browserModuleSource}\n${nodeSource}\n${workerSource}`,
    /\.\.\/src\//
  );
  assert.match(nodeSource, /from "pdf-2-llm\/node"/);
  assert.match(workerSource, /from "pdf-2-llm\/worker"/);
  assert.match(html, /from "pdf-2-llm\/browser"/);
  assert.match(html, /from "pdf-2-llm\/wasm"/);
  assert.match(html, /"pdf-2-llm\/browser": "\.\.\/src\/browser\.mjs"/);
  assert.match(html, /"pdf-2-llm\/wasm": "\.\.\/src\/wasm-loader\.mjs"/);
});
