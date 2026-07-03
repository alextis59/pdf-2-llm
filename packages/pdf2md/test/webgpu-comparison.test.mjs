import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWebGpuComparisonReport } from "../../../scripts/qa/check-webgpu-comparison.mjs";

test("evaluateWebGpuComparisonReport passes parity and skips speedup when WebGPU falls back", () => {
  assert.deepEqual(
    evaluateWebGpuComparisonReport({
      comparisons: [
        {
          id: "scan",
          equivalentAcceptedOutput: true,
          webgpuSelectedProvider: "cpu",
          webgpuFallbackReason: "node-stable-gpu-path-unavailable",
          pagesPerSecondRatio: 0.98
        }
      ]
    }),
    {
      passed: true,
      comparisonCount: 1,
      equivalentAcceptedOutputs: 1,
      parityFailures: [],
      minSpeedup: 1.05,
      speedupAvailable: false,
      speedupComparisonCount: 0,
      speedupFailures: [],
      fallbackReasons: ["node-stable-gpu-path-unavailable"],
      speedupStatus: "not-applicable"
    }
  );
});

test("evaluateWebGpuComparisonReport enforces speedup when WebGPU is selected", () => {
  assert.equal(
    evaluateWebGpuComparisonReport({
      comparisons: [
        {
          id: "scan",
          equivalentAcceptedOutput: true,
          webgpuSelectedProvider: "webgpu",
          webgpuFallbackReason: null,
          pagesPerSecondRatio: 1.2
        }
      ]
    }).passed,
    true
  );

  const failed = evaluateWebGpuComparisonReport({
    comparisons: [
      {
        id: "scan",
        equivalentAcceptedOutput: true,
        webgpuSelectedProvider: "webgpu",
        webgpuFallbackReason: null,
        pagesPerSecondRatio: 1
      }
    ]
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.speedupStatus, "failed");
  assert.equal(failed.speedupFailures.length, 1);
});

test("evaluateWebGpuComparisonReport accepts WebGPU preprocessing speedup metrics", () => {
  const summary = evaluateWebGpuComparisonReport({
    comparisons: [
      {
        id: "scan",
        equivalentAcceptedOutput: true,
        webgpuSelectedProvider: "webgpu",
        webgpuFallbackReason: null,
        speedupMetric: "webgpu-preprocessing",
        speedupRatio: 1.2,
        pagesPerSecondRatio: 0.9
      }
    ]
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.speedupStatus, "passed");
  assert.equal(summary.speedupFailures.length, 0);
});

test("evaluateWebGpuComparisonReport fails parity mismatches and required missing speedup", () => {
  assert.equal(
    evaluateWebGpuComparisonReport({
      comparisons: [
        {
          id: "scan",
          equivalentAcceptedOutput: false,
          webgpuSelectedProvider: "cpu",
          webgpuFallbackReason: "node-stable-gpu-path-unavailable",
          pagesPerSecondRatio: 1.1
        }
      ]
    }).passed,
    false
  );

  const missing = evaluateWebGpuComparisonReport(
    {
      comparisons: [
        {
          id: "scan",
          equivalentAcceptedOutput: true,
          webgpuSelectedProvider: "cpu",
          webgpuFallbackReason: "node-stable-gpu-path-unavailable",
          pagesPerSecondRatio: 1.1
        }
      ]
    },
    { requireSpeedup: true }
  );
  assert.equal(missing.passed, false);
  assert.equal(missing.speedupStatus, "missing");
});
