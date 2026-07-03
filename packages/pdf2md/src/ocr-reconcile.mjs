export function reconcileOcrTextLines({
  ocrTextLines = [],
  pdfTextLines = [],
  scanDetection = null
} = {}) {
  const pdfLinesByPage = groupByPage(pdfTextLines);
  const ocrLinesByPage = groupByPage(ocrTextLines);
  const scanPagesByIndex = new Map((scanDetection?.pages ?? []).map((page) => [page.pageIndex, page]));
  const pageIndexes = sortedPageIndexes(pdfLinesByPage, ocrLinesByPage, scanPagesByIndex);
  const pages = [];
  const lines = [];

  for (const pageIndex of pageIndexes) {
    const scanPage = scanPagesByIndex.get(pageIndex) ?? null;
    const pdfLines = pdfLinesByPage.get(pageIndex) ?? [];
    const ocrLines = ocrLinesByPage.get(pageIndex) ?? [];
    const decision = reconcilePageText({
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

function reconcilePageText({ ocrLines, pageIndex, pdfLines, scanPage }) {
  const sourceType = scanPage?.sourceType ?? inferSourceType({ ocrLines, pdfLines });
  const selected = selectPageSource({ ocrLines, pdfLines, scanPage, sourceType });
  const lines = selected === "ocr" ? ocrLines : selected === "pdf" ? pdfLines : [...pdfLines, ...ocrLines];

  return {
    diagnostics: {
      pageIndex,
      sourceType,
      selected,
      reason: selectionReason({ ocrLines, pdfLines, scanPage, selected, sourceType }),
      pdfTextLines: pdfLines.length,
      ocrTextLines: ocrLines.length,
      selectedPdfTextLines: selected === "pdf" || selected === "combined" ? pdfLines.length : 0,
      selectedOcrTextLines: selected === "ocr" || selected === "combined" ? ocrLines.length : 0,
      suppressedPdfTextLines: selected === "ocr" ? pdfLines.length : 0,
      suppressedOcrTextLines: selected === "pdf" ? ocrLines.length : 0
    },
    lines
  };
}

function selectPageSource({ ocrLines, pdfLines, scanPage, sourceType }) {
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
    if (scanPage?.hiddenTextImageMismatchLikely === true && ocrLines.length > 0) {
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

function selectionReason({ ocrLines, pdfLines, scanPage, selected, sourceType }) {
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
    if (scanPage?.hiddenTextImageMismatchLikely === true && ocrLines.length > 0) {
      return "hidden-text-image-mismatch";
    }
    if (pdfLines.length > 0) {
      return "hybrid-pdf-text-present";
    }
    return "hybrid-no-pdf-text";
  }
  return selected === "combined" ? "unknown-source-combined" : "single-source-available";
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
