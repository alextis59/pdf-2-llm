import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveThresholdRgbaCpu,
  binarizeRgbaCpu,
  createAdaptiveThresholdRgbaShaderSource,
  createBinarizeRgbaShaderSource,
  createWebGpuAdaptiveThresholdRgbaRunner,
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

test("adaptiveThresholdRgbaCpu applies a local threshold while preserving alpha", () => {
  const input = new Uint8Array([
    0, 0, 0, 255,
    100, 100, 100, 128,
    255, 255, 255, 64
  ]);

  assert.deepEqual(
    [...adaptiveThresholdRgbaCpu(input, { bias: 0, height: 1, radius: 1, width: 3 })],
    [
      255, 255, 255, 255,
      255, 255, 255, 128,
      255, 255, 255, 64
    ]
  );
});

test("adaptiveThresholdRgbaCpu preserves zero bias for non-border pixels and clamps signed bias", () => {
  const input = new Uint8Array(
    [100, 100, 100, 100, 95, 100, 100, 100, 100].flatMap((value) => [
      value,
      value,
      value,
      255
    ])
  );
  const options = { height: 3, radius: 1, width: 3 };

  const unbiased = adaptiveThresholdRgbaCpu(input, { ...options, bias: 0 });
  const defaultBiased = adaptiveThresholdRgbaCpu(input, options);
  assert.equal(unbiased[4 * 4], 0);
  assert.equal(defaultBiased[4 * 4], 255);
  assert.deepEqual(
    adaptiveThresholdRgbaCpu(input, { ...options, bias: -999 }),
    adaptiveThresholdRgbaCpu(input, { ...options, bias: -255 })
  );
  assert.deepEqual(
    adaptiveThresholdRgbaCpu(input, { ...options, bias: 999 }),
    adaptiveThresholdRgbaCpu(input, { ...options, bias: 255 })
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

test("createAdaptiveThresholdRgbaShaderSource emits local threshold parameters", () => {
  const source = createAdaptiveThresholdRgbaShaderSource({ workgroupSize: 128 });

  assert.match(source, /@compute @workgroup_size\(128\)/);
  assert.match(source, /let radius = params\[3\]/);
  assert.match(source, /let bias = bitcast<i32>\(params\[4\]\)/);
  assert.match(source, /i32\(current\) \+ bias >= i32\(average\)/);
  assert.match(source, /inputPixels\[sampleY \* width \+ sampleX\]/);
});

test("adaptive WebGPU runner uploads zero and clamped signed bias words", async () => {
  const parameterWrites = [];
  const runner = createWebGpuAdaptiveThresholdRgbaRunner({
    device: createParameterCaptureDevice(parameterWrites),
    workgroupSize: 4
  });
  const input = new Uint8Array(3 * 3 * 4);

  await runner.run(input, { bias: 0, height: 3, radius: 1, width: 3 });
  await runner.run(input, { bias: -999, height: 3, radius: 1, width: 3 });

  assert.deepEqual(
    parameterWrites.map((parameters) => parameters[4]),
    [0, -255 >>> 0]
  );
});

test("createWebGpuBinarizeRgbaRunner validates required WebGPU device methods", () => {
  assert.throws(
    () => createWebGpuBinarizeRgbaRunner({ device: {} }),
    /missing createBindGroup/
  );
});

test("createWebGpuBinarizeRgbaRunner splits large work into two-dimensional dispatch", async () => {
  const dispatches = [];
  const device = {
    limits: {
      maxComputeWorkgroupsPerDimension: 2
    },
    queue: {
      writeBuffer() {},
      submit() {}
    },
    createBindGroup() {
      return {};
    },
    createBuffer({ size }) {
      return {
        destroy() {},
        getMappedRange() {
          return new ArrayBuffer(size);
        },
        async mapAsync() {},
        unmap() {}
      };
    },
    createCommandEncoder() {
      return {
        beginComputePass() {
          return {
            dispatchWorkgroups(x, y) {
              dispatches.push([x, y]);
            },
            end() {},
            setBindGroup() {},
            setPipeline() {}
          };
        },
        copyBufferToBuffer() {},
        finish() {
          return {};
        }
      };
    },
    createComputePipeline() {
      return {
        getBindGroupLayout() {
          return {};
        }
      };
    },
    createShaderModule() {
      return {};
    }
  };
  const runner = createWebGpuBinarizeRgbaRunner({ device, workgroupSize: 4 });

  await runner.run(new Uint8Array(10 * 4));

  assert.deepEqual(dispatches, [[2, 2]]);
});

test("WebGPU preprocessing runners destroy buffers when readback mapping fails", async () => {
  for (const { createRunner, label, options } of [
    {
      createRunner: createWebGpuBinarizeRgbaRunner,
      label: "binarize",
      options: {}
    },
    {
      createRunner: createWebGpuAdaptiveThresholdRgbaRunner,
      label: "adaptive",
      options: { height: 1, width: 1 }
    }
  ]) {
    const destroyed = [];
    const runner = createRunner({
      device: createMapFailureDevice(destroyed),
      label,
      workgroupSize: 4
    });

    await assert.rejects(
      () => runner.run(new Uint8Array(4), options),
      /map failed/
    );
    assert.deepEqual(
      destroyed.sort(),
      [
        `${label}-input`,
        `${label}-output`,
        `${label}-params`,
        `${label}-readback`
      ].sort()
    );
  }
});

test("binarizeRgbaCpu rejects non-RGBA input", () => {
  assert.throws(
    () => binarizeRgbaCpu(new Uint8Array([1, 2, 3])),
    /multiple of 4/
  );
});

function createMapFailureDevice(destroyed) {
  return {
    queue: {
      writeBuffer() {},
      submit() {}
    },
    createBindGroup() {
      return {};
    },
    createBuffer({ label, size }) {
      return {
        destroy() {
          destroyed.push(label);
        },
        getMappedRange() {
          return new ArrayBuffer(size);
        },
        async mapAsync() {
          if (label.endsWith("-readback")) {
            throw new Error("map failed");
          }
        },
        unmap() {}
      };
    },
    createCommandEncoder() {
      return {
        beginComputePass() {
          return {
            dispatchWorkgroups() {},
            end() {},
            setBindGroup() {},
            setPipeline() {}
          };
        },
        copyBufferToBuffer() {},
        finish() {
          return {};
        }
      };
    },
    createComputePipeline() {
      return {
        getBindGroupLayout() {
          return {};
        }
      };
    },
    createShaderModule() {
      return {};
    }
  };
}

function createParameterCaptureDevice(parameterWrites) {
  return {
    queue: {
      writeBuffer(buffer, _offset, data) {
        if (buffer.label.endsWith("-params")) {
          parameterWrites.push([...data]);
        }
      },
      submit() {}
    },
    createBindGroup() {
      return {};
    },
    createBuffer({ label, size }) {
      return {
        label,
        destroy() {},
        getMappedRange() {
          return new ArrayBuffer(size);
        },
        async mapAsync() {},
        unmap() {}
      };
    },
    createCommandEncoder() {
      return {
        beginComputePass() {
          return {
            dispatchWorkgroups() {},
            end() {},
            setBindGroup() {},
            setPipeline() {}
          };
        },
        copyBufferToBuffer() {},
        finish() {
          return {};
        }
      };
    },
    createComputePipeline() {
      return {
        getBindGroupLayout() {
          return {};
        }
      };
    },
    createShaderModule() {
      return {};
    }
  };
}

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

test("createWebGpuPreprocessingDiagnostics preserves an explicit zero adaptive bias", async () => {
  const biases = [];
  const diagnostics = await createWebGpuPreprocessingDiagnostics({
    execution: {
      routedPages: 1,
      batches: [
        {
          pages: [
            {
              pageIndex: 0,
              sourceType: "scanned",
              pixelCount: 9,
              estimatedBytes: 36
            }
          ]
        }
      ]
    },
    options: {
      preprocessing: {
        bias: 0,
        maxSamplePixelsPerPage: 9,
        workload: "adaptive-threshold-rgba",
        runner: {
          async run(rgba, options) {
            biases.push(options.bias);
            return adaptiveThresholdRgbaCpu(rgba, options);
          }
        }
      }
    },
    webgpu: {
      selectedProvider: "webgpu"
    }
  });

  assert.deepEqual(biases, [0]);
  assert.equal(diagnostics.bias, 0);
  assert.equal(diagnostics.parity, true);
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
