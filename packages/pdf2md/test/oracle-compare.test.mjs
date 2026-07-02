import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTextCoverage,
  markdownToComparableText,
  tokenizeComparableText
} from "../../../scripts/qa/compare-oracles.mjs";

test("oracle comparison tokenizes Markdown as comparable text", () => {
  const tokens = tokenizeComparableText(
    markdownToComparableText("# Title\n\n- First item\n- Second item\n\n| A | B |")
  );

  assert.deepEqual(tokens, ["title", "first", "item", "second", "item", "a", "b"]);
});

test("oracle comparison uses repeated token coverage", () => {
  const comparison = compareTextCoverage("Alpha beta beta gamma", "# Alpha\n\nbeta gamma");

  assert.equal(comparison.matchedTokens, 3);
  assert.equal(comparison.oracleTokens, 4);
  assert.equal(comparison.actualTokens, 3);
  assert.equal(comparison.coverage, 0.75);
});
