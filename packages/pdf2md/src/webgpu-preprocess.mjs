const defaultWorkgroupSize = 64;
const defaultThreshold = 128;
const defaultMaxSamplePixelsPerPage = 262_144;
const defaultMinSpeedup = 1.05;
const defaultAdaptiveRadius = 8;
const defaultAdaptiveBias = 7;
const minAdaptiveBias = -255;
const maxAdaptiveBias = 255;
const adaptiveThresholdWorkload = "adaptive-threshold-rgba";
const binarizeWorkload = "binarize-rgba";

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

export function adaptiveThresholdRgbaCpu(
  rgba,
  {
    bias = defaultAdaptiveBias,
    height,
    radius = defaultAdaptiveRadius,
    width
  } = {}
) {
  const input = normalizeRgbaInput(rgba);
  const geometry = normalizeImageGeometry(input, { height, width });
  const normalizedRadius = normalizePositiveInteger(radius, defaultAdaptiveRadius);
  const normalizedBias = normalizeAdaptiveBias(bias);
  const luma = new Uint16Array(geometry.pixelCount);
  for (let pixel = 0, offset = 0; pixel < geometry.pixelCount; pixel += 1, offset += 4) {
    luma[pixel] = (77 * input[offset] + 150 * input[offset + 1] + 29 * input[offset + 2]) >>> 8;
  }

  const output = new Uint8Array(input.length);
  for (let y = 0; y < geometry.height; y += 1) {
    for (let x = 0; x < geometry.width; x += 1) {
      const index = y * geometry.width + x;
      let sum = 0;
      let count = 0;
      if (
        x < normalizedRadius ||
        y < normalizedRadius ||
        x + normalizedRadius >= geometry.width ||
        y + normalizedRadius >= geometry.height
      ) {
        sum = luma[index];
        count = 1;
      } else {
        for (let sampleY = y - normalizedRadius; sampleY <= y + normalizedRadius; sampleY += 1) {
          const rowOffset = sampleY * geometry.width;
          for (let sampleX = x - normalizedRadius; sampleX <= x + normalizedRadius; sampleX += 1) {
            sum += luma[rowOffset + sampleX];
            count += 1;
          }
        }
      }
      const offset = index * 4;
      const average = Math.floor(sum / count);
      const value = luma[index] + normalizedBias >= average ? 255 : 0;
      output[offset] = value;
      output[offset + 1] = value;
      output[offset + 2] = value;
      output[offset + 3] = input[offset + 3];
    }
  }
  return output;
}

export function createBinarizeRgbaShaderSource({ workgroupSize = defaultWorkgroupSize } = {}) {
  const normalizedWorkgroupSize = normalizePositiveInteger(workgroupSize, defaultWorkgroupSize);
  return `
struct Params {
  pixelCount: u32,
  threshold: u32,
  workgroupsPerRow: u32,
  _padding1: u32,
};

@group(0) @binding(0) var<storage, read> inputPixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputPixels: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(${normalizedWorkgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x + id.y * params.workgroupsPerRow * ${normalizedWorkgroupSize}u;
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

export function createAdaptiveThresholdRgbaShaderSource({
  workgroupSize = defaultWorkgroupSize
} = {}) {
  const normalizedWorkgroupSize = normalizePositiveInteger(workgroupSize, defaultWorkgroupSize);
  return `
@group(0) @binding(0) var<storage, read> inputPixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputPixels: array<u32>;
@group(0) @binding(2) var<storage, read> params: array<u32>;

fn luma(pixel: u32) -> u32 {
  let r = pixel & 255u;
  let g = (pixel >> 8u) & 255u;
  let b = (pixel >> 16u) & 255u;
  return (77u * r + 150u * g + 29u * b) >> 8u;
}

@compute @workgroup_size(${normalizedWorkgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let pixelCount = params[0];
  let width = params[1];
  let height = params[2];
  let radius = params[3];
  let bias = bitcast<i32>(params[4]);
  let workgroupsPerRow = params[5];
  let index = id.x + id.y * workgroupsPerRow * ${normalizedWorkgroupSize}u;
  if (index >= pixelCount) {
    return;
  }

  let x = index % width;
  let y = index / width;
  let pixel = inputPixels[index];
  let current = luma(pixel);
  var sum = 0u;
  var count = 0u;
  if (x < radius || y < radius || x + radius >= width || y + radius >= height) {
    sum = current;
    count = 1u;
  } else {
    var sampleY = y - radius;
    loop {
      var sampleX = x - radius;
      loop {
        sum = sum + luma(inputPixels[sampleY * width + sampleX]);
        count = count + 1u;
        if (sampleX >= x + radius) {
          break;
        }
        sampleX = sampleX + 1u;
      }
      if (sampleY >= y + radius) {
        break;
      }
      sampleY = sampleY + 1u;
    }
  }

  let alpha = pixel & 4278190080u;
  let average = sum / count;
  let value = select(0u, 255u, i32(current) + bias >= i32(average));
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
      const dispatch = createDispatchPlan(inputWords.length, {
        maxWorkgroupsPerDimension: readMaxComputeWorkgroupsPerDimension(device),
        workgroupSize: normalizedWorkgroupSize
      });
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
      let readbackMapped = false;

      try {
        device.queue.writeBuffer(inputBuffer, 0, inputWords);
        device.queue.writeBuffer(
          paramsBuffer,
          0,
          new Uint32Array([
            inputWords.length,
            normalizedThreshold,
            dispatch.workgroupsPerRow,
            0
          ])
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
        pass.dispatchWorkgroups(dispatch.workgroupsPerRow, dispatch.rows);
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, size);
        device.queue.submit([encoder.finish()]);

        await readbackBuffer.mapAsync(mapModes.READ);
        readbackMapped = true;
        const mapped = readbackBuffer.getMappedRange();
        const outputWords = new Uint32Array(mapped.slice(0));
        return unpackRgbaWords(outputWords, input.length);
      } finally {
        try {
          if (readbackMapped) {
            readbackBuffer.unmap();
          }
        } finally {
          destroyBuffers([inputBuffer, outputBuffer, paramsBuffer, readbackBuffer]);
        }
      }
    }
  };
}

export function createWebGpuAdaptiveThresholdRgbaRunner({
  device,
  gpuBufferUsage = globalThis.GPUBufferUsage,
  gpuMapMode = globalThis.GPUMapMode,
  label = "pdf2md-ocr-preprocess-adaptive-threshold-rgba",
  workgroupSize = defaultWorkgroupSize
} = {}) {
  validateWebGpuDevice(device);
  const usages = gpuBufferUsage ?? defaultGpuBufferUsage;
  const mapModes = gpuMapMode ?? defaultGpuMapMode;
  const normalizedWorkgroupSize = normalizePositiveInteger(workgroupSize, defaultWorkgroupSize);
  const shaderModule = device.createShaderModule({
    label: `${label}-shader`,
    code: createAdaptiveThresholdRgbaShaderSource({ workgroupSize: normalizedWorkgroupSize })
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
    async run(
      rgba,
      {
        bias = defaultAdaptiveBias,
        height,
        radius = defaultAdaptiveRadius,
        width
      } = {}
    ) {
      const input = normalizeRgbaInput(rgba);
      const geometry = normalizeImageGeometry(input, { height, width });
      const inputWords = packRgbaWords(input);
      const size = inputWords.byteLength;
      const normalizedRadius = normalizePositiveInteger(radius, defaultAdaptiveRadius);
      const normalizedBias = normalizeAdaptiveBias(bias);
      const dispatch = createDispatchPlan(inputWords.length, {
        maxWorkgroupsPerDimension: readMaxComputeWorkgroupsPerDimension(device),
        workgroupSize: normalizedWorkgroupSize
      });
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
        size: 32,
        usage: usages.STORAGE | usages.COPY_DST
      });
      const readbackBuffer = device.createBuffer({
        label: `${label}-readback`,
        size,
        usage: usages.MAP_READ | usages.COPY_DST
      });
      let readbackMapped = false;

      try {
        device.queue.writeBuffer(inputBuffer, 0, inputWords);
        device.queue.writeBuffer(
          paramsBuffer,
          0,
          new Uint32Array([
            inputWords.length,
            geometry.width,
            geometry.height,
            normalizedRadius,
            normalizedBias >>> 0,
            dispatch.workgroupsPerRow,
            0,
            0
          ])
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
        pass.dispatchWorkgroups(dispatch.workgroupsPerRow, dispatch.rows);
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, size);
        device.queue.submit([encoder.finish()]);

        await readbackBuffer.mapAsync(mapModes.READ);
        readbackMapped = true;
        const mapped = readbackBuffer.getMappedRange();
        const outputWords = new Uint32Array(mapped.slice(0));
        return unpackRgbaWords(outputWords, input.length);
      } finally {
        try {
          if (readbackMapped) {
            readbackBuffer.unmap();
          }
        } finally {
          destroyBuffers([inputBuffer, outputBuffer, paramsBuffer, readbackBuffer]);
        }
      }
    }
  };
}

export async function binarizeRgbaWithWebGpu(options = {}) {
  const runner = createWebGpuBinarizeRgbaRunner(options);
  return runner.run(options.rgba, { threshold: options.threshold });
}

export async function adaptiveThresholdRgbaWithWebGpu(options = {}) {
  const runner = createWebGpuAdaptiveThresholdRgbaRunner(options);
  return runner.run(options.rgba, {
    bias: options.bias,
    height: options.height,
    radius: options.radius,
    width: options.width
  });
}

export async function createWebGpuPreprocessingDiagnostics({
  execution = null,
  options = {},
  webgpu = null
} = {}) {
  const preprocessingOptions = options.preprocessing ?? {};
  const workload = normalizeWorkload(preprocessingOptions.workload);
  const threshold = normalizeThreshold(preprocessingOptions.threshold ?? defaultThreshold);
  const radius = normalizePositiveInteger(preprocessingOptions.radius, defaultAdaptiveRadius);
  const bias = normalizeAdaptiveBias(preprocessingOptions.bias);
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
    workload: `ocr-preprocess-${workload}`,
    threshold,
    radius,
    bias,
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
    runner = preprocessingOptions.runner ?? createRunnerFromDevice(options.device, { workload });
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
    const sample = createPreprocessingSample(
      Math.min(page.pixelCount, maxSamplePixelsPerPage),
      page.pageIndex
    );
    const input = sample.rgba;
    const workloadOptions = {
      bias,
      height: sample.height,
      page,
      radius,
      threshold,
      width: sample.width
    };
    const cpuStartedAt = nowMs();
    const expected = runCpuPreprocessing(input, { workload, ...workloadOptions });
    const cpuMs = nowMs() - cpuStartedAt;
    const gpuStartedAt = nowMs();
    let actual;
    try {
      actual = await runner.run(input, workloadOptions);
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
      samplePixels: sample.pixelCount,
      sampleWidth: sample.width,
      sampleHeight: sample.height,
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

function normalizeAdaptiveBias(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return defaultAdaptiveBias;
  }
  return Math.max(minAdaptiveBias, Math.min(maxAdaptiveBias, Math.round(number)));
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeWorkload(value) {
  return value === adaptiveThresholdWorkload ? adaptiveThresholdWorkload : binarizeWorkload;
}

function normalizeImageGeometry(rgba, { height, width } = {}) {
  const normalizedWidth = normalizePositiveInteger(width, 0);
  const normalizedHeight = normalizePositiveInteger(height, 0);
  const pixelCount = rgba.length / 4;
  if (normalizedWidth <= 0 || normalizedHeight <= 0) {
    throw new Error("width and height are required for adaptive RGBA preprocessing");
  }
  if (normalizedWidth * normalizedHeight !== pixelCount) {
    throw new Error("width and height must match the RGBA pixel count");
  }
  return {
    height: normalizedHeight,
    pixelCount,
    width: normalizedWidth
  };
}

function readMaxComputeWorkgroupsPerDimension(device) {
  return normalizePositiveInteger(device?.limits?.maxComputeWorkgroupsPerDimension, 65_535);
}

function createDispatchPlan(itemCount, { maxWorkgroupsPerDimension, workgroupSize }) {
  const totalWorkgroups = Math.ceil(itemCount / workgroupSize);
  const workgroupsPerRow = Math.min(totalWorkgroups, maxWorkgroupsPerDimension);
  const rows = Math.ceil(totalWorkgroups / workgroupsPerRow);
  if (rows > maxWorkgroupsPerDimension) {
    throw new Error(
      `WebGPU dispatch requires ${rows} rows, exceeding maxComputeWorkgroupsPerDimension=${maxWorkgroupsPerDimension}`
    );
  }
  return {
    workgroupsPerRow,
    rows
  };
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

function createRunnerFromDevice(device, { workload }) {
  if (!device) {
    return null;
  }
  if (workload === adaptiveThresholdWorkload) {
    return createWebGpuAdaptiveThresholdRgbaRunner({ device });
  }
  return createWebGpuBinarizeRgbaRunner({ device });
}

function runCpuPreprocessing(rgba, { workload, ...options }) {
  if (workload === adaptiveThresholdWorkload) {
    return adaptiveThresholdRgbaCpu(rgba, options);
  }
  return binarizeRgbaCpu(rgba, options);
}

function createPreprocessingSample(pixelCount, seed = 0) {
  const geometry = createSampleGeometry(pixelCount);
  return {
    ...geometry,
    rgba: createDeterministicRgbaSample(geometry.pixelCount, seed)
  };
}

function createSampleGeometry(pixelCount) {
  const maxPixels = normalizePositiveInteger(pixelCount, 1);
  const width = Math.max(1, Math.floor(Math.sqrt(maxPixels)));
  const height = Math.max(1, Math.floor(maxPixels / width));
  return {
    height,
    pixelCount: width * height,
    width
  };
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
