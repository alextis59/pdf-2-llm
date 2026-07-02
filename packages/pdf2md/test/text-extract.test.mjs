import assert from "node:assert/strict";
import test from "node:test";
import { linesToMarkdown } from "../src/text-extract.mjs";

test("linesToMarkdown normalizes common ligatures and whitespace", () => {
  const markdown = linesToMarkdown([
    {
      text: "\uFB01le   \uFB02ow",
      fontSize: 22,
      x: 10,
      y: 20
    },
    {
      text: "plain\t\ttext",
      fontSize: 12,
      x: 10,
      y: 10
    }
  ]);

  assert.equal(markdown, "# file flow\n\nplain text\n");
});
