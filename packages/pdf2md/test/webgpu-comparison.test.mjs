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
      speedupStatus: "not-applicable",
      validationErrors: []
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

test("evaluateWebGpuComparisonReport rejects empty and missing comparison evidence", () => {
  const empty = evaluateWebGpuComparisonReport({ comparisons: [] });
  assert.equal(empty.passed, false);
  assert.equal(empty.speedupStatus, "invalid");
  assert.deepEqual(empty.validationErrors, [
    "report.comparisons must contain at least one comparison"
  ]);

  const missing = evaluateWebGpuComparisonReport({});
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.validationErrors, ["report.comparisons must be an array"]);
});

test("evaluateWebGpuComparisonReport rejects malformed comparisons before evaluating them", () => {
  const summary = evaluateWebGpuComparisonReport({
    comparisons: [
      {
        id: "scan",
        equivalentAcceptedOutput: "true",
        webgpuSelectedProvider: "gpu",
        pagesPerSecondRatio: "1.2"
      }
    ]
  });

  assert.equal(summary.passed, false);
  assert.equal(summary.speedupStatus, "invalid");
  assert.deepEqual(summary.parityFailures, []);
  assert.deepEqual(summary.speedupFailures, []);
  assert.deepEqual(summary.validationErrors, [
    "report.comparisons[0].equivalentAcceptedOutput must be a boolean",
    'report.comparisons[0].webgpuSelectedProvider must be "cpu" or "webgpu"',
    "report.comparisons[0].pagesPerSecondRatio must be null or a finite non-negative number"
  ]);
});

test("evaluateWebGpuComparisonReport rejects invalid speedup thresholds", () => {
  const report = {
    comparisons: [
      {
        id: "scan",
        equivalentAcceptedOutput: true,
        webgpuSelectedProvider: "webgpu",
        pagesPerSecondRatio: 1.2
      }
    ]
  };

  assert.deepEqual(evaluateWebGpuComparisonReport(report, { minSpeedup: Number.NaN }).validationErrors, [
    "minSpeedup must be a finite number greater than zero"
  ]);
  assert.deepEqual(evaluateWebGpuComparisonReport(report, { minSpeedup: 0 }).validationErrors, [
    "minSpeedup must be a finite number greater than zero"
  ]);
});
