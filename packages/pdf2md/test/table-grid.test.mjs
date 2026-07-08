import assert from "node:assert/strict";
import test from "node:test";
import {
  assignTextLinesToGridCells,
  detectTableCellSpans,
  inferRulingGrids
} from "../src/table-grid.mjs";

test("inferRulingGrids infers rows and columns from a complete ruled table", () => {
  const lines = [
    horizontal(72, 610, 432, 610),
    horizontal(72, 640, 432, 640),
    horizontal(72, 670, 432, 670),
    horizontal(72, 700, 432, 700),
    vertical(72, 610, 72, 700),
    vertical(192, 610, 192, 700),
    vertical(312, 610, 312, 700),
    vertical(432, 610, 432, 700)
  ];

  const grids = inferRulingGrids(lines);

  assert.equal(grids.length, 1);
  assert.deepEqual(grids[0], {
    type: "ruling-grid",
    pageIndex: 0,
    x1: 72,
    y1: 610,
    x2: 432,
    y2: 700,
    xEdges: [72, 192, 312, 432],
    yEdges: [610, 640, 670, 700],
    rows: 3,
    columns: 3,
    cells: 9,
    horizontalLines: 4,
    verticalLines: 4,
    intersections: 16,
    expectedIntersections: 16,
    complete: true,
    source: "ruling-lines"
  });
});

test("inferRulingGrids ignores single rectangles that cannot form a table grid", () => {
  const grids = inferRulingGrids([
    horizontal(10, 10, 110, 10),
    horizontal(10, 60, 110, 60),
    vertical(10, 10, 10, 60),
    vertical(110, 10, 110, 60)
  ]);

  assert.deepEqual(grids, []);
});

test("inferRulingGrids accepts one-row multi-column ruled tables", () => {
  const grids = inferRulingGrids([
    horizontal(10, 10, 210, 10),
    horizontal(10, 60, 210, 60),
    vertical(10, 10, 10, 60),
    vertical(150, 10, 150, 60),
    vertical(210, 10, 210, 60)
  ]);

  assert.equal(grids.length, 1);
  assert.equal(grids[0].rows, 1);
  assert.equal(grids[0].columns, 2);
  assert.equal(grids[0].complete, true);
});

test("inferRulingGrids marks grids incomplete when inferred crossings are missing", () => {
  const lines = [
    horizontal(72, 610, 432, 610),
    horizontal(72, 640, 432, 640),
    horizontal(72, 670, 432, 670),
    horizontal(72, 700, 432, 700),
    vertical(72, 610, 72, 700),
    vertical(192, 610, 192, 700),
    vertical(312, 610, 312, 660),
    vertical(432, 610, 432, 700)
  ];

  const grids = inferRulingGrids(lines);

  assert.equal(grids.length, 1);
  assert.equal(grids[0].rows, 3);
  assert.equal(grids[0].columns, 3);
  assert.equal(grids[0].intersections, 14);
  assert.equal(grids[0].expectedIntersections, 16);
  assert.equal(grids[0].complete, false);
});

test("assignTextLinesToGridCells assigns text boxes to cells in visual row order", () => {
  const [grid] = inferRulingGrids([
    horizontal(72, 610, 432, 610),
    horizontal(72, 640, 432, 640),
    horizontal(72, 670, 432, 670),
    horizontal(72, 700, 432, 700),
    vertical(72, 610, 72, 700),
    vertical(192, 610, 192, 700),
    vertical(312, 610, 312, 700),
    vertical(432, 610, 432, 700)
  ]);
  const [table] = assignTextLinesToGridCells(
    [grid],
    [
      textLine("Visible Table", 72, 720, 143, 22),
      textLine("Quarter", 82, 680, 38.5, 11),
      textLine("Revenue", 202, 680, 38.5, 11),
      textLine("Cost", 322, 680, 22, 11),
      textLine("Q1", 82, 650, 11, 11),
      textLine("100", 202, 650, 16.5, 11),
      textLine("50", 322, 650, 11, 11),
      textLine("Q2", 82, 620, 11, 11),
      textLine("120", 202, 620, 16.5, 11),
      textLine("60", 322, 620, 11, 11)
    ]
  );

  assert.equal(table.rows, 3);
  assert.equal(table.columns, 3);
  assert.equal(table.assignedTextLines, 9);
  assert.equal(table.nonEmptyCells, 9);
  assert.deepEqual(
    table.cells
      .filter((cell) => cell.text)
      .map((cell) => [cell.rowIndex, cell.columnIndex, cell.text]),
    [
      [0, 0, "Quarter"],
      [0, 1, "Revenue"],
      [0, 2, "Cost"],
      [1, 0, "Q1"],
      [1, 1, "100"],
      [1, 2, "50"],
      [2, 0, "Q2"],
      [2, 1, "120"],
      [2, 2, "60"]
    ]
  );
});

test("detectTableCellSpans detects column spans from missing vertical boundaries", () => {
  const lines = [
    horizontal(0, 0, 100, 0),
    horizontal(0, 50, 100, 50),
    horizontal(0, 100, 100, 100),
    vertical(0, 0, 0, 100),
    vertical(50, 0, 50, 50),
    vertical(100, 0, 100, 100)
  ];
  const [grid] = inferRulingGrids(lines);
  const [assignedTable] = assignTextLinesToGridCells(
    [grid],
    [
      textLine("Merged header", 10, 78, 70, 11),
      textLine("A1", 10, 20, 10, 11),
      textLine("B1", 60, 20, 10, 11)
    ]
  );
  const [table] = detectTableCellSpans([assignedTable], lines);
  const headerCell = table.cells.find((cell) => cell.rowIndex === 0 && cell.columnIndex === 0);
  const coveredCell = table.cells.find((cell) => cell.rowIndex === 0 && cell.columnIndex === 1);

  assert.equal(table.columnSpans, 1);
  assert.equal(table.rowSpans, 0);
  assert.equal(table.coveredCells, 1);
  assert.equal(headerCell.text, "Merged header");
  assert.equal(headerCell.columnSpan, 2);
  assert.equal(headerCell.rowSpan, 1);
  assert.deepEqual(coveredCell.coveredBy, { rowIndex: 0, columnIndex: 0 });
});

test("detectTableCellSpans detects row spans from missing horizontal boundaries", () => {
  const lines = [
    horizontal(0, 0, 100, 0),
    horizontal(50, 50, 100, 50),
    horizontal(0, 100, 100, 100),
    vertical(0, 0, 0, 100),
    vertical(50, 0, 50, 100),
    vertical(100, 0, 100, 100)
  ];
  const [grid] = inferRulingGrids(lines);
  const [assignedTable] = assignTextLinesToGridCells(
    [grid],
    [
      textLine("Merged row", 10, 72, 25, 11),
      textLine("Top right", 60, 72, 30, 11),
      textLine("Bottom right", 60, 20, 30, 11)
    ]
  );
  const [table] = detectTableCellSpans([assignedTable], lines);
  const rowSpanCell = table.cells.find((cell) => cell.rowIndex === 0 && cell.columnIndex === 0);
  const coveredCell = table.cells.find((cell) => cell.rowIndex === 1 && cell.columnIndex === 0);

  assert.equal(table.rowSpans, 1);
  assert.equal(table.columnSpans, 0);
  assert.equal(table.coveredCells, 1);
  assert.equal(rowSpanCell.text, "Merged row");
  assert.equal(rowSpanCell.rowSpan, 2);
  assert.equal(rowSpanCell.columnSpan, 1);
  assert.deepEqual(coveredCell.coveredBy, { rowIndex: 0, columnIndex: 0 });
});

function horizontal(x1, y1, x2, y2) {
  return rulingLine("horizontal", x1, y1, x2, y2);
}

function vertical(x1, y1, x2, y2) {
  return rulingLine("vertical", x1, y1, x2, y2);
}

function rulingLine(orientation, x1, y1, x2, y2) {
  return {
    type: "ruling-line",
    orientation,
    x1,
    y1,
    x2,
    y2,
    width: 1,
    segmentCount: 1,
    pageIndex: 0,
    streamIndex: 0,
    source: "path-operator"
  };
}

function textLine(text, x, y, width, height) {
  return {
    text,
    x,
    y,
    width,
    height,
    pageIndex: 0
  };
}
