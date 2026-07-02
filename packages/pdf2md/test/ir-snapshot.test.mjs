import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown } from "../src/index.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);
const snapshotPath = new URL(
  "../../../corpus/expected/synthetic-simple-text.ir.json",
  import.meta.url
);

test("serialized IR matches reviewed snapshot for synthetic simple text", async () => {
  const expected = JSON.parse(await readFile(snapshotPath, "utf8"));
  const result = await convertPdfToMarkdown(fixturePath.pathname);
  const actual = JSON.parse(JSON.stringify(result.ir));

  assert.deepEqual(actual, expected);
});
