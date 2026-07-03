const defaultWorkgroupSize = 64;
const defaultThreshold = 128;

const defaultGpuBufferUsage = Object.freeze({
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  UNIFORM: 64,
  STORAGE: 128
});

const defaultGpuMapMode = Object.freeze({
  READ: 1
});

export function binarizeRgbaCpu(rgba, { threshold = defaultThreshold } = {}) {
  const input = normalizeRgbaInput(rgba);
  const normalizedThreshold = normalizeThreshold(threshold);
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 4) {
    const r = input[index];
    const g = input[index + 1];
    const b = input[index + 2];
    const alpha = input[index + 3];
    const luma = ((77 * r + 150 * g + 29 * b) >>> 8);
    const value = luma >= normalizedThreshold ? 255 : 0;
    output[index] = value;
    output[index + 1] = value;
    output[index + 2] = value;
    output[index + 3] = alpha;
  }
  return output;
}

export function createBinarizeRgbaShaderSource({ workgroupSize = defaultWorkgroupSize } = {}) {
  const normalizedWorkgroupSize = normalizePositiveInteger(workgroupSize, defaultWorkgroupSize);
  return `
struct Params {
  pixelCount: u32,
  threshold: u32,
  _padding0: u32,
  _padding1: u32,
};

@group(0) @binding(0) var<storage, read> inputPixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputPixels: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${normalizedWorkgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= params.pixelCount) {
    return;
  }

  let pixel = inputPixels[index];
  let r = pixel & 255u;
  let g = (pixel >> 8u) & 255u;
  let b = (pixel >> 16u) & 255u;
  let alpha = pixel & 4278190080u;
  let luma = (77u * r + 150u * g + 29u * b) >> 8u;
  let value = select(0u, 255u, luma >= params.threshold);
  outputPixels[index] = value | (value << 8u) | (value << 16u) | alpha;
}
`.trim();
}

export function createWebGpuBinarizeRgbaRunner({
  device,
  gpuBufferUsage = globalThis.GPUBufferUsage,
  gpuMapMode = globalThis.GPUMapMode,
  label = "pdf2md-ocr-preprocess-binarize-rgba",
  workgroupSize = defaultWorkgroupSize
} = {}) {
  validateWebGpuDevice(device);
  const usages = gpuBufferUsage ?? defaultGpuBufferUsage;
  const mapModes = gpuMapMode ?? defaultGpuMapMode;
  const normalizedWorkgroupSize = normalizePositiveInteger(workgroupSize, defaultWorkgroupSize);
  const shaderModule = device.createShaderModule({
    label: `${label}-shader`,
    code: createBinarizeRgbaShaderSource({ workgroupSize: normalizedWorkgroupSize })
  });
  const pipeline = device.createComputePipeline({
    label: `${label}-pipeline`,
    layout: "auto",
    compute: {
      module: shaderModule,
      entryPoint: "main"
    }
  });

  return {
    async run(rgba, { threshold = defaultThreshold } = {}) {
      const input = normalizeRgbaInput(rgba);
      const inputWords = packRgbaWords(input);
      const size = inputWords.byteLength;
      const normalizedThreshold = normalizeThreshold(threshold);
      const inputBuffer = device.createBuffer({
        label: `${label}-input`,
        size,
        usage: usages.STORAGE | usages.COPY_DST
      });
      const outputBuffer = device.createBuffer({
        label: `${label}-output`,
        size,
        usage: usages.STORAGE | usages.COPY_SRC
      });
      const paramsBuffer = device.createBuffer({
        label: `${label}-params`,
        size: 16,
        usage: usages.UNIFORM | usages.COPY_DST
      });
      const readbackBuffer = device.createBuffer({
        label: `${label}-readback`,
        size,
        usage: usages.MAP_READ | usages.COPY_DST
      });

      device.queue.writeBuffer(inputBuffer, 0, inputWords);
      device.queue.writeBuffer(
        paramsBuffer,
        0,
        new Uint32Array([inputWords.length, normalizedThreshold, 0, 0])
      );

      const bindGroup = device.createBindGroup({
        label: `${label}-bind-group`,
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: outputBuffer } },
          { binding: 2, resource: { buffer: paramsBuffer } }
        ]
      });
      const encoder = device.createCommandEncoder({ label: `${label}-encoder` });
      const pass = encoder.beginComputePass({ label: `${label}-pass` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(inputWords.length / normalizedWorkgroupSize));
      pass.end();
      encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, size);
      device.queue.submit([encoder.finish()]);

      await readbackBuffer.mapAsync(mapModes.READ);
      const mapped = readbackBuffer.getMappedRange();
      const outputWords = new Uint32Array(mapped.slice(0));
      readbackBuffer.unmap();
      destroyBuffers([inputBuffer, outputBuffer, paramsBuffer, readbackBuffer]);
      return unpackRgbaWords(outputWords, input.length);
    }
  };
}

export async function binarizeRgbaWithWebGpu(options = {}) {
  const runner = createWebGpuBinarizeRgbaRunner(options);
  return runner.run(options.rgba, { threshold: options.threshold });
}

export function packRgbaWords(rgba) {
  const input = normalizeRgbaInput(rgba);
  const output = new Uint32Array(input.length / 4);
  for (let inputIndex = 0, outputIndex = 0; inputIndex < input.length; inputIndex += 4, outputIndex += 1) {
    output[outputIndex] =
      input[inputIndex] |
      (input[inputIndex + 1] << 8) |
      (input[inputIndex + 2] << 16) |
      (input[inputIndex + 3] << 24);
  }
  return output;
}

export function unpackRgbaWords(words, byteLength = words.length * 4) {
  const output = new Uint8Array(byteLength);
  for (let outputIndex = 0, wordIndex = 0; outputIndex < output.length; outputIndex += 4, wordIndex += 1) {
    const word = words[wordIndex] ?? 0;
    output[outputIndex] = word & 255;
    output[outputIndex + 1] = (word >>> 8) & 255;
    output[outputIndex + 2] = (word >>> 16) & 255;
    output[outputIndex + 3] = (word >>> 24) & 255;
  }
  return output;
}

function destroyBuffers(buffers) {
  for (const buffer of buffers) {
    buffer.destroy?.();
  }
}

function normalizeRgbaInput(rgba) {
  if (!(rgba instanceof Uint8Array)) {
    throw new TypeError("rgba must be a Uint8Array");
  }
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error("rgba length must be a non-empty multiple of 4");
  }
  return rgba;
}

function normalizeThreshold(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) {
    return defaultThreshold;
  }
  return Math.max(0, Math.min(255, Math.round(threshold)));
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validateWebGpuDevice(device) {
  const required = [
    "createBindGroup",
    "createBuffer",
    "createCommandEncoder",
    "createComputePipeline",
    "createShaderModule"
  ];
  for (const method of required) {
    if (typeof device?.[method] !== "function") {
      throw new Error(`WebGPU device is missing ${method}()`);
    }
  }
  if (typeof device.queue?.writeBuffer !== "function" || typeof device.queue?.submit !== "function") {
    throw new Error("WebGPU device queue is missing writeBuffer() or submit()");
  }
}
