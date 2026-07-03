import assert from "node:assert/strict";
import test from "node:test";
import { createWebGpuExecutionPlan } from "../src/webgpu-provider.mjs";

test("createWebGpuExecutionPlan falls back to CPU when WebGPU is not selected", () => {
  const plan = createWebGpuExecutionPlan({
    scanDetection: {
      pages: [{ pageIndex: 0, sourceType: "scanned" }]
    },
    webgpu: {
      selectedProvider: "cpu",
      fallbackReason: "navigator-gpu-missing"
    }
  });

  assert.equal(plan.enabled, false);
  assert.equal(plan.provider, "cpu");
  assert.equal(plan.status, "cpu-fallback");
  assert.equal(plan.fallbackReason, "navigator-gpu-missing");
  assert.equal(plan.routedPages, 1);
  assert.equal(plan.plannedPages, 0);
  assert.deepEqual(plan.batches, []);
});

test("createWebGpuExecutionPlan batches routed OCR pages within pixel and memory limits", () => {
  const plan = createWebGpuExecutionPlan({
    options: {
      maxBatchPixels: 10_000,
      maxMemoryBytes: 40_000
    },
    rasterPlan: {
      pages: [
        { pageIndex: 0, status: "planned", pixelCount: 6_000 },
        { pageIndex: 1, status: "planned", pixelCount: 4_000 },
        { pageIndex: 2, status: "planned", pixelCount: 5_000 }
      ]
    },
    scanDetection: {
      pages: [
        { pageIndex: 0, sourceType: "scanned" },
        { pageIndex: 1, sourceType: "hybrid" },
        { pageIndex: 2, sourceType: "scanned" },
        { pageIndex: 3, sourceType: "digital" }
      ]
    },
    webgpu: {
      selectedProvider: "webgpu"
    }
  });

  assert.equal(plan.enabled, true);
  assert.equal(plan.provider, "webgpu");
  assert.equal(plan.status, "planned");
  assert.equal(plan.routedPages, 3);
  assert.equal(plan.plannedPages, 3);
  assert.equal(plan.totalEstimatedPixels, 15_000);
  assert.equal(plan.totalEstimatedBytes, 60_000);
  assert.deepEqual(plan.batches, [
    {
      batchIndex: 0,
      pixelCount: 10_000,
      estimatedBytes: 40_000,
      pages: [
        {
          pageIndex: 0,
          sourceType: "scanned",
          pixelCount: 6_000,
          estimatedBytes: 24_000
        },
        {
          pageIndex: 1,
          sourceType: "hybrid",
          pixelCount: 4_000,
          estimatedBytes: 16_000
        }
      ]
    },
    {
      batchIndex: 1,
      pixelCount: 5_000,
      estimatedBytes: 20_000,
      pages: [
        {
          pageIndex: 2,
          sourceType: "scanned",
          pixelCount: 5_000,
          estimatedBytes: 20_000
        }
      ]
    }
  ]);
});

test("createWebGpuExecutionPlan skips pages that exceed memory limits", () => {
  const plan = createWebGpuExecutionPlan({
    options: {
      maxMemoryBytes: 100
    },
    rasterPlan: {
      pages: [{ pageIndex: 0, status: "planned", pixelCount: 50 }]
    },
    scanDetection: {
      pages: [{ pageIndex: 0, sourceType: "scanned" }]
    },
    webgpu: {
      selectedProvider: "webgpu"
    }
  });

  assert.equal(plan.status, "skipped");
  assert.equal(plan.skippedPages, 1);
  assert.deepEqual(plan.skipped, [
    {
      pageIndex: 0,
      sourceType: "scanned",
      rasterStatus: "planned",
      pixelCount: 50,
      estimatedBytes: 200,
      status: "exceeds-memory-limit"
    }
  ]);
});
