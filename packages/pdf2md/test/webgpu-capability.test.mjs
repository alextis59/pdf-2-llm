import assert from "node:assert/strict";
import test from "node:test";
import { detectWebGpuCapabilities } from "../src/webgpu-capability.mjs";

test("detectWebGpuCapabilities keeps CPU selected when WebGPU is not requested", async () => {
  const result = await detectWebGpuCapabilities({}, {});

  assert.deepEqual(result, {
    enabled: false,
    requested: "disabled",
    runtime: "node",
    status: "disabled",
    selectedProvider: "cpu",
    fallbackReason: "not-requested",
    browser: {
      supported: false,
      reason: "navigator-gpu-missing"
    },
    provider: {
      id: "cpu",
      kind: "cpu",
      status: "fallback"
    },
    adapter: null,
    error: null
  });
});

test("detectWebGpuCapabilities reports browser WebGPU adapter features and limits", async () => {
  const result = await detectWebGpuCapabilities(
    { preferred: true },
    {
      document: {},
      navigator: {
        gpu: {
          async requestAdapter(options) {
            assert.deepEqual(options, { powerPreference: "high-performance" });
            return {
              name: "Test Adapter",
              info: {
                vendor: "Test Vendor",
                architecture: "test-arch",
                device: "test-device",
                description: "Test GPU"
              },
              features: new Set(["texture-compression-bc", "shader-f16"]),
              limits: {
                maxBufferSize: 1024,
                maxTextureDimension2D: 8192,
                ignoredLimit: "not-a-number"
              }
            };
          }
        }
      }
    }
  );

  assert.deepEqual(result, {
    enabled: true,
    requested: "preferred",
    runtime: "browser",
    status: "selected",
    selectedProvider: "webgpu",
    fallbackReason: null,
    browser: {
      supported: true,
      reason: null
    },
    provider: {
      id: "webgpu",
      kind: "gpu",
      status: "selected"
    },
    adapter: {
      name: "Test Adapter",
      info: {
        vendor: "Test Vendor",
        architecture: "test-arch",
        device: "test-device",
        description: "Test GPU"
      },
      features: ["shader-f16", "texture-compression-bc"],
      limits: {
        maxBufferSize: 1024,
        maxTextureDimension2D: 8192
      }
    }
  });
});

test("detectWebGpuCapabilities falls back to CPU when browser WebGPU is unavailable", async () => {
  const result = await detectWebGpuCapabilities({ required: true }, { document: {}, navigator: {} });

  assert.equal(result.enabled, false);
  assert.equal(result.runtime, "browser");
  assert.equal(result.status, "fallback-cpu");
  assert.equal(result.selectedProvider, "cpu");
  assert.equal(result.fallbackReason, "navigator-gpu-missing");
  assert.deepEqual(result.browser, {
    supported: false,
    reason: "navigator-gpu-missing"
  });
});

test("detectWebGpuCapabilities keeps Node on CPU without a stable GPU path", async () => {
  const result = await detectWebGpuCapabilities(
    { preferred: true },
    {
      navigator: {
        gpu: {
          async requestAdapter() {
            throw new Error("should not request experimental Node adapters");
          }
        }
      },
      process: {
        versions: {
          node: "22.0.0"
        }
      }
    }
  );

  assert.equal(result.enabled, false);
  assert.equal(result.runtime, "node");
  assert.equal(result.status, "fallback-cpu");
  assert.equal(result.selectedProvider, "cpu");
  assert.equal(result.fallbackReason, "node-stable-gpu-path-unavailable");
});
