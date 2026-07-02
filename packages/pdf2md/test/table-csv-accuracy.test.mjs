import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTableCsvCellTextAccuracy,
  extractTableCsvCells
} from "../../../scripts/qa/table-csv-accuracy.mjs";

test("extractTableCsvCells reads quoted CSV sidecar cells", () => {
  assert.deepEqual(
    extractTableCsvCells([
      {
        kind: "table-csv",
        tableIndex: 0,
        content: "Name,Note\nAlpha,\"A, B\"\nBeta,\"He said \"\"yes\"\"\"\n"
      }
    ]),
    [
      { tableIndex: 0, rowIndex: 0, columnIndex: 0, text: "Name" },
      { tableIndex: 0, rowIndex: 0, columnIndex: 1, text: "Note" },
      { tableIndex: 0, rowIndex: 1, columnIndex: 0, text: "Alpha" },
      { tableIndex: 0, rowIndex: 1, columnIndex: 1, text: "A, B" },
      { tableIndex: 0, rowIndex: 2, columnIndex: 0, text: "Beta" },
      { tableIndex: 0, rowIndex: 2, columnIndex: 1, text: "He said \"yes\"" }
    ]
  );
});

test("compareTableCsvCellTextAccuracy reports perfect accuracy for matching sidecars", () => {
  const expected = [
    "| Quarter | Revenue | Cost |",
    "| --- | ---: | ---: |",
    "| Q1 | 100 | 50 |",
    "| Q2 | 120 | 60 |"
  ].join("\n");
  const assets = [
    {
      kind: "table-csv",
      tableIndex: 0,
      content: "Quarter,Revenue,Cost\nQ1,100,50\nQ2,120,60\n"
    }
  ];

  assert.deepEqual(compareTableCsvCellTextAccuracy(expected, assets), {
    score: 1,
    precision: 1,
    recall: 1,
    matchedCells: 9,
    expectedCells: 9,
    actualCells: 9,
    csvAssets: 1,
    missing: []
  });
});

test("compareTableCsvCellTextAccuracy penalizes incorrect cell text", () => {
  const expected = [
    "| Quarter | Revenue | Cost |",
    "| --- | ---: | ---: |",
    "| Q1 | 100 | 50 |"
  ].join("\n");
  const assets = [
    {
      kind: "table-csv",
      tableIndex: 0,
      content: "Quarter,Revenue,Cost\nQ1,999,50\n"
    }
  ];
  const comparison = compareTableCsvCellTextAccuracy(expected, assets);

  assert.equal(comparison.score, 0.833);
  assert.equal(comparison.matchedCells, 5);
  assert.equal(comparison.expectedCells, 6);
  assert.deepEqual(
    comparison.missing.map(({ text, rowIndex, columnIndex }) => ({ text, rowIndex, columnIndex })),
    [{ text: "100", rowIndex: 1, columnIndex: 1 }]
  );
});
