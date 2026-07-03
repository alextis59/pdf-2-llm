import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const defaultPixels = 4_194_304;
const defaultIterations = 3;
const defaultWarmup = 1;
const defaultMinSpeedup = 1.05;

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function readPositiveIntegerOption(name, fallback) {
  const parsed = Number.parseInt(readOption(name) ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveNumberOption(name, fallback) {
  const parsed = Number.parseFloat(readOption(name) ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status === 0) {
      return {
        path: candidate,
        version: result.stdout.trim()
      };
    }
  }
  return null;
}

async function startServer(repoRoot, pageHtml) {
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/packages/pdf2md/src/webgpu-preprocess.mjs")) {
        const source = await readFile(
          path.join(repoRoot, "packages", "pdf2md", "src", "webgpu-preprocess.mjs"),
          "utf8"
        );
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(source);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error?.stack ?? error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function createPageHtml({ iterations, minSpeedup, pixels, warmup }) {
  return `<!doctype html>
<body>pending</body>
<script type="module">
import {
  binarizeRgbaCpu,
  createWebGpuBinarizeRgbaRunner
} from "/packages/pdf2md/src/webgpu-preprocess.mjs";

const config = ${JSON.stringify({ iterations, minSpeedup, pixels, warmup })};

function createInput(pixelCount) {
  const rgba = new Uint8Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const value = (pixel * 13 + (pixel >>> 8)) & 255;
    rgba[offset] = value;
    rgba[offset + 1] = (value * 3) & 255;
    rgba[offset + 2] = (255 - value) & 255;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function measureCpu(input) {
  const startedAt = performance.now();
  for (let index = 0; index < config.iterations; index += 1) {
    binarizeRgbaCpu(input);
  }
  return performance.now() - startedAt;
}

async function measureGpu(runner, input) {
  const startedAt = performance.now();
  for (let index = 0; index < config.iterations; index += 1) {
    await runner.run(input);
  }
  return performance.now() - startedAt;
}

async function main() {
  const base = {
    benchmark: "webgpu-ocr-preprocess-binarize-rgba",
    pixels: config.pixels,
    iterations: config.iterations,
    warmup: config.warmup,
    minSpeedup: config.minSpeedup,
    isSecureContext,
    hasNavigatorGpu: !!navigator.gpu,
    selectedProvider: "cpu",
    status: "not-applicable",
    reason: null
  };

  if (!navigator.gpu) {
    return { ...base, reason: "navigator-gpu-missing" };
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    return { ...base, reason: "adapter-unavailable" };
  }
  const device = await adapter.requestDevice();
  const runner = createWebGpuBinarizeRgbaRunner({ device });
  const input = createInput(config.pixels);
  const expected = binarizeRgbaCpu(input);
  for (let index = 0; index < config.warmup; index += 1) {
    await runner.run(input);
  }
  const actual = await runner.run(input);
  const parity = arraysEqual(expected, actual);
  const cpuMs = measureCpu(input);
  const gpuMs = await measureGpu(runner, input);
  const speedupRatio = gpuMs > 0 ? cpuMs / gpuMs : null;
  device.destroy?.();
  return {
    ...base,
    selectedProvider: "webgpu",
    status: parity && speedupRatio >= config.minSpeedup ? "passed" : "failed",
    reason: parity ? "speedup-threshold" : "parity-mismatch",
    parity,
    cpuMs,
    gpuMs,
    speedupRatio
  };
}

main()
  .then((result) => {
    document.body.textContent = JSON.stringify(result);
  })
  .catch((error) => {
    document.body.textContent = JSON.stringify({
      benchmark: "webgpu-ocr-preprocess-binarize-rgba",
      status: "failed",
      selectedProvider: "webgpu",
      reason: "benchmark-error",
      error: {
        name: error.name ?? "Error",
        message: error.message ?? String(error)
      }
    });
  });
</script>`;
}

async function runChrome(chrome, url) {
  const chromeArgs = [
    "--headless=new",
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,WebGPU,UnsafeWebGPU",
    "--ignore-gpu-blocklist",
    "--disable-dev-shm-usage",
    "--virtual-time-budget=30000",
    url,
    "--dump-dom"
  ];
  return new Promise((resolve) => {
    const child = spawn(chrome.path, chromeArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function parseDumpedDom(stdout) {
  const match = stdout.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error("Chrome output did not contain a body element");
  }
  const text = match[1].replace(/<script[\s\S]*$/i, "").trim();
  return JSON.parse(text);
}

async function writeSummary(summaryPath, summary) {
  if (!summaryPath) {
    return;
  }
  const resolved = path.resolve(summaryPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(summary, null, 2)}\n`);
}

function printSummary(summary) {
  if (summary.status === "not-applicable") {
    console.log(`SKIP webgpu preprocessing status=not-applicable reason=${summary.reason}`);
    return;
  }
  const prefix = summary.status === "passed" ? "PASS" : "FAIL";
  console.log(
    `${prefix} webgpu preprocessing provider=${summary.selectedProvider} parity=${summary.parity} speedup=${formatNumber(summary.speedupRatio)} min=${summary.minSpeedup}`
  );
}

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
    : "n/a";
}

async function main() {
  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const summaryPath = readOption("--summary");
  const chrome = findChrome();
  if (!chrome) {
    const summary = {
      benchmark: "webgpu-ocr-preprocess-binarize-rgba",
      status: "not-applicable",
      selectedProvider: "cpu",
      reason: "chrome-unavailable"
    };
    await writeSummary(summaryPath, summary);
    printSummary(summary);
    if (hasFlag("--require-speedup")) {
      process.exit(1);
    }
    return;
  }

  const pageHtml = createPageHtml({
    iterations: readPositiveIntegerOption("--iterations", defaultIterations),
    minSpeedup: readPositiveNumberOption("--min-speedup", defaultMinSpeedup),
    pixels: readPositiveIntegerOption("--pixels", defaultPixels),
    warmup: readPositiveIntegerOption("--warmup", defaultWarmup)
  });
  const server = await startServer(repoRoot, pageHtml);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const result = await runChrome(chrome, url);
    const pageSummary = parseDumpedDom(result.stdout);
    const summary = {
      ...pageSummary,
      chrome: chrome.version,
      chromeExitStatus: result.status,
      chromeStderr: result.stderr
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(0, 10)
    };
    await writeSummary(summaryPath, summary);
    printSummary(summary);
    if (
      summary.status === "failed" ||
      (hasFlag("--require-speedup") && summary.status !== "passed")
    ) {
      process.exit(1);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

await main();
