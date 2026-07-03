import assert from "node:assert/strict";
import test from "node:test";
import {
  binarizeRgbaCpu,
  createBinarizeRgbaShaderSource,
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
