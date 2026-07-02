import assert from "node:assert/strict";
import test from "node:test";
import {
  compareReadingOrder,
  compareTextCoverage,
  markdownToComparableText,
  tokenEditDistance,
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

test("oracle comparison reports normalized reading-order edit distance", () => {
  const exact = compareReadingOrder("Alpha beta gamma", "Alpha beta gamma");
  const reordered = compareReadingOrder("Alpha beta gamma", "Alpha gamma beta");

  assert.equal(exact.readingOrderEdits, 0);
  assert.equal(exact.readingOrderDistance, 0);
  assert.equal(exact.readingOrderSimilarity, 1);
  assert.equal(reordered.readingOrderEdits, 2);
  assert.equal(reordered.readingOrderDistance, 2 / 3);
  assert.ok(Math.abs(reordered.readingOrderSimilarity - 1 / 3) < Number.EPSILON);
});

test("tokenEditDistance handles insertions and deletions", () => {
  assert.equal(tokenEditDistance(["alpha", "beta"], ["alpha", "middle", "beta"]), 1);
  assert.equal(tokenEditDistance(["alpha", "middle", "beta"], ["alpha", "beta"]), 1);
});
