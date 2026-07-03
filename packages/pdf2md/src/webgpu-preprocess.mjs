const defaultWorkgroupSize = 64;
const defaultThreshold = 128;
const defaultMaxSamplePixelsPerPage = 262_144;
const defaultMinSpeedup = 1.05;

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

export async function createWebGpuPreprocessingDiagnostics({
  execution = null,
  options = {},
  webgpu = null
} = {}) {
  const preprocessingOptions = options.preprocessing ?? {};
  const threshold = normalizeThreshold(preprocessingOptions.threshold ?? defaultThreshold);
  const maxSamplePixelsPerPage = normalizePositiveInteger(
    preprocessingOptions.maxSamplePixelsPerPage,
    defaultMaxSamplePixelsPerPage
  );
  const minSpeedup = normalizePositiveNumber(
    preprocessingOptions.minSpeedup,
    defaultMinSpeedup
  );
  const plannedPages = plannedExecutionPages(execution);
  const base = {
    enabled: preprocessingOptions.enabled !== false,
    provider: webgpu?.selectedProvider ?? "cpu",
    status: "disabled",
    workload: "ocr-preprocess-binarize-rgba",
    threshold,
    minSpeedup,
    routedPages: execution?.routedPages ?? 0,
    plannedPages: plannedPages.length,
    processedPages: 0,
    maxSamplePixelsPerPage,
    totalSamplePixels: 0,
    parity: null,
    cpuMs: null,
    gpuMs: null,
    speedupRatio: null,
    speedupPassed: false,
    fallbackReason: null,
    error: null,
    pages: []
  };

  if (preprocessingOptions.enabled === false) {
    return {
      ...base,
      enabled: false,
      status: "disabled"
    };
  }
  if (webgpu?.selectedProvider !== "webgpu") {
    return {
      ...base,
      status: "cpu-fallback",
      fallbackReason: webgpu?.fallbackReason ?? "webgpu-unavailable"
    };
  }
  if (plannedPages.length === 0) {
    return {
      ...base,
      status: "no-routed-pages"
    };
  }

  let runner = null;
  try {
    runner = preprocessingOptions.runner ?? createRunnerFromDevice(options.device);
  } catch (error) {
    return {
      ...base,
      status: "failed",
      fallbackReason: "webgpu-runner-create-failed",
      error: describeError(error)
    };
  }
  if (!runner) {
    return {
      ...base,
      status: "device-unavailable",
      fallbackReason: "webgpu-device-unavailable"
    };
  }

  const pages = [];
  for (const page of plannedPages) {
    const samplePixels = Math.min(page.pixelCount, maxSamplePixelsPerPage);
    const input = createDeterministicRgbaSample(samplePixels, page.pageIndex);
    const cpuStartedAt = nowMs();
    const expected = binarizeRgbaCpu(input, { threshold });
    const cpuMs = nowMs() - cpuStartedAt;
    const gpuStartedAt = nowMs();
    let actual;
    try {
      actual = await runner.run(input, { threshold, page });
    } catch (error) {
      return {
        ...base,
        status: "failed",
        processedPages: pages.length,
        totalSamplePixels: pages.reduce((sum, page) => sum + page.samplePixels, 0),
        parity: false,
        cpuMs: pages.reduce((sum, page) => sum + page.cpuMs, 0),
        gpuMs: pages.reduce((sum, page) => sum + page.gpuMs, 0),
        fallbackReason: "webgpu-preprocessing-run-failed",
        error: describeError(error),
        pages
      };
    }
    const gpuMs = nowMs() - gpuStartedAt;
    const parity = byteArraysEqual(expected, actual);
    const speedupRatio = gpuMs > 0 ? cpuMs / gpuMs : null;
    pages.push({
      pageIndex: page.pageIndex,
      sourceType: page.sourceType,
      samplePixels,
      parity,
      cpuMs,
      gpuMs,
      speedupRatio,
      speedupPassed: Number.isFinite(speedupRatio) && speedupRatio >= minSpeedup
    });
  }

  const parity = pages.every((page) => page.parity);
  const cpuMs = pages.reduce((sum, page) => sum + page.cpuMs, 0);
  const gpuMs = pages.reduce((sum, page) => sum + page.gpuMs, 0);
  const speedupRatio = gpuMs > 0 ? cpuMs / gpuMs : null;
  return {
    ...base,
    status: parity ? "completed" : "failed",
    processedPages: pages.length,
    totalSamplePixels: pages.reduce((sum, page) => sum + page.samplePixels, 0),
    parity,
    cpuMs,
    gpuMs,
    speedupRatio,
    speedupPassed: Number.isFinite(speedupRatio) && speedupRatio >= minSpeedup,
    pages
  };
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

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function plannedExecutionPages(execution) {
  return (execution?.batches ?? [])
    .flatMap((batch) => batch.pages ?? [])
    .filter((page) =>
      Number.isInteger(page.pageIndex) &&
      Number.isInteger(page.pixelCount) &&
      page.pixelCount > 0
    );
}

function createRunnerFromDevice(device) {
  if (!device) {
    return null;
  }
  return createWebGpuBinarizeRgbaRunner({ device });
}

function createDeterministicRgbaSample(pixelCount, seed = 0) {
  const normalizedPixelCount = normalizePositiveInteger(pixelCount, 1);
  const rgba = new Uint8Array(normalizedPixelCount * 4);
  for (let pixel = 0; pixel < normalizedPixelCount; pixel += 1) {
    const offset = pixel * 4;
    const value = (pixel * 13 + seed * 29 + (pixel >>> 8)) & 255;
    rgba[offset] = value;
    rgba[offset + 1] = (value * 3 + seed) & 255;
    rgba[offset + 2] = (255 - value + seed * 7) & 255;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function byteArraysEqual(left, right) {
  if (!(right instanceof Uint8Array) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function describeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error)
  };
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
