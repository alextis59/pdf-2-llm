export function inferRulingGrids(rulingLines, options = {}) {
  const intersectionTolerance = options.intersectionTolerance ?? 1;
  const minRows = options.minRows ?? 1;
  const minColumns = options.minColumns ?? 2;
  const byPage = groupByPage(rulingLines);
  const grids = [];

  for (const [pageIndex, pageLines] of byPage) {
    grids.push(
      ...inferPageRulingGrids(pageLines, {
        intersectionTolerance,
        minRows,
        minColumns,
        pageIndex
      })
    );
  }

  return grids;
}

export function assignTextLinesToGridCells(rulingGrids, textLines, options = {}) {
  const tolerance = options.cellAssignmentTolerance ?? 0.5;
  return rulingGrids.map((grid, gridIndex) => {
    const cells = createGridCells(grid);
    const byCellKey = new Map(cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell]));

    for (const line of textLines) {
      if ((line.pageIndex ?? null) !== (grid.pageIndex ?? null)) {
        continue;
      }
      const center = lineCenter(line);
      const columnIndex = intervalIndexForCoordinate(center.x, grid.xEdges, tolerance);
      const bottomRowIndex = intervalIndexForCoordinate(center.y, grid.yEdges, tolerance);
      if (columnIndex === null || bottomRowIndex === null) {
        continue;
      }
      const rowIndex = grid.rows - 1 - bottomRowIndex;
      const cell = byCellKey.get(`${rowIndex}:${columnIndex}`);
      if (cell) {
        cell.lines.push(line);
      }
    }

    for (const cell of cells) {
      updateCellText(cell);
    }

    const nonEmptyCells = cells.filter((cell) => cell.lineCount > 0);
    return {
      type: "ruling-table-cells",
      pageIndex: grid.pageIndex,
      gridIndex,
      rows: grid.rows,
      columns: grid.columns,
      xEdges: grid.xEdges,
      yEdges: grid.yEdges,
      cellCount: grid.cells,
      assignedTextLines: nonEmptyCells.reduce((sum, cell) => sum + cell.lineCount, 0),
      nonEmptyCells: nonEmptyCells.length,
      cells,
      source: "ruling-grid"
    };
  });
}

export function detectTableCellSpans(rulingTables, rulingLines, options = {}) {
  const tolerance = options.spanDetectionTolerance ?? 1;
  return rulingTables.map((table) => {
    const tableRulingLines = rulingLines.filter((line) => lineBelongsToTable(line, table, tolerance));
    const cells = table.cells.map((cell) => ({
      ...cell,
      lines: [...cell.lines],
      rowSpan: 1,
      columnSpan: 1,
      coveredBy: null
    }));
    const byCellKey = new Map(cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell]));

    for (let rowIndex = 0; rowIndex < table.rows; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < table.columns; columnIndex += 1) {
        const cell = byCellKey.get(`${rowIndex}:${columnIndex}`);
        if (!cell || cell.coveredBy) {
          continue;
        }

        let columnSpan = 1;
        while (
          columnIndex + columnSpan < table.columns &&
          !verticalBoundaryPresent(table, tableRulingLines, columnIndex + columnSpan, rowIndex, tolerance)
        ) {
          columnSpan += 1;
        }

        let rowSpan = 1;
        while (
          rowIndex + rowSpan < table.rows &&
          !horizontalBoundaryPresent(
            table,
            tableRulingLines,
            rowIndex + rowSpan,
            columnIndex,
            columnIndex + columnSpan,
            tolerance
          )
        ) {
          rowSpan += 1;
        }

        cell.rowSpan = rowSpan;
        cell.columnSpan = columnSpan;
        mergeCoveredCellsIntoOrigin(cell, byCellKey, rowSpan, columnSpan);
      }
    }

    for (const cell of cells) {
      updateCellText(cell);
    }

    const rowSpans = cells.filter((cell) => !cell.coveredBy && cell.rowSpan > 1).length;
    const columnSpans = cells.filter((cell) => !cell.coveredBy && cell.columnSpan > 1).length;
    const coveredCells = cells.filter((cell) => cell.coveredBy).length;
    const assignedTextLines = cells.reduce((sum, cell) => sum + cell.lineCount, 0);
    const nonEmptyCells = cells.filter((cell) => !cell.coveredBy && cell.lineCount > 0).length;

    return {
      ...table,
      assignedTextLines,
      nonEmptyCells,
      rowSpans,
      columnSpans,
      coveredCells,
      hasSpans: rowSpans > 0 || columnSpans > 0,
      cells
    };
  });
}

function inferPageRulingGrids(pageLines, options) {
  const horizontalLines = pageLines.filter((line) => line.orientation === "horizontal");
  const verticalLines = pageLines.filter((line) => line.orientation === "vertical");
  if (horizontalLines.length < options.minRows + 1 || verticalLines.length < options.minColumns + 1) {
    return [];
  }

  const items = [
    ...horizontalLines.map((line) => ({ line, orientation: "horizontal" })),
    ...verticalLines.map((line) => ({ line, orientation: "vertical" }))
  ];
  const parents = items.map((_, index) => index);

  for (let horizontalIndex = 0; horizontalIndex < horizontalLines.length; horizontalIndex += 1) {
    for (let verticalIndex = 0; verticalIndex < verticalLines.length; verticalIndex += 1) {
      if (
        lineIntersects(
          horizontalLines[horizontalIndex],
          verticalLines[verticalIndex],
          options.intersectionTolerance
        )
      ) {
        union(parents, horizontalIndex, horizontalLines.length + verticalIndex);
      }
    }
  }

  const components = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const root = findRoot(parents, index);
    const component = components.get(root) ?? [];
    component.push(items[index]);
    components.set(root, component);
  }

  return [...components.values()]
    .map((component) => createGridFromComponent(component, options))
    .filter(Boolean)
    .sort((left, right) => {
      if ((left.pageIndex ?? -1) !== (right.pageIndex ?? -1)) {
        return (left.pageIndex ?? -1) - (right.pageIndex ?? -1);
      }
      return right.y2 - left.y2 || left.x1 - right.x1;
    });
}

function createGridFromComponent(component, options) {
  const horizontalLines = component
    .filter((item) => item.orientation === "horizontal")
    .map((item) => item.line);
  const verticalLines = component
    .filter((item) => item.orientation === "vertical")
    .map((item) => item.line);
  const yEdges = clusterCoordinates(
    horizontalLines.map((line) => lineAxisCoordinate(line)),
    options.intersectionTolerance
  );
  const xEdges = clusterCoordinates(
    verticalLines.map((line) => lineAxisCoordinate(line)),
    options.intersectionTolerance
  );
  const rows = yEdges.length - 1;
  const columns = xEdges.length - 1;

  if (rows < options.minRows || columns < options.minColumns) {
    return null;
  }

  const intersections = countGridIntersections(horizontalLines, verticalLines, options.intersectionTolerance);
  const expectedIntersections = xEdges.length * yEdges.length;
  const complete = hasCompleteGridIntersections(
    xEdges,
    yEdges,
    horizontalLines,
    verticalLines,
    options.intersectionTolerance
  );

  return {
    type: "ruling-grid",
    pageIndex: options.pageIndex,
    x1: normalizeCoordinate(xEdges[0]),
    y1: normalizeCoordinate(yEdges[0]),
    x2: normalizeCoordinate(xEdges.at(-1)),
    y2: normalizeCoordinate(yEdges.at(-1)),
    xEdges: xEdges.map(normalizeCoordinate),
    yEdges: yEdges.map(normalizeCoordinate),
    rows,
    columns,
    cells: rows * columns,
    horizontalLines: horizontalLines.length,
    verticalLines: verticalLines.length,
    intersections,
    expectedIntersections,
    complete,
    source: "ruling-lines"
  };
}

function mergeCoveredCellsIntoOrigin(originCell, byCellKey, rowSpan, columnSpan) {
  for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
      if (rowOffset === 0 && columnOffset === 0) {
        continue;
      }
      const coveredCell = byCellKey.get(
        `${originCell.rowIndex + rowOffset}:${originCell.columnIndex + columnOffset}`
      );
      if (!coveredCell || coveredCell.coveredBy) {
        continue;
      }
      coveredCell.coveredBy = {
        rowIndex: originCell.rowIndex,
        columnIndex: originCell.columnIndex
      };
      originCell.lines.push(...coveredCell.lines);
      coveredCell.lines = [];
    }
  }
  updateCellText(originCell);
}

function createGridCells(grid) {
  const cells = [];
  for (let rowIndex = 0; rowIndex < grid.rows; rowIndex += 1) {
    const bottomRowIndex = grid.rows - 1 - rowIndex;
    for (let columnIndex = 0; columnIndex < grid.columns; columnIndex += 1) {
      cells.push({
        rowIndex,
        columnIndex,
        x1: grid.xEdges[columnIndex],
        y1: grid.yEdges[bottomRowIndex],
        x2: grid.xEdges[columnIndex + 1],
        y2: grid.yEdges[bottomRowIndex + 1],
        text: "",
        lineCount: 0,
        lines: []
      });
    }
  }
  return cells;
}

function verticalBoundaryPresent(table, rulingLines, boundaryColumnIndex, rowIndex, tolerance) {
  const x = table.xEdges[boundaryColumnIndex];
  const rowBounds = rowBoundsForVisualRow(table, rowIndex);
  return rulingLines.some(
    (line) =>
      line.orientation === "vertical" &&
      Math.abs(lineAxisCoordinate(line) - x) <= tolerance &&
      lineStart(line) <= rowBounds.y1 + tolerance &&
      lineEnd(line) >= rowBounds.y2 - tolerance
  );
}

function horizontalBoundaryPresent(
  table,
  rulingLines,
  boundaryRowIndex,
  startColumnIndex,
  endColumnIndex,
  tolerance
) {
  const y = table.yEdges[table.rows - boundaryRowIndex];
  const x1 = table.xEdges[startColumnIndex];
  const x2 = table.xEdges[endColumnIndex];
  return rulingLines.some(
    (line) =>
      line.orientation === "horizontal" &&
      Math.abs(lineAxisCoordinate(line) - y) <= tolerance &&
      lineStart(line) <= x1 + tolerance &&
      lineEnd(line) >= x2 - tolerance
  );
}

function rowBoundsForVisualRow(table, rowIndex) {
  const bottomRowIndex = table.rows - 1 - rowIndex;
  return {
    y1: table.yEdges[bottomRowIndex],
    y2: table.yEdges[bottomRowIndex + 1]
  };
}

function lineBelongsToTable(line, table, tolerance) {
  if ((line.pageIndex ?? null) !== (table.pageIndex ?? null)) {
    return false;
  }
  return (
    lineEndOnAxis(line, "x") >= table.xEdges[0] - tolerance &&
    lineStartOnAxis(line, "x") <= table.xEdges.at(-1) + tolerance &&
    lineEndOnAxis(line, "y") >= table.yEdges[0] - tolerance &&
    lineStartOnAxis(line, "y") <= table.yEdges.at(-1) + tolerance
  );
}

function lineStartOnAxis(line, axis) {
  return Math.min(line[`${axis}1`], line[`${axis}2`]);
}

function lineEndOnAxis(line, axis) {
  return Math.max(line[`${axis}1`], line[`${axis}2`]);
}

function countGridIntersections(horizontalLines, verticalLines, tolerance) {
  let count = 0;
  for (const horizontalLine of horizontalLines) {
    for (const verticalLine of verticalLines) {
      if (lineIntersects(horizontalLine, verticalLine, tolerance)) {
        count += 1;
      }
    }
  }
  return count;
}

function intervalIndexForCoordinate(coordinate, edges, tolerance) {
  for (let index = 0; index < edges.length - 1; index += 1) {
    if (coordinate >= edges[index] - tolerance && coordinate <= edges[index + 1] + tolerance) {
      return index;
    }
  }
  return null;
}

function lineCenter(line) {
  const x = Number.isFinite(line.x) ? line.x : 0;
  const y = Number.isFinite(line.y) ? line.y : 0;
  const width = Number.isFinite(line.width) ? line.width : 0;
  const height = Number.isFinite(line.height) ? line.height : 0;
  return {
    x: x + width / 2,
    y: y + height / 2
  };
}

function compareTextLinesForCell(left, right) {
  const leftCenter = lineCenter(left);
  const rightCenter = lineCenter(right);
  return rightCenter.y - leftCenter.y || leftCenter.x - rightCenter.x;
}

function updateCellText(cell) {
  cell.lines.sort(compareTextLinesForCell);
  cell.text = cell.lines.map((line) => normalizeText(line.text)).filter(Boolean).join(" ");
  cell.lineCount = cell.lines.length;
}

function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function lineIntersects(horizontalLine, verticalLine, tolerance) {
  const x = lineAxisCoordinate(verticalLine);
  const y = lineAxisCoordinate(horizontalLine);
  return (
    x >= lineStart(horizontalLine) - tolerance &&
    x <= lineEnd(horizontalLine) + tolerance &&
    y >= lineStart(verticalLine) - tolerance &&
    y <= lineEnd(verticalLine) + tolerance
  );
}

function hasCompleteGridIntersections(xEdges, yEdges, horizontalLines, verticalLines, tolerance) {
  for (const x of xEdges) {
    for (const y of yEdges) {
      const hasHorizontalCoverage = horizontalLines.some(
        (line) =>
          Math.abs(lineAxisCoordinate(line) - y) <= tolerance &&
          x >= lineStart(line) - tolerance &&
          x <= lineEnd(line) + tolerance
      );
      const hasVerticalCoverage = verticalLines.some(
        (line) =>
          Math.abs(lineAxisCoordinate(line) - x) <= tolerance &&
          y >= lineStart(line) - tolerance &&
          y <= lineEnd(line) + tolerance
      );
      if (!hasHorizontalCoverage || !hasVerticalCoverage) {
        return false;
      }
    }
  }
  return true;
}

function clusterCoordinates(coordinates, tolerance) {
  const clusters = [];
  for (const coordinate of [...coordinates].sort((left, right) => left - right)) {
    const cluster = clusters.find((item) => Math.abs(item.center - coordinate) <= tolerance);
    if (cluster) {
      cluster.values.push(coordinate);
      cluster.center = average(cluster.values);
      continue;
    }
    clusters.push({
      center: coordinate,
      values: [coordinate]
    });
  }
  return clusters.map((cluster) => cluster.center);
}

function groupByPage(lines) {
  const byPage = new Map();
  for (const line of lines) {
    const pageIndex = line.pageIndex ?? null;
    const pageLines = byPage.get(pageIndex) ?? [];
    pageLines.push(line);
    byPage.set(pageIndex, pageLines);
  }
  return byPage;
}

function union(parents, left, right) {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot !== rightRoot) {
    parents[rightRoot] = leftRoot;
  }
}

function findRoot(parents, index) {
  if (parents[index] !== index) {
    parents[index] = findRoot(parents, parents[index]);
  }
  return parents[index];
}

function lineAxisCoordinate(line) {
  return line.orientation === "horizontal" ? (line.y1 + line.y2) / 2 : (line.x1 + line.x2) / 2;
}

function lineStart(line) {
  return line.orientation === "horizontal"
    ? Math.min(line.x1, line.x2)
    : Math.min(line.y1, line.y2);
}

function lineEnd(line) {
  return line.orientation === "horizontal"
    ? Math.max(line.x1, line.x2)
    : Math.max(line.y1, line.y2);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeCoordinate(value) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}
