import assert from "node:assert/strict";
import test from "node:test";
import {
  compareCharacterErrorRate,
  compareReadingOrder,
  compareTextCoverage,
  markdownToComparableText,
  tokenEditDistance,
  tokenizeComparableText
} from "../../../scripts/qa/compare-oracles.mjs";
import {
  compareRunningContent,
  countPhraseOccurrences
} from "../../../scripts/qa/compare-running-content.mjs";

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

test("oracle comparison reports normalized character error rate", () => {
  const exact = compareCharacterErrorRate("# Title\n\nAlpha beta", "Title\n\nAlpha beta");
  const mutated = compareCharacterErrorRate("Alpha beta", "Alpha bet");

  assert.equal(exact.characterEdits, 0);
  assert.equal(exact.characterErrorRate, 0);
  assert.equal(mutated.characterEdits, 1);
  assert.equal(mutated.characterErrorRate, 1 / "alpha beta".length);
});

test("tokenEditDistance handles insertions and deletions", () => {
  assert.equal(tokenEditDistance(["alpha", "beta"], ["alpha", "middle", "beta"]), 1);
  assert.equal(tokenEditDistance(["alpha", "middle", "beta"], ["alpha", "beta"]), 1);
});

test("running-content comparison reports phrase-level precision and recall", () => {
  const comparison = compareRunningContent(
    "Header\nBody phrase\nFooter\nKeep me\n",
    "Body phrase\n",
    {
      expectedRemoved: ["Header", "Footer"],
      expectedRetained: ["Body phrase", "Keep me"]
    }
  );

  assert.equal(countPhraseOccurrences("Header Header", "Header"), 2);
  assert.equal(comparison.truePositives, 2);
  assert.equal(comparison.falsePositives, 1);
  assert.equal(comparison.falseNegatives, 0);
  assert.equal(comparison.trueNegatives, 1);
  assert.equal(comparison.precision, 2 / 3);
  assert.equal(comparison.recall, 1);
});
