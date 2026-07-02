import assert from "node:assert/strict";
import test from "node:test";
import { inferRulingGrids } from "../src/table-grid.mjs";

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
