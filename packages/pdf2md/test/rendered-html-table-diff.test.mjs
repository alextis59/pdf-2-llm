import assert from "node:assert/strict";
import test from "node:test";
import { diffRenderedHtmlTables } from "../../../scripts/qa/diff-html-tables.mjs";

test("diffRenderedHtmlTables passes matching rendered GFM tables", () => {
  const markdown = [
    "| Quarter | Revenue |",
    "| --- | ---: |",
    "| Q1 | 100 |",
    "| Q2 | 120 |"
  ].join("\n");

  assert.deepEqual(diffRenderedHtmlTables(markdown, markdown), {
    passed: true,
    expectedTables: 1,
    actualTables: 1,
    differences: []
  });
});

test("diffRenderedHtmlTables reports rendered cell text mismatches", () => {
  const expected = [
    "| Quarter | Revenue |",
    "| --- | ---: |",
    "| Q1 | 100 |"
  ].join("\n");
  const actual = [
    "| Quarter | Revenue |",
    "| --- | ---: |",
    "| Q1 | 999 |"
  ].join("\n");

  const diff = diffRenderedHtmlTables(expected, actual);

  assert.equal(diff.passed, false);
  assert.deepEqual(diff.differences, [
    {
      kind: "cell-text",
      tableIndex: 0,
      rowIndex: 1,
      columnIndex: 1,
      expected: "100",
      actual: "999"
    }
  ]);
});

test("diffRenderedHtmlTables reports rendered raw HTML span mismatches", () => {
  const expected = [
    "<table>",
    "<tr><td colspan=\"2\">Merged</td></tr>",
    "<tr><td>A</td><td>B</td></tr>",
    "</table>"
  ].join("");
  const actual = [
    "<table>",
    "<tr><td>Merged</td></tr>",
    "<tr><td>A</td><td>B</td></tr>",
    "</table>"
  ].join("");

  const diff = diffRenderedHtmlTables(expected, actual);

  assert.equal(diff.passed, false);
  assert.deepEqual(diff.differences, [
    {
      kind: "cell-span",
      tableIndex: 0,
      rowIndex: 0,
      columnIndex: 0,
      expected: {
        rowSpan: 1,
        columnSpan: 2
      },
      actual: {
        rowSpan: 1,
        columnSpan: 1
      }
    }
  ]);
});
