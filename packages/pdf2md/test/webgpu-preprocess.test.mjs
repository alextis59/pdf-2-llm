import assert from "node:assert/strict";
import test from "node:test";
import {
  binarizeRgbaCpu,
  createBinarizeRgbaShaderSource,
  createWebGpuPreprocessingDiagnostics,
  createWebGpuBinarizeRgbaRunner,
  packRgbaWords,
  unpackRgbaWords
} from "../src/webgpu-preprocess.mjs";

test("binarizeRgbaCpu thresholds RGBA pixels while preserving alpha", () => {
  const input = new Uint8Array([
    10, 10, 10, 255,
    250, 250, 250, 128,
    255, 0, 0, 64
  ]);

  assert.deepEqual(
    [...binarizeRgbaCpu(input, { threshold: 128 })],
    [
      0, 0, 0, 255,
      255, 255, 255, 128,
      0, 0, 0, 64
    ]
  );
});

test("packRgbaWords and unpackRgbaWords preserve channel order", () => {
  const input = new Uint8Array([
    1, 2, 3, 4,
    250, 251, 252, 253
  ]);
  const words = packRgbaWords(input);

  assert.deepEqual([...words], [0x04030201, 0xfdfcfbfa]);
  assert.deepEqual([...unpackRgbaWords(words)], [...input]);
});

test("createBinarizeRgbaShaderSource emits the configured workgroup size", () => {
  const source = createBinarizeRgbaShaderSource({ workgroupSize: 128 });

  assert.match(source, /@compute @workgroup_size\(128\)/);
  assert.match(source, /inputPixels/);
  assert.match(source, /outputPixels/);
  assert.match(source, /params.threshold/);
});

test("createWebGpuBinarizeRgbaRunner validates required WebGPU device methods", () => {
  assert.throws(
    () => createWebGpuBinarizeRgbaRunner({ device: {} }),
    /missing createBindGroup/
  );
});

test("binarizeRgbaCpu rejects non-RGBA input", () => {
  assert.throws(
    () => binarizeRgbaCpu(new Uint8Array([1, 2, 3])),
    /multiple of 4/
  );
});

test("createWebGpuPreprocessingDiagnostics executes routed samples through a runner", async () => {
  const calls = [];
  const diagnostics = await createWebGpuPreprocessingDiagnostics({
    execution: {
      routedPages: 1,
      batches: [
        {
          pages: [
            {
              pageIndex: 0,
              sourceType: "scanned",
              pixelCount: 32,
              estimatedBytes: 128
            }
          ]
        }
      ]
    },
    options: {
      preprocessing: {
        maxSamplePixelsPerPage: 8,
        runner: {
          async run(rgba, options) {
            calls.push(options.page.pageIndex);
            return binarizeRgbaCpu(rgba, { threshold: options.threshold });
          }
        }
      }
    },
    webgpu: {
      selectedProvider: "webgpu"
    }
  });

  assert.deepEqual(calls, [0]);
  assert.equal(diagnostics.status, "completed");
  assert.equal(diagnostics.provider, "webgpu");
  assert.equal(diagnostics.processedPages, 1);
  assert.equal(diagnostics.totalSamplePixels, 8);
  assert.equal(diagnostics.parity, true);
  assert.equal(diagnostics.pages[0].parity, true);
});

test("createWebGpuPreprocessingDiagnostics records fallback without a selected provider", async () => {
  const diagnostics = await createWebGpuPreprocessingDiagnostics({
    execution: {
      routedPages: 1,
      batches: []
    },
    webgpu: {
      selectedProvider: "cpu",
      fallbackReason: "node-stable-gpu-path-unavailable"
    }
  });

  assert.equal(diagnostics.status, "cpu-fallback");
  assert.equal(diagnostics.fallbackReason, "node-stable-gpu-path-unavailable");
  assert.equal(diagnostics.processedPages, 0);
});

test("createWebGpuPreprocessingDiagnostics records runner failures", async () => {
  const diagnostics = await createWebGpuPreprocessingDiagnostics({
    execution: {
      routedPages: 1,
      batches: [
        {
          pages: [
            {
              pageIndex: 0,
              sourceType: "scanned",
              pixelCount: 32,
              estimatedBytes: 128
            }
          ]
        }
      ]
    },
    options: {
      preprocessing: {
        runner: {
          async run() {
            throw new Error("runner failed");
          }
        }
      }
    },
    webgpu: {
      selectedProvider: "webgpu"
    }
  });

  assert.equal(diagnostics.status, "failed");
  assert.equal(diagnostics.fallbackReason, "webgpu-preprocessing-run-failed");
  assert.deepEqual(diagnostics.error, {
    name: "Error",
    message: "runner failed"
  });
  assert.equal(diagnostics.processedPages, 0);
  assert.equal(diagnostics.parity, false);
});
