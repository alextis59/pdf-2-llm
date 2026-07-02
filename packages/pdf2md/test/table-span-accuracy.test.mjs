import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTableSpanAccuracy,
  extractMarkdownTableCells
} from "../../../scripts/qa/table-span-accuracy.mjs";

test("extractMarkdownTableCells reads GFM table cells as unspanned cells", () => {
  assert.deepEqual(
    extractMarkdownTableCells([
      "| A | B |",
      "| --- | --- |",
      "| C | D |"
    ].join("\n")),
    [
      cell(0, 0, 0, "A", 1, 1),
      cell(0, 0, 1, "B", 1, 1),
      cell(0, 1, 0, "C", 1, 1),
      cell(0, 1, 1, "D", 1, 1)
    ]
  );
});

test("compareTableSpanAccuracy reports perfect accuracy for matching HTML spans", () => {
  const html = [
    "<table>",
    "<tr><th colspan=\"2\">Merged &amp; Escaped</th></tr>",
    "<tr><td>A</td><td>B</td></tr>",
    "</table>"
  ].join("");

  assert.deepEqual(compareTableSpanAccuracy(html, html), {
    score: 1,
    precision: 1,
    recall: 1,
    matchedCells: 3,
    expectedCells: 3,
    actualCells: 3,
    expectedTables: 1,
    actualTables: 1,
    missing: []
  });
});

test("compareTableSpanAccuracy penalizes incorrect span attributes", () => {
  const expected = [
    "<table>",
    "<tr><th colspan=\"2\">Merged</th></tr>",
    "<tr><td>A</td><td>B</td></tr>",
    "</table>"
  ].join("");
  const actual = [
    "<table>",
    "<tr><th>Merged</th></tr>",
    "<tr><td>A</td><td>B</td></tr>",
    "</table>"
  ].join("");
  const comparison = compareTableSpanAccuracy(expected, actual);

  assert.equal(comparison.score, 0.667);
  assert.equal(comparison.matchedCells, 2);
  assert.equal(comparison.expectedCells, 3);
  assert.deepEqual(
    comparison.missing.map(({ text, rowSpan, columnSpan }) => ({ text, rowSpan, columnSpan })),
    [{ text: "Merged", rowSpan: 1, columnSpan: 2 }]
  );
});

function cell(tableIndex, rowIndex, columnIndex, text, rowSpan, columnSpan) {
  return {
    tableIndex,
    rowIndex,
    columnIndex,
    text,
    rowSpan,
    columnSpan,
    key: [tableIndex, rowIndex, columnIndex, text, rowSpan, columnSpan].join(":")
  };
}
