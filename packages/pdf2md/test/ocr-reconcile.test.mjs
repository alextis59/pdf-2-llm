import assert from "node:assert/strict";
import test from "node:test";
import { reconcileOcrTextLines } from "../src/ocr-reconcile.mjs";

test("reconcileOcrTextLines selects OCR for hidden-text mismatch hybrid pages", () => {
  const pdfLine = {
    pageIndex: 0,
    text: "Hidden layer",
    x: 120,
    y: 120,
    width: 80,
    height: 12,
    hidden: true,
    source: "pdf-text"
  };
  const ocrLine = {
    pageIndex: 0,
    text: "Visible OCR",
    source: "ocr"
  };
  const result = reconcileOcrTextLines({
    pdfTextLines: [pdfLine],
    ocrTextLines: [ocrLine],
    scanDetection: {
      pages: [
        {
          pageIndex: 0,
          sourceType: "hybrid",
          imageDraws: [
            {
              x: 0,
              y: 0,
              width: 50,
              height: 50
            }
          ]
        }
      ]
    }
  });

  assert.deepEqual(result.lines, [ocrLine]);
  assert.deepEqual(result.diagnostics, {
    status: "completed",
    strategy: "page-source-selection",
    selectedPdfTextLines: 0,
    selectedOcrTextLines: 1,
    suppressedPdfTextLines: 1,
    suppressedOcrTextLines: 0,
    pages: [
      {
        pageIndex: 0,
        sourceType: "hybrid",
        selected: "ocr",
        reason: "pdf-visible-geometry-mismatch",
        pdfTextLines: 1,
        ocrTextLines: 1,
        pdfVisibleTextLines: 0,
        pdfHiddenTextLines: 1,
        pdfHiddenImageAlignedTextLines: 0,
        pdfHiddenImageUnalignedTextLines: 1,
        pdfVisibleGeometryAligned: false,
        selectedPdfTextLines: 0,
        selectedOcrTextLines: 1,
        suppressedPdfTextLines: 1,
        suppressedOcrTextLines: 0
      }
    ]
  });
});

test("reconcileOcrTextLines mixes reliable PDF regions with OCR fallback regions", () => {
  const alignedPdfLine = {
    pageIndex: 0,
    text: "Aligned hidden region",
    x: 72,
    y: 720,
    width: 140,
    height: 12,
    hidden: true,
    source: "pdf-text"
  };
  const badPdfLine = {
    pageIndex: 0,
    text: "Bad hidden region",
    x: 520,
    y: 680,
    width: 120,
    height: 12,
    hidden: true,
    source: "pdf-text"
  };
  const duplicateOcrLine = {
    pageIndex: 0,
    text: "OCR duplicate region",
    x: 72,
    y: 720,
    width: 140,
    height: 12,
    source: "ocr"
  };
  const fallbackOcrLine = {
    pageIndex: 0,
    text: "OCR fallback region",
    x: 72,
    y: 680,
    width: 140,
    height: 12,
    source: "ocr"
  };
  const result = reconcileOcrTextLines({
    pdfTextLines: [alignedPdfLine, badPdfLine],
    ocrTextLines: [duplicateOcrLine, fallbackOcrLine],
    scanDetection: {
      thresholds: {
        minHiddenTextImageOverlapRatio: 0.5
      },
      pages: [
        {
          pageIndex: 0,
          sourceType: "hybrid",
          imageDraws: [
            {
              x: 0,
              y: 0,
              width: 400,
              height: 792
            }
          ]
        }
      ]
    }
  });

  assert.deepEqual(result.lines, [alignedPdfLine, fallbackOcrLine]);
  assert.deepEqual(result.diagnostics, {
    status: "completed",
    strategy: "page-source-selection",
    selectedPdfTextLines: 1,
    selectedOcrTextLines: 1,
    suppressedPdfTextLines: 1,
    suppressedOcrTextLines: 1,
    pages: [
      {
        pageIndex: 0,
        sourceType: "hybrid",
        selected: "combined",
        reason: "hybrid-region-source-selection",
        pdfTextLines: 2,
        ocrTextLines: 2,
        pdfVisibleTextLines: 0,
        pdfHiddenTextLines: 2,
        pdfHiddenImageAlignedTextLines: 1,
        pdfHiddenImageUnalignedTextLines: 1,
        pdfVisibleGeometryAligned: false,
        selectedPdfTextLines: 1,
        selectedOcrTextLines: 1,
        suppressedPdfTextLines: 1,
        suppressedOcrTextLines: 1
      }
    ]
  });
});
