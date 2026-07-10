import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const defaultPixels = 589_824;
const defaultIterations = 1;
const defaultWarmup = 1;
const defaultMinSpeedup = 1.05;
const defaultTimeoutMs = 60_000;
const defaultShutdownGraceMs = 2_000;
const defaultShutdownKillWaitMs = 2_000;
const adaptiveThresholdWorkload = "adaptive-threshold-rgba";
const binarizeWorkload = "binarize-rgba";
const defaultWorkload = adaptiveThresholdWorkload;
const defaultAdaptiveRadius = 12;
const defaultAdaptiveBias = 7;

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

function readWorkloadOption() {
  const workload = readOption("--workload") ?? defaultWorkload;
  if (workload === adaptiveThresholdWorkload || workload === binarizeWorkload) {
    return workload;
  }
  return defaultWorkload;
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

function createPageHtml({ bias, iterations, minSpeedup, pixels, radius, warmup, workload }) {
  return `<!doctype html>
<body>pending</body>
<script type="module">
import {
  adaptiveThresholdRgbaCpu,
  binarizeRgbaCpu,
  createWebGpuAdaptiveThresholdRgbaRunner,
  createWebGpuBinarizeRgbaRunner
} from "/packages/pdf2md/src/webgpu-preprocess.mjs";

const config = ${JSON.stringify({
    bias,
    iterations,
    minSpeedup,
    pixels,
    radius,
    warmup,
    workload
  })};

function createGeometry(pixelCount) {
  const width = Math.max(1, Math.floor(Math.sqrt(pixelCount)));
  const height = Math.max(1, Math.floor(pixelCount / width));
  return {
    height,
    pixelCount: width * height,
    width
  };
}

function createInput(pixelCount) {
  const geometry = createGeometry(pixelCount);
  const rgba = new Uint8Array(geometry.pixelCount * 4);
  for (let pixel = 0; pixel < geometry.pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const value = (pixel * 13 + (pixel >>> 8)) & 255;
    rgba[offset] = value;
    rgba[offset + 1] = (value * 3) & 255;
    rgba[offset + 2] = (255 - value) & 255;
    rgba[offset + 3] = 255;
  }
  return { ...geometry, rgba };
}

function arraysEqual(left, right) {
  return findMismatch(left, right) === null;
}

function findMismatch(left, right) {
  if (left.length !== right.length) {
    return {
      index: -1,
      leftLength: left.length,
      rightLength: right.length
    };
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return {
        index,
        actual: right[index],
        expected: left[index]
      };
    }
  }
  return null;
}

function countMismatches(left, right) {
  if (left.length !== right.length) {
    return Math.max(left.length, right.length);
  }
  let count = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      count += 1;
    }
  }
  return count;
}

function findMismatchPixels(left, right, limit = 10) {
  const pixels = [];
  const byteLength = Math.min(left.length, right.length);
  for (let index = 0; index < byteLength; index += 4) {
    if (
      left[index] !== right[index] ||
      left[index + 1] !== right[index + 1] ||
      left[index + 2] !== right[index + 2] ||
      left[index + 3] !== right[index + 3]
    ) {
      pixels.push({
        actual: [right[index], right[index + 1], right[index + 2], right[index + 3]],
        expected: [left[index], left[index + 1], left[index + 2], left[index + 3]],
        pixelIndex: index / 4
      });
      if (pixels.length >= limit) {
        break;
      }
    }
  }
  return pixels;
}

function createWorkloadOptions(sample) {
  if (config.workload === "${adaptiveThresholdWorkload}") {
    return {
      bias: config.bias,
      height: sample.height,
      radius: config.radius,
      width: sample.width
    };
  }
  return {};
}

function runCpu(input, options) {
  if (config.workload === "${adaptiveThresholdWorkload}") {
    return adaptiveThresholdRgbaCpu(input, options);
  }
  return binarizeRgbaCpu(input);
}

function createRunner(device) {
  if (config.workload === "${adaptiveThresholdWorkload}") {
    return createWebGpuAdaptiveThresholdRgbaRunner({ device });
  }
  return createWebGpuBinarizeRgbaRunner({ device });
}

function measureCpu(input, options) {
  const startedAt = performance.now();
  for (let index = 0; index < config.iterations; index += 1) {
    runCpu(input, options);
  }
  return performance.now() - startedAt;
}

async function measureGpu(runner, input, options) {
  const startedAt = performance.now();
  for (let index = 0; index < config.iterations; index += 1) {
    await runner.run(input, options);
  }
  return performance.now() - startedAt;
}

async function main() {
  const base = {
    benchmark: "webgpu-ocr-preprocess-" + config.workload,
    pixels: config.pixels,
    iterations: config.iterations,
    warmup: config.warmup,
    workload: config.workload,
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
  const runner = createRunner(device);
  const sample = createInput(config.pixels);
  const input = sample.rgba;
  const options = createWorkloadOptions(sample);
  const expected = runCpu(input, options);
  for (let index = 0; index < config.warmup; index += 1) {
    await runner.run(input, options);
  }
  const actual = await runner.run(input, options);
  const mismatch = findMismatch(expected, actual);
  const parity = mismatch === null;
  const cpuMs = measureCpu(input, options);
  const gpuMs = await measureGpu(runner, input, options);
  const speedupRatio = gpuMs > 0 ? cpuMs / gpuMs : null;
  device.destroy?.();
  return {
    ...base,
    sampleHeight: sample.height,
    sampleWidth: sample.width,
    selectedProvider: "webgpu",
    status: parity && speedupRatio >= config.minSpeedup ? "passed" : "failed",
    reason: parity ? "speedup-threshold" : "parity-mismatch",
    parity,
    mismatch,
    mismatchCount: countMismatches(expected, actual),
    mismatchPixels: findMismatchPixels(expected, actual),
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

async function runChrome(chrome, url, { timeoutMs = defaultTimeoutMs } = {}) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "pdf2md-webgpu-chrome-"));
  const chromeArgs = [
    "--headless=new",
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,WebGPU,UnsafeWebGPU",
    "--ignore-gpu-blocklist",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-vulkan-surface",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    url
  ];
  const child = spawn(chrome.path, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  let stdout = "";
  let stderr = "";
  let exitStatus = null;
  let stopRequested = false;
  const stop = async () => {
    if (!stopRequested) {
      stopRequested = true;
      exitStatus = await stopChrome(child);
    }
    return exitStatus;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const port = await waitForDevToolsPort({
      child,
      getStderr: () => stderr,
      timeoutMs
    });
    const page = await waitForPageTarget(port, url, timeoutMs);
    const summary = await waitForPageSummary(page.webSocketDebuggerUrl, timeoutMs);
    exitStatus = await stop();
    return { status: exitStatus, stdout, stderr, summary };
  } finally {
    await stop();
    await rm(userDataDir, { force: true, recursive: true });
  }
}

function waitForDevToolsPort({ child, getStderr, timeoutMs }) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("close", onClose);
      callback(value);
    };
    const check = () => {
      const match = getStderr().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        finish(resolve, Number(match[1]));
      }
    };
    const onData = () => check();
    const onClose = (status) => {
      finish(
        reject,
        new Error(`Chrome exited before DevTools was available; status=${status}`)
      );
    };
    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(`Timed out waiting ${Date.now() - startedAt}ms for Chrome DevTools`)
      );
    }, timeoutMs);
    child.stderr.on("data", onData);
    child.on("close", onClose);
    check();
  });
}

async function waitForPageTarget(port, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    lastTargets = await response.json();
    const page = lastTargets.find(
      (target) =>
        target.type === "page" &&
        target.url === url &&
        typeof target.webSocketDebuggerUrl === "string"
    );
    if (page) {
      return page;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for Chrome page target; targets=${JSON.stringify(lastTargets)}`
  );
}

async function waitForPageSummary(webSocketDebuggerUrl, timeoutMs) {
  const cdp = await connectCdp(webSocketDebuggerUrl);
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  try {
    await cdp.send("Runtime.enable");
    while (Date.now() < deadline) {
      const response = await cdp.send("Runtime.evaluate", {
        expression: "document.body.textContent",
        returnByValue: true
      });
      lastText = String(response.result?.value ?? "").trim();
      if (lastText.startsWith("{")) {
        return JSON.parse(lastText);
      }
      await delay(100);
    }
  } finally {
    cdp.close();
  }
  throw new Error(`Timed out waiting for page summary; lastBody=${lastText}`);
}

function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((sendResolve, sendReject) => {
            pending.set(id, { resolve: sendResolve, reject: sendReject });
          });
        },
        close() {
          socket.close();
        }
      });
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? "CDP request failed"));
        return;
      }
      request.resolve(message.result ?? {});
    });
    socket.addEventListener("error", () => {
      reject(new Error("Chrome DevTools WebSocket failed"));
    }, { once: true });
    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        request.reject(new Error("Chrome DevTools WebSocket closed"));
      }
      pending.clear();
    });
  });
}

export function stopChrome(
  child,
  {
    gracePeriodMs = defaultShutdownGraceMs,
    killWaitMs = defaultShutdownKillWaitMs
  } = {}
) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;
    const finish = (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("close", finish);
      resolve(status);
    };
    const forceKill = () => {
      if (child.exitCode !== null) {
        finish(child.exitCode);
        return;
      }
      timeout = setTimeout(() => finish(child.exitCode), killWaitMs);
      child.kill("SIGKILL");
    };
    child.once("close", finish);
    timeout = setTimeout(forceKill, gracePeriodMs);
    child.kill("SIGTERM");
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    `${prefix} webgpu preprocessing workload=${summary.workload} provider=${summary.selectedProvider} parity=${summary.parity} speedup=${formatNumber(summary.speedupRatio)} min=${summary.minSpeedup}`
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
  const timeoutMs = readPositiveIntegerOption("--timeout-ms", defaultTimeoutMs);
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
    bias: readPositiveNumberOption("--bias", defaultAdaptiveBias),
    iterations: readPositiveIntegerOption("--iterations", defaultIterations),
    minSpeedup: readPositiveNumberOption("--min-speedup", defaultMinSpeedup),
    pixels: readPositiveIntegerOption("--pixels", defaultPixels),
    radius: readPositiveIntegerOption("--radius", defaultAdaptiveRadius),
    warmup: readPositiveIntegerOption("--warmup", defaultWarmup),
    workload: readWorkloadOption()
  });
  const server = await startServer(repoRoot, pageHtml);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const result = await runChrome(chrome, url, { timeoutMs });
    const summary = {
      ...result.summary,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
