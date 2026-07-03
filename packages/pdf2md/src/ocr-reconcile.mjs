export function reconcileOcrTextLines({
  ocrTextLines = [],
  pdfTextLines = [],
  scanDetection = null
} = {}) {
  const pdfLinesByPage = groupByPage(pdfTextLines);
  const ocrLinesByPage = groupByPage(ocrTextLines);
  const scanPagesByIndex = new Map((scanDetection?.pages ?? []).map((page) => [page.pageIndex, page]));
  const alignmentThreshold = scanDetection?.thresholds?.minHiddenTextImageOverlapRatio ?? 0.5;
  const pageIndexes = sortedPageIndexes(pdfLinesByPage, ocrLinesByPage, scanPagesByIndex);
  const pages = [];
  const lines = [];

  for (const pageIndex of pageIndexes) {
    const scanPage = scanPagesByIndex.get(pageIndex) ?? null;
    const pdfLines = pdfLinesByPage.get(pageIndex) ?? [];
    const ocrLines = ocrLinesByPage.get(pageIndex) ?? [];
    const decision = reconcilePageText({
      alignmentThreshold,
      ocrLines,
      pageIndex,
      pdfLines,
      scanPage
    });
    lines.push(...decision.lines);
    pages.push(decision.diagnostics);
  }

  return {
    diagnostics: {
      status: pages.length === 0 ? "no-pages" : "completed",
      strategy: "page-source-selection",
      selectedPdfTextLines: pages.reduce((total, page) => total + page.selectedPdfTextLines, 0),
      selectedOcrTextLines: pages.reduce((total, page) => total + page.selectedOcrTextLines, 0),
      suppressedPdfTextLines: pages.reduce((total, page) => total + page.suppressedPdfTextLines, 0),
      suppressedOcrTextLines: pages.reduce((total, page) => total + page.suppressedOcrTextLines, 0),
      pages
    },
    lines
  };
}

function reconcilePageText({ alignmentThreshold, ocrLines, pageIndex, pdfLines, scanPage }) {
  const sourceType = scanPage?.sourceType ?? inferSourceType({ ocrLines, pdfLines });
  const pdfGeometry = pdfTextGeometry({ alignmentThreshold, pdfLines, scanPage });
  const selection = selectTextLines({
    alignmentThreshold,
    ocrLines,
    pdfGeometry,
    pdfLines,
    scanPage,
    sourceType
  });

  return {
    diagnostics: {
      pageIndex,
      sourceType,
      selected: selection.selected,
      reason: selection.reason,
      pdfTextLines: pdfLines.length,
      ocrTextLines: ocrLines.length,
      pdfVisibleTextLines: pdfGeometry.visibleTextLines,
      pdfHiddenTextLines: pdfGeometry.hiddenTextLines,
      pdfHiddenImageAlignedTextLines: pdfGeometry.hiddenImageAlignedTextLines,
      pdfHiddenImageUnalignedTextLines: pdfGeometry.hiddenImageUnalignedTextLines,
      pdfVisibleGeometryAligned: pdfGeometry.visibleGeometryAligned,
      selectedPdfTextLines: selection.selectedPdfLines.length,
      selectedOcrTextLines: selection.selectedOcrLines.length,
      suppressedPdfTextLines: pdfLines.length - selection.selectedPdfLines.length,
      suppressedOcrTextLines: ocrLines.length - selection.selectedOcrLines.length
    },
    lines: selection.lines
  };
}

function selectTextLines({ alignmentThreshold, ocrLines, pdfGeometry, pdfLines, scanPage, sourceType }) {
  const regionalSelection = selectHybridRegionText({
    alignmentThreshold,
    ocrLines,
    pdfLines,
    scanPage,
    sourceType
  });
  if (regionalSelection) {
    return regionalSelection;
  }

  const selected = selectPageSource({ ocrLines, pdfGeometry, pdfLines, sourceType });
  const selectedPdfLines = selected === "pdf" || selected === "combined" ? pdfLines : [];
  const selectedOcrLines = selected === "ocr" || selected === "combined" ? ocrLines : [];
  return {
    selected,
    reason: selectionReason({ ocrLines, pdfGeometry, pdfLines, selected, sourceType }),
    selectedPdfLines,
    selectedOcrLines,
    lines: [...selectedPdfLines, ...selectedOcrLines]
  };
}

function selectHybridRegionText({ alignmentThreshold, ocrLines, pdfLines, scanPage, sourceType }) {
  if (sourceType !== "hybrid" || pdfLines.length === 0 || ocrLines.length === 0) {
    return null;
  }

  const reliablePdfLines = pdfLines.filter((line) =>
    isReliableHybridPdfLine(line, scanPage, alignmentThreshold)
  );
  if (reliablePdfLines.length === 0 || reliablePdfLines.length === pdfLines.length) {
    return null;
  }

  const selectedOcrLines = ocrLines.filter(
    (line) => maxLineOverlapRatio(line, reliablePdfLines) < alignmentThreshold
  );
  if (selectedOcrLines.length === 0) {
    return null;
  }

  return {
    selected: "combined",
    reason: "hybrid-region-source-selection",
    selectedPdfLines: reliablePdfLines,
    selectedOcrLines,
    lines: [...reliablePdfLines, ...selectedOcrLines]
  };
}

function selectPageSource({ ocrLines, pdfGeometry, pdfLines, sourceType }) {
  if (pdfLines.length === 0 && ocrLines.length === 0) {
    return "none";
  }
  if (sourceType === "scanned") {
    return ocrLines.length > 0 ? "ocr" : "pdf";
  }
  if (sourceType === "digital") {
    return pdfLines.length > 0 ? "pdf" : "ocr";
  }
  if (sourceType === "hybrid") {
    if (pdfLines.length > 0 && !pdfGeometry.visibleGeometryAligned && ocrLines.length > 0) {
      return "ocr";
    }
    if (pdfLines.length > 0) {
      return "pdf";
    }
    return ocrLines.length > 0 ? "ocr" : "none";
  }
  if (pdfLines.length > 0 && ocrLines.length > 0) {
    return "combined";
  }
  return pdfLines.length > 0 ? "pdf" : "ocr";
}

function selectionReason({ ocrLines, pdfGeometry, pdfLines, selected, sourceType }) {
  if (selected === "none") {
    return "no-text";
  }
  if (sourceType === "scanned") {
    return selected === "ocr" ? "scanned-page-ocr" : "scanned-page-no-ocr";
  }
  if (sourceType === "digital") {
    return selected === "pdf" ? "digital-page-pdf" : "digital-page-no-pdf";
  }
  if (sourceType === "hybrid") {
    if (pdfLines.length > 0 && !pdfGeometry.visibleGeometryAligned && ocrLines.length > 0) {
      return "pdf-visible-geometry-mismatch";
    }
    if (pdfLines.length > 0 && pdfGeometry.visibleGeometryAligned) {
      return "pdf-visible-geometry-aligned";
    }
    if (pdfLines.length > 0) {
      return "hybrid-pdf-text-fallback";
    }
    return "hybrid-no-pdf-text";
  }
  return selected === "combined" ? "unknown-source-combined" : "single-source-available";
}

function pdfTextGeometry({ alignmentThreshold, pdfLines, scanPage }) {
  const hiddenLines = pdfLines.filter(isHiddenTextLine);
  const visibleLines = pdfLines.filter((line) => !isHiddenTextLine(line));
  const imageDraws = scanPage?.imageDraws ?? [];
  const hiddenImageAlignedTextLines = hiddenLines.filter(
    (line) => maxImageOverlapRatio(line, imageDraws) >= alignmentThreshold
  ).length;
  const hiddenImageUnalignedTextLines = hiddenLines.length - hiddenImageAlignedTextLines;
  const visibleGeometryAligned =
    pdfLines.length > 0 &&
    hiddenImageUnalignedTextLines === 0 &&
    (visibleLines.length > 0 || hiddenImageAlignedTextLines === hiddenLines.length);

  return {
    visibleTextLines: visibleLines.length,
    hiddenTextLines: hiddenLines.length,
    hiddenImageAlignedTextLines,
    hiddenImageUnalignedTextLines,
    visibleGeometryAligned
  };
}

function isHiddenTextLine(line) {
  if (line.hidden === true || line.textRenderMode === 3) {
    return true;
  }
  return (line.spans ?? []).some((span) => span.hidden === true || span.textRenderMode === 3);
}

function isReliableHybridPdfLine(line, scanPage, alignmentThreshold) {
  if (!isHiddenTextLine(line)) {
    return true;
  }
  return maxImageOverlapRatio(line, scanPage?.imageDraws ?? []) >= alignmentThreshold;
}

function maxImageOverlapRatio(line, imageDraws) {
  const lineBox = lineBoundingBox(line);
  if (!lineBox || imageDraws.length === 0) {
    return 0;
  }
  const lineArea = lineBox.width * lineBox.height;
  if (lineArea <= 0) {
    return 0;
  }

  const maxOverlapArea = imageDraws.reduce(
    (max, image) => Math.max(max, rectangleOverlapArea(lineBox, image)),
    0
  );
  return maxOverlapArea / lineArea;
}

function maxLineOverlapRatio(line, otherLines) {
  const lineBox = lineBoundingBox(line);
  if (!lineBox || otherLines.length === 0) {
    return 0;
  }
  const lineArea = lineBox.width * lineBox.height;
  if (lineArea <= 0) {
    return 0;
  }

  const maxOverlapArea = otherLines.reduce((max, otherLine) => {
    const otherBox = lineBoundingBox(otherLine);
    return otherBox ? Math.max(max, rectangleOverlapArea(lineBox, otherBox)) : max;
  }, 0);
  return maxOverlapArea / lineArea;
}

function lineBoundingBox(line) {
  const x = finiteNumber(line.x);
  const y = finiteNumber(line.y);
  const width = finiteNumber(line.width);
  const height = finiteNumber(line.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function rectangleOverlapArea(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return width * height;
}

function groupByPage(lines) {
  const pages = new Map();
  for (const line of lines) {
    const pageIndex = Number.isInteger(line.pageIndex) ? line.pageIndex : null;
    const pageLines = pages.get(pageIndex) ?? [];
    pageLines.push(line);
    pages.set(pageIndex, pageLines);
  }
  return pages;
}

function sortedPageIndexes(...pageMaps) {
  const indexes = new Set();
  for (const pageMap of pageMaps) {
    for (const pageIndex of pageMap.keys()) {
      indexes.add(pageIndex);
    }
  }
  return [...indexes].sort((left, right) => {
    if (left === null) {
      return 1;
    }
    if (right === null) {
      return -1;
    }
    return left - right;
  });
}

function inferSourceType({ ocrLines, pdfLines }) {
  if (pdfLines.length > 0 && ocrLines.length > 0) {
    return "hybrid";
  }
  if (ocrLines.length > 0) {
    return "scanned";
  }
  if (pdfLines.length > 0) {
    return "digital";
  }
  return "unknown";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
