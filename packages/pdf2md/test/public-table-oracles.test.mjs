import assert from "node:assert/strict";
import test from "node:test";
import { extractGfmTableBlocks } from "../../../scripts/qa/compare-public-tables.mjs";

test("extractGfmTableBlocks extracts multiple table blocks without prose", () => {
  const markdown = [
    "Before",
    "",
    "| A | B |",
    "| --- | --- |",
    "| C | D |",
    "",
    "Between",
    "",
    "| E | F |",
    "| --- | --- |",
    "| G | H |",
    "",
    "After"
  ].join("\n");

  assert.deepEqual(extractGfmTableBlocks(markdown), [
    ["| A | B |", "| --- | --- |", "| C | D |"].join("\n"),
    ["| E | F |", "| --- | --- |", "| G | H |"].join("\n")
  ]);
});
