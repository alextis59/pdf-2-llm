import assert from "node:assert/strict";
import test from "node:test";
import { createOcrTextExtraction } from "../src/ocr-text.mjs";

test("createOcrTextExtraction maps raster OCR boxes into PDF page coordinates", () => {
  const extraction = createOcrTextExtraction({
    adapter: {
      enabled: true,
      status: "selected"
    },
    options: {
      results: [
        {
          pageIndex: 0,
          coordinateSpace: "raster",
          widthPx: 2550,
          heightPx: 3300,
          words: [
            {
              text: "Pixel box",
              confidence: 87,
              bbox: {
                x0: 300,
                y0: 200,
                x1: 900,
                y1: 260
              }
            }
          ]
        }
      ]
    },
    pages: [
      {
        pageIndex: 0,
        widthPt: 612,
        heightPt: 792
      }
    ],
    scanDetection: {
      pages: [
        {
          pageIndex: 0,
          sourceType: "scanned"
        }
      ]
    }
  });

  assert.deepEqual(extraction.diagnostics, {
    enabled: true,
    status: "completed",
    source: "options.ocr.results",
    routedPages: 1,
    completedPages: 1,
    totalBoxes: 1,
    averageConfidence: 0.87,
    pages: [
      {
        pageIndex: 0,
        sourceType: "scanned",
        status: "completed",
        coordinateSpace: "raster",
        language: null,
        boxes: 1,
        averageConfidence: 0.87
      }
    ]
  });
  assert.equal(extraction.lines.length, 1);
  assert.deepEqual(extraction.lines[0].spans[0], {
    text: "Pixel box",
    x: 72,
    y: 729.6,
    width: 144,
    height: 14.4,
    direction: "ltr",
    confidence: 0.87,
    source: "ocr"
  });
  assert.deepEqual(extraction.elementsByPage.get(0), [
    {
      type: "text",
      spans: [
        {
          text: "Pixel box",
          x: 72,
          y: 729.6,
          width: 144,
          height: 14.4,
          direction: "ltr",
          confidence: 0.87,
          source: "ocr"
        }
      ]
    }
  ]);
});
