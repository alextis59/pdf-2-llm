import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTableDetection,
  createTableDetectionReport,
  extractTableBlocks
} from "../../../scripts/qa/check-table-detection.mjs";

test("extractTableBlocks detects GFM and HTML table blocks", () => {
  assert.deepEqual(
    extractTableBlocks(
      [
        "# Title",
        "",
        "| A | B |",
        "| --- | ---: |",
        "| 1 | 2 |",
        "",
        "<table>",
        "  <tbody>",
        "    <tr><td>Merged</td></tr>",
        "  </tbody>",
        "</table>",
        "",
        "Not a table."
      ].join("\n")
    ),
    [
      {
        format: "gfm",
        text: ["| A | B |", "| --- | ---: |", "| 1 | 2 |"].join("\n")
      },
      {
        format: "html",
        text: ["<table>", "<tbody>", "<tr><td>Merged</td></tr>", "</tbody>", "</table>"].join(
          "\n"
        )
      }
    ]
  );
});

test("compareTableDetection passes exact table counts", () => {
  const markdown = ["# Table", "", "| A |", "| --- |", "| 1 |"].join("\n");

  assert.deepEqual(compareTableDetection(markdown, markdown), {
    expectedTables: 1,
    actualTables: 1,
    expectedFormats: { gfm: 1 },
    actualFormats: { gfm: 1 },
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 0,
    precision: 1,
    recall: 1,
    passed: true
  });
});

test("compareTableDetection reports false positives and false negatives", () => {
  const expected = ["# Table", "", "| A |", "| --- |", "| 1 |", "", "| B |", "| --- |", "| 2 |"].join(
    "\n"
  );
  const actual = ["# Table", "", "| A |", "| --- |", "| 1 |", "", "Prose."].join("\n");
  const comparison = compareTableDetection(expected, actual);

  assert.equal(comparison.passed, false);
  assert.equal(comparison.truePositives, 1);
  assert.equal(comparison.falsePositives, 0);
  assert.equal(comparison.falseNegatives, 1);
  assert.equal(comparison.precision, 1);
  assert.equal(comparison.recall, 0.5);

  const negativeComparison = compareTableDetection("No table.\n", actual);
  assert.equal(negativeComparison.falsePositives, 1);
  assert.equal(negativeComparison.falseNegatives, 0);
  assert.equal(negativeComparison.precision, 0);
});

test("createTableDetectionReport aggregates precision and recall", () => {
  const report = createTableDetectionReport([
    compareTableDetection("| A |\n| --- |\n| 1 |\n", "| A |\n| --- |\n| 1 |\n"),
    compareTableDetection("| B |\n| --- |\n| 2 |\n", "No table.\n")
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.expectedTables, 2);
  assert.equal(report.actualTables, 1);
  assert.equal(report.truePositives, 1);
  assert.equal(report.falseNegatives, 1);
  assert.equal(report.precision, 1);
  assert.equal(report.recall, 0.5);
});
