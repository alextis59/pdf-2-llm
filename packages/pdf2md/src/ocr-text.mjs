const routedOcrSourceTypes = new Set(["scanned", "hybrid"]);

export function createOcrTextExtraction({
  adapter = null,
  options = {},
  pages = [],
  rasterPlan = null,
  scanDetection = null
} = {}) {
  const scanPagesByIndex = new Map((scanDetection?.pages ?? []).map((page) => [page.pageIndex, page]));
  const pagesByIndex = new Map(pages.map((page) => [page.pageIndex, page]));
  const rasterPagesByIndex = new Map((rasterPlan?.pages ?? []).map((page) => [page.pageIndex, page]));
  const routedPages = pages
    .map((page) => ({
      page,
      scanPage: scanPagesByIndex.get(page.pageIndex) ?? null
    }))
    .filter(({ scanPage }) => routedOcrSourceTypes.has(scanPage?.sourceType));
  const resultPages = normalizeResultPages(options.results);
  const resultPagesByIndex = new Map(resultPages.map((result) => [result.pageIndex, result]));
  const lines = [];
  const diagnosticsPages = [];

  if (adapter?.enabled === false) {
    return createExtractionResult({
      diagnostics: createTextBoxDiagnostics({
        averageConfidence: null,
        completedPages: 0,
        enabled: false,
        pages: [],
        routedPages: routedPages.length,
        source: resultPages.length > 0 ? "options.ocr.results" : "none",
        status: "disabled",
        totalBoxes: 0
      }),
      lines
    });
  }

  if (adapter?.status === "unsupported") {
    return createExtractionResult({
      diagnostics: createTextBoxDiagnostics({
        averageConfidence: null,
        completedPages: 0,
        enabled: true,
        pages: [],
        routedPages: routedPages.length,
        source: resultPages.length > 0 ? "options.ocr.results" : "none",
        status: "unsupported",
        totalBoxes: 0
      }),
      lines
    });
  }

  for (const { page, scanPage } of routedPages) {
    const resultPage = resultPagesByIndex.get(page.pageIndex) ?? null;
    if (!resultPage) {
      diagnosticsPages.push({
        pageIndex: page.pageIndex,
        sourceType: scanPage.sourceType,
        status: "pending",
        coordinateSpace: null,
        language: null,
        boxes: 0,
        averageConfidence: null
      });
      continue;
    }

    const pageLines = normalizePageResult(resultPage, {
      page: pagesByIndex.get(page.pageIndex) ?? page,
      rasterPage: rasterPagesByIndex.get(page.pageIndex) ?? null
    });
    lines.push(...pageLines);
    diagnosticsPages.push({
      pageIndex: page.pageIndex,
      sourceType: scanPage.sourceType,
      status: pageLines.length > 0 ? "completed" : "empty",
      coordinateSpace: resultPage.coordinateSpace,
      language: resultPage.language,
      boxes: pageLines.length,
      averageConfidence: averageConfidence(pageLines)
    });
  }

  const status = textBoxStatus({
    routedPages: routedPages.length,
    resultPages: resultPages.length,
    diagnosticsPages
  });

  return createExtractionResult({
    diagnostics: createTextBoxDiagnostics({
      averageConfidence: averageConfidence(lines),
      completedPages: diagnosticsPages.filter((page) => page.status === "completed" || page.status === "empty")
        .length,
      enabled: adapter?.enabled !== false,
      pages: diagnosticsPages,
      routedPages: routedPages.length,
      source: resultPages.length > 0 ? "options.ocr.results" : "none",
      status,
      totalBoxes: lines.length
    }),
    lines
  });
}

function createExtractionResult({ diagnostics, lines }) {
  const elementsByPage = new Map();
  for (const line of lines) {
    const element = createTextElement(line);
    const pageElements = elementsByPage.get(line.pageIndex) ?? [];
    pageElements.push(element);
    elementsByPage.set(line.pageIndex, pageElements);
  }

  return {
    diagnostics,
    lines,
    elementsByPage
  };
}

function createTextBoxDiagnostics({
  averageConfidence,
  completedPages,
  enabled,
  pages,
  routedPages,
  source,
  status,
  totalBoxes
}) {
  return {
    enabled,
    status,
    source,
    routedPages,
    completedPages,
    totalBoxes,
    averageConfidence,
    pages
  };
}

function textBoxStatus({ routedPages, resultPages, diagnosticsPages }) {
  if (routedPages === 0) {
    return "no-routed-pages";
  }
  if (resultPages === 0) {
    return "pending";
  }
  if (diagnosticsPages.every((page) => page.status === "completed" || page.status === "empty")) {
    return "completed";
  }
  return diagnosticsPages.some((page) => page.status === "completed" || page.status === "empty")
    ? "partial"
    : "pending";
}

function normalizeResultPages(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .filter((result) => result && Number.isInteger(result.pageIndex))
    .map((result) => ({
      pageIndex: result.pageIndex,
      language: typeof result.language === "string" && result.language.trim() ? result.language.trim() : null,
      coordinateSpace: result.coordinateSpace === "raster" ? "raster" : "page",
      widthPx: finiteNumber(result.widthPx ?? result.imageWidth ?? result.width),
      heightPx: finiteNumber(result.heightPx ?? result.imageHeight ?? result.height),
      boxes: sourceBoxes(result)
    }));
}

function sourceBoxes(result) {
  if (Array.isArray(result.boxes)) {
    return result.boxes;
  }
  if (Array.isArray(result.lines)) {
    return result.lines;
  }
  if (Array.isArray(result.words)) {
    return result.words;
  }
  return [];
}

function normalizePageResult(resultPage, { page, rasterPage }) {
  return resultPage.boxes
    .map((box) => normalizeTextBox(box, resultPage, { page, rasterPage }))
    .filter(Boolean);
}

function normalizeTextBox(box, resultPage, { page, rasterPage }) {
  if (!box || typeof box.text !== "string" || box.text.trim().length === 0) {
    return null;
  }

  const rawBox = readBox(box);
  if (!rawBox) {
    return null;
  }

  const coordinates =
    resultPage.coordinateSpace === "raster"
      ? rasterBoxToPageBox(rawBox, resultPage, { page, rasterPage })
      : pageBox(rawBox);
  if (!coordinates) {
    return null;
  }

  const confidence = normalizeConfidence(box.confidence);
  const text = box.text.trim();
  const span = {
    text,
    x: coordinates.x,
    y: coordinates.y,
    width: coordinates.width,
    height: coordinates.height,
    direction: normalizeDirection(box.direction),
    confidence,
    source: "ocr"
  };

  return {
    text,
    fontName: null,
    fontSize: coordinates.height,
    x: coordinates.x,
    y: coordinates.y,
    width: coordinates.width,
    height: coordinates.height,
    spans: [span],
    glyphs: [],
    pageIndex: resultPage.pageIndex,
    source: "ocr",
    confidence,
    direction: span.direction,
    language: resultPage.language,
    coordinateSpace: resultPage.coordinateSpace
  };
}

function readBox(box) {
  const source = box.bbox && typeof box.bbox === "object" ? box.bbox : box;
  const x = finiteNumber(source.x ?? source.left ?? source.x0);
  const y = finiteNumber(source.y ?? source.top ?? source.y0);
  const right = finiteNumber(source.x1 ?? source.right);
  const bottom = finiteNumber(source.y1 ?? source.bottom);
  const width = finiteNumber(source.width) ?? (right !== null && x !== null ? right - x : null);
  const height = finiteNumber(source.height) ?? (bottom !== null && y !== null ? bottom - y : null);

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

function pageBox(box) {
  return normalizeBox(box);
}

function rasterBoxToPageBox(box, resultPage, { page, rasterPage }) {
  const widthPx = resultPage.widthPx ?? rasterPage?.widthPx ?? null;
  const heightPx = resultPage.heightPx ?? rasterPage?.heightPx ?? null;
  const widthPt = finiteNumber(page?.widthPt ?? rasterPage?.widthPt);
  const heightPt = finiteNumber(page?.heightPt ?? rasterPage?.heightPt);
  if (![widthPx, heightPx, widthPt, heightPt].every(Number.isFinite)) {
    return null;
  }

  const scaleX = widthPt / widthPx;
  const scaleY = heightPt / heightPx;
  return normalizeBox({
    x: box.x * scaleX,
    y: heightPt - (box.y + box.height) * scaleY,
    width: box.width * scaleX,
    height: box.height * scaleY
  });
}

function createTextElement(line) {
  return {
    type: "text",
    spans: line.spans.map((span) => ({ ...span }))
  };
}

function averageConfidence(lines) {
  if (lines.length === 0) {
    return null;
  }
  const total = lines.reduce((sum, line) => sum + line.confidence, 0);
  return normalizeNumber(total / lines.length);
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    return 0;
  }
  const normalized = confidence > 1 ? confidence / 100 : confidence;
  return normalizeNumber(Math.min(Math.max(normalized, 0), 1));
}

function normalizeDirection(value) {
  return value === "rtl" || value === "vertical" || value === "unknown" ? value : "ltr";
}

function normalizeBox(box) {
  return {
    x: normalizeNumber(box.x),
    y: normalizeNumber(box.y),
    width: normalizeNumber(box.width),
    height: normalizeNumber(box.height)
  };
}

function normalizeNumber(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
