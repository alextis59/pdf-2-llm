import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { convertPdfToMarkdown } from "../src/index.mjs";

const browserExample = new URL("../examples/browser-basic.html", import.meta.url);

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
