import assert from "node:assert/strict";
import test from "node:test";
import {
  compareParagraphGrouping,
  createParagraphGroupingReport,
  extractParagraphBlocks
} from "../../../scripts/qa/check-paragraph-grouping.mjs";

test("extractParagraphBlocks ignores structural Markdown blocks", () => {
  assert.deepEqual(
    extractParagraphBlocks(
      [
        "# Title",
        "",
        "First paragraph",
        "continues.",
        "",
        "- List item",
        "",
        "![Figure](assets/figure.png)",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "<p dir=\"rtl\">אבג דהו</p>"
      ].join("\n")
    ),
    ["First paragraph continues.", "אבג דהו"]
  );
});

test("compareParagraphGrouping reports perfect F1 for matching paragraph groups", () => {
  assert.deepEqual(
    compareParagraphGrouping("A wrapped\nparagraph.\n\nSecond paragraph.\n", "A wrapped paragraph.\n\nSecond paragraph.\n"),
    {
      expectedParagraphs: 2,
      actualParagraphs: 2,
      matchedParagraphs: 2,
      precision: 1,
      recall: 1,
      f1: 1,
      missingParagraphs: [],
      extraParagraphs: [],
      passed: true
    }
  );
});

test("compareParagraphGrouping penalizes merged paragraphs", () => {
  const comparison = compareParagraphGrouping("First paragraph.\n\nSecond paragraph.\n", "First paragraph. Second paragraph.\n");

  assert.equal(comparison.passed, false);
  assert.equal(comparison.expectedParagraphs, 2);
  assert.equal(comparison.actualParagraphs, 1);
  assert.equal(comparison.matchedParagraphs, 0);
  assert.deepEqual(comparison.missingParagraphs, ["First paragraph.", "Second paragraph."]);
  assert.deepEqual(comparison.extraParagraphs, ["First paragraph. Second paragraph."]);
});

test("createParagraphGroupingReport aggregates precision recall and F1", () => {
  const report = createParagraphGroupingReport([
    compareParagraphGrouping("First.\n\nSecond.\n", "First.\n\nSecond.\n"),
    compareParagraphGrouping("Third.\n", "Third. Extra.\n")
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.expectedParagraphs, 3);
  assert.equal(report.actualParagraphs, 3);
  assert.equal(report.matchedParagraphs, 2);
  assert.equal(report.precision, 2 / 3);
  assert.equal(report.recall, 2 / 3);
  assert.equal(report.f1, 2 / 3);
});
