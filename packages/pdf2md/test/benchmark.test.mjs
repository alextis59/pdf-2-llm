import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProviderResults,
  createMemoryProfileSummary,
  evaluateMemoryLimits,
  splitStartupAndThroughputDurations,
  summarizeDurations,
  summarizeGpuMemoryFromExecution,
  summarizePeakMemory,
  summarizeMemory
} from "../../../scripts/qa/benchmark.mjs";

test("benchmark duration summary reports min max mean and median", () => {
  assert.deepEqual(summarizeDurations([9, 1, 5, 3]), {
    minMs: 1,
    maxMs: 9,
    meanMs: 4.5,
    medianMs: 4
  });
});

test("benchmark memory summary reports deltas", () => {
  assert.deepEqual(
    summarizeMemory(
      { rss: 100, heapUsed: 10, external: 5, arrayBuffers: 3 },
      { rss: 160, heapUsed: 7, external: 8, arrayBuffers: 11 }
    ),
    {
      rssDeltaBytes: 60,
      heapUsedDeltaBytes: -3,
      externalDeltaBytes: 3,
      arrayBuffersDeltaBytes: 8
    }
  );
});

test("benchmark peak memory summary reports absolute and delta peaks", () => {
  assert.deepEqual(
    summarizePeakMemory(
      { rss: 100, heapUsed: 10, external: 5, arrayBuffers: 3 },
      [
        { rss: 120, heapUsed: 8, external: 12, arrayBuffers: 3 },
        { rss: 90, heapUsed: 16, external: 7, arrayBuffers: 20 }
      ]
    ),
    {
      rssPeakBytes: 120,
      heapUsedPeakBytes: 16,
      externalPeakBytes: 12,
      arrayBuffersPeakBytes: 20,
      rssPeakDeltaBytes: 20,
      heapUsedPeakDeltaBytes: 6
    }
  );
});

test("benchmark startup and throughput durations are tracked separately", () => {
  assert.deepEqual(splitStartupAndThroughputDurations([12, 8, 10]), {
    startupMs: 12,
    throughputDurations: [8, 10]
  });
  assert.deepEqual(splitStartupAndThroughputDurations([12]), {
    startupMs: 12,
    throughputDurations: [12]
  });
});

test("benchmark GPU memory summary reports planned WebGPU memory", () => {
  assert.deepEqual(
    summarizeGpuMemoryFromExecution({
      provider: "webgpu",
      totalEstimatedBytes: 60,
      limits: { maxMemoryBytes: 100 },
      plannedPages: 2,
      skippedPages: 1,
      batches: [{ estimatedBytes: 40 }, { estimatedBytes: 20 }]
    }),
    {
      provider: "webgpu",
      source: "webgpu-execution-plan",
      estimatedBytes: 60,
      maxBatchEstimatedBytes: 40,
      limitBytes: 100,
      plannedPages: 2,
      skippedPages: 1
    }
  );
});

test("benchmark provider comparison reports parity and speed ratio", () => {
  assert.deepEqual(
    compareProviderResults([
      {
        id: "sample",
        workload: "ocr",
        providerMode: "cpu",
        outputChars: 100,
        textLines: 2,
        warnings: [],
        pagesPerSecond: 10,
        startup: { durationMs: 20 },
        modelLoad: { durationMs: 0 },
        peakMemory: { rssPeakBytes: 100 },
        acceleration: { selectedProvider: "cpu", fallbackReason: null },
        gpuMemory: { estimatedBytes: 0 }
      },
      {
        id: "sample",
        workload: "ocr",
        providerMode: "webgpu-preferred",
        outputChars: 100,
        textLines: 2,
        warnings: [],
        pagesPerSecond: 15,
        startup: { durationMs: 18 },
        modelLoad: { durationMs: 0 },
        peakMemory: { rssPeakBytes: 120 },
        acceleration: {
          selectedProvider: "cpu",
          fallbackReason: "node-stable-gpu-path-unavailable"
        },
        gpuMemory: { estimatedBytes: 0 }
      }
    ]),
    [
      {
        id: "sample",
        workload: "ocr",
        cpuSelectedProvider: "cpu",
        webgpuSelectedProvider: "cpu",
        webgpuFallbackReason: "node-stable-gpu-path-unavailable",
        equivalentAcceptedOutput: true,
        pagesPerSecondRatio: 1.5,
        startupDeltaMs: -2,
        modelLoadDeltaMs: 0,
        rssPeakDeltaBytes: 20,
        gpuEstimatedBytes: 0
      }
    ]
  );
});

test("benchmark memory profile summarizes memory-gated long documents", () => {
  assert.deepEqual(
    createMemoryProfileSummary(
      [
        {
          id: "long-manual",
          gate: "layout-v1",
          kind: "long-document",
          features: ["long-document", "government-report"],
          workload: "conversion",
          providerMode: "cpu",
          bytes: 4000,
          iterations: 1,
          warmup: 0,
          pages: 4,
          memory: {
            rssDeltaBytes: 800,
            heapUsedDeltaBytes: 120,
            externalDeltaBytes: 40,
            arrayBuffersDeltaBytes: 8
          },
          peakMemory: {
            rssPeakBytes: 2000,
            heapUsedPeakBytes: 600,
            rssPeakDeltaBytes: 1000,
            heapUsedPeakDeltaBytes: 200
          },
          memoryLimits: {
            maxRssDeltaBytes: 1000,
            maxHeapUsedDeltaBytes: 400
          },
          memoryLimitViolations: [],
          passed: true
        },
        {
          id: "short-smoke",
          pages: 1,
          memory: { rssDeltaBytes: 50, heapUsedDeltaBytes: 10 },
          peakMemory: { rssPeakBytes: 500, heapUsedPeakBytes: 100 },
          memoryLimits: {
            maxRssDeltaBytes: null,
            maxHeapUsedDeltaBytes: null
          },
          memoryLimitViolations: [],
          passed: true
        }
      ],
      { scope: "memory-limit-gated" }
    ),
    {
      profileType: "long-memory",
      scope: "memory-limit-gated",
      resultCount: 1,
      passed: true,
      totals: {
        pages: 4,
        bytes: 4000
      },
      peaks: {
        rssDeltaBytes: 800,
        heapUsedDeltaBytes: 120,
        rssPeakBytes: 2000,
        heapUsedPeakBytes: 600,
        rssPeakDeltaBytes: 1000,
        heapUsedPeakDeltaBytes: 200
      },
      cases: [
        {
          id: "long-manual",
          gate: "layout-v1",
          kind: "long-document",
          features: ["long-document", "government-report"],
          workload: "conversion",
          providerMode: "cpu",
          pages: 4,
          bytes: 4000,
          iterations: 1,
          warmup: 0,
          rssDeltaBytes: 800,
          heapUsedDeltaBytes: 120,
          externalDeltaBytes: 40,
          arrayBuffersDeltaBytes: 8,
          rssPeakBytes: 2000,
          heapUsedPeakBytes: 600,
          rssPeakDeltaBytes: 1000,
          heapUsedPeakDeltaBytes: 200,
          rssDeltaBytesPerPage: 200,
          heapUsedDeltaBytesPerPage: 30,
          rssPeakDeltaBytesPerPage: 250,
          heapUsedPeakDeltaBytesPerPage: 50,
          limits: {
            maxRssDeltaBytes: 1000,
            maxHeapUsedDeltaBytes: 400
          },
          violations: [],
          passed: true
        }
      ]
    }
  );
});

test("benchmark memory limit evaluator reports exceeded thresholds", () => {
  assert.deepEqual(
    evaluateMemoryLimits(
      { rssDeltaBytes: 120, heapUsedDeltaBytes: 40 },
      { maxRssDeltaBytes: 100, maxHeapUsedDeltaBytes: 50 }
    ),
    [
      {
        metric: "maxRssDeltaBytes",
        actualMetric: "rssDeltaBytes",
        actual: 120,
        limit: 100
      }
    ]
  );
});

test("benchmark memory limit evaluator ignores absent thresholds", () => {
  assert.deepEqual(
    evaluateMemoryLimits(
      { rssDeltaBytes: 120, heapUsedDeltaBytes: 40 },
      { maxRssDeltaBytes: null, maxHeapUsedDeltaBytes: null }
    ),
    []
  );
});
