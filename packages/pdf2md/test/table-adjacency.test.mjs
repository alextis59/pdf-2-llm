import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTableCellAdjacency,
  extractGfmTables
} from "../../../scripts/qa/table-adjacency.mjs";

test("extractGfmTables reads table cells while preserving escaped pipes", () => {
  assert.deepEqual(
    extractGfmTables([
      "# Fixture",
      "",
      "| Name | Note |",
      "| --- | --- |",
      "| Alpha | A\\|B |"
    ].join("\n")),
    [
      [
        ["Name", "Note"],
        ["Alpha", "A|B"]
      ]
    ]
  );
});

test("compareTableCellAdjacency reports perfect adjacency for matching tables", () => {
  const markdown = [
    "| Item | Count | Price |",
    "| --- | ---: | ---: |",
    "| Pencil | 4 | 2.00 |",
    "| Notebook | 2 | 7.50 |"
  ].join("\n");

  assert.deepEqual(compareTableCellAdjacency(markdown, markdown), {
    score: 1,
    matchedPairs: 12,
    expectedPairs: 12,
    actualPairs: 12,
    expectedTables: 1,
    actualTables: 1,
    missing: []
  });
});

test("compareTableCellAdjacency penalizes shifted cell relationships", () => {
  const expected = [
    "| A | B |",
    "| --- | --- |",
    "| C | D |"
  ].join("\n");
  const actual = [
    "| A | B |",
    "| --- | --- |",
    "| D | C |"
  ].join("\n");

  const comparison = compareTableCellAdjacency(expected, actual);

  assert.equal(comparison.score, 0.25);
  assert.equal(comparison.matchedPairs, 1);
  assert.equal(comparison.expectedPairs, 4);
  assert.deepEqual(
    comparison.missing.map(({ direction, from, to }) => ({ direction, from, to })),
    [
      { direction: "right", from: "C", to: "D" },
      { direction: "down", from: "A", to: "C" },
      { direction: "down", from: "B", to: "D" }
    ]
  );
});
