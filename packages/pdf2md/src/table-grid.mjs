export function inferRulingGrids(rulingLines, options = {}) {
  const intersectionTolerance = options.intersectionTolerance ?? 1;
  const minRows = options.minRows ?? 2;
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
