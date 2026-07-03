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
