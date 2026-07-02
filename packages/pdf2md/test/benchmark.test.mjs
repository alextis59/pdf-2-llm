import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDurations, summarizeMemory } from "../../../scripts/qa/benchmark.mjs";

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
