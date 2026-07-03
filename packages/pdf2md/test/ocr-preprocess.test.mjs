import assert from "node:assert/strict";
import test from "node:test";
import { createOcrPreprocessingPlan } from "../src/ocr-preprocess.mjs";

test("createOcrPreprocessingPlan records metadata-only preprocessing when raster is unavailable", () => {
  const plan = createOcrPreprocessingPlan({
    adapter: {
      enabled: true,
      status: "selected"
    },
    pages: [
      {
        pageIndex: 0,
        rotation: -90
      }
    ],
    scanDetection: {
      pages: [
        {
          pageIndex: 0,
          sourceType: "hybrid"
        }
      ]
    }
  });

  assert.deepEqual(plan, {
    enabled: true,
    status: "metadata-only",
    strategy: "metadata-first",
    thresholds: {
      minDeskewDegrees: 0.25,
      maxDeskewDegrees: 15
    },
    pages: [
      {
        pageIndex: 0,
        sourceType: "hybrid",
        status: "metadata-only",
        rasterStatus: "not-planned",
        pageRotationDegrees: 270,
        rotationCorrectionDegrees: 90,
        deskewDegrees: 0,
        deskewConfidence: 0,
        operations: ["normalize-page-rotation"],
        deferredOperations: ["estimate-deskew", "binarize", "denoise"]
      }
    ]
  });
});
