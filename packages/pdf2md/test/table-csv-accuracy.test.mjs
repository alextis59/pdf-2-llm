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

test("compareTableCsvCellTextAccuracy decodes formula protection for logical comparison", () => {
  const expected = [
    "| A | B | C | D |",
    "| --- | --- | --- | --- |",
    "| =SUM(1,2) | +CMD | -2% | @LINK |"
  ].join("\n");
  const assets = [
    {
      kind: "table-csv",
      tableIndex: 0,
      content: `A,B,C,D\n"'=SUM(1,2)",'+CMD,'-2%,'@LINK\n`
    }
  ];

  assert.equal(extractTableCsvCells(assets)[4].text, "'=SUM(1,2)");
  assert.equal(compareTableCsvCellTextAccuracy(expected, assets).score, 1);
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

test("compareTableCsvCellTextAccuracy ignores empty span placeholders in sidecars", () => {
  const expected = [
    "<table>",
    "<tr><th colspan=\"2\">Merged</th></tr>",
    "<tr><td>A</td><td>B</td></tr>",
    "</table>"
  ].join("");
  const comparison = compareTableCsvCellTextAccuracy(expected, [
    {
      kind: "table-csv",
      tableIndex: 0,
      content: "Merged,\nA,B\n"
    }
  ]);

  assert.equal(comparison.score, 1);
  assert.equal(comparison.matchedCells, 3);
  assert.equal(comparison.actualCells, 3);
});
