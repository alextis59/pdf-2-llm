const cpuProvider = Object.freeze({
  id: "cpu",
  kind: "cpu",
  status: "fallback"
});

export async function detectWebGpuCapabilities(options = {}, environment = globalThis) {
  const required = options.required === true;
  const preferred = options.preferred === true;
  const requested = required ? "required" : preferred ? "preferred" : "disabled";
  const runtime = detectRuntime(environment);
  const browser = detectBrowserWebGpu(environment);

  if (!required && !preferred) {
    return createResult({
      browser,
      fallbackReason: "not-requested",
      requested,
      runtime,
      status: "disabled"
    });
  }

  if (options.device) {
    return {
      enabled: true,
      requested,
      runtime,
      status: "selected",
      selectedProvider: "webgpu",
      fallbackReason: null,
      browser: {
        supported: browser.supported,
        reason: browser.reason
      },
      provider: {
        id: "webgpu",
        kind: "gpu",
        status: "selected"
      },
      adapter: null,
      device: createDeviceDiagnostics("available", {
        source: "supplied"
      }),
      error: null
    };
  }

  if (runtime === "node") {
    return createResult({
      browser,
      fallbackReason: "node-stable-gpu-path-unavailable",
      requested,
      runtime,
      status: "fallback-cpu"
    });
  }

  if (!browser.supported) {
    return createResult({
      browser,
      fallbackReason: browser.reason,
      requested,
      runtime,
      status: "fallback-cpu"
    });
  }

  try {
    const adapter = await browser.gpu.requestAdapter?.({
      powerPreference: options.powerPreference ?? "high-performance"
    });
    if (!adapter) {
      return createResult({
        browser,
        fallbackReason: "adapter-unavailable",
        requested,
        runtime,
        status: "fallback-cpu"
      });
    }

    const device = await requestDeviceDiagnostics(adapter);
    if (device.status === "request-failed" || device.status === "lost") {
      return createResult({
        browser,
        device,
        error: device.error,
        fallbackReason: device.status === "lost" ? "device-lost" : "device-request-failed",
        requested,
        runtime,
        status: "fallback-cpu"
      });
    }

    return {
      enabled: true,
      requested,
      runtime,
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
      adapter: describeAdapter(adapter),
      device,
      error: null
    };
  } catch (error) {
    return createResult({
      browser,
      error,
      fallbackReason: "adapter-request-failed",
      requested,
      runtime,
      status: "fallback-cpu"
    });
  }
}

function createResult({
  browser,
  device = createDeviceDiagnostics("not-requested"),
  error = null,
  fallbackReason,
  requested,
  runtime,
  status
}) {
  return {
    enabled: false,
    requested,
    runtime,
    status,
    selectedProvider: "cpu",
    fallbackReason,
    browser: {
      supported: browser.supported,
      reason: browser.reason
    },
    provider: cpuProvider,
    adapter: null,
    device,
    error: error
      ? {
          name: error.name ?? "Error",
          message: error.message ?? String(error)
        }
      : null
  };
}

function detectRuntime(environment) {
  if (environment?.navigator && environment?.document) {
    return "browser";
  }
  if (environment?.process?.versions?.node) {
    return "node";
  }
  if (globalThis.process?.versions?.node) {
    return "node";
  }
  return "unknown";
}

function detectBrowserWebGpu(environment) {
  const gpu = environment?.navigator?.gpu ?? null;
  if (!gpu) {
    return {
      supported: false,
      reason: "navigator-gpu-missing",
      gpu: null
    };
  }
  if (typeof gpu.requestAdapter !== "function") {
    return {
      supported: false,
      reason: "request-adapter-missing",
      gpu
    };
  }
  return {
    supported: true,
    reason: null,
    gpu
  };
}

function describeAdapter(adapter) {
  return {
    name: stringOrNull(adapter.name),
    info: describeAdapterInfo(adapter.info),
    features: Array.from(adapter.features ?? []).sort(),
    limits: describeLimits(adapter.limits)
  };
}

async function requestDeviceDiagnostics(adapter) {
  if (typeof adapter.requestDevice !== "function") {
    return createDeviceDiagnostics("not-requested");
  }
  let device = null;
  try {
    device = await adapter.requestDevice();
    const lost = await alreadySettledDeviceLoss(device?.lost);
    if (lost) {
      return createDeviceDiagnostics("lost", {
        lostReason: stringOrNull(lost.reason),
        lostMessage: stringOrNull(lost.message)
      });
    }
    return createDeviceDiagnostics("available");
  } catch (error) {
    return createDeviceDiagnostics("request-failed", {
      error: {
        name: error.name ?? "Error",
        message: error.message ?? String(error)
      }
    });
  } finally {
    destroyDetectedDevice(device);
  }
}

function destroyDetectedDevice(device) {
  try {
    device?.destroy?.();
  } catch {
    // Capability diagnostics must remain stable even if a non-conforming probe throws on cleanup.
  }
}

async function alreadySettledDeviceLoss(lostPromise) {
  if (!lostPromise || typeof lostPromise.then !== "function") {
    return null;
  }
  const pending = Symbol("pending");
  const result = await Promise.race([lostPromise, Promise.resolve(pending)]);
  return result === pending ? null : result;
}

function createDeviceDiagnostics(status, details = {}) {
  return {
    status,
    source: details.source ?? "detected",
    lostReason: details.lostReason ?? null,
    lostMessage: details.lostMessage ?? null,
    error: details.error ?? null
  };
}

function describeAdapterInfo(info) {
  if (!info || typeof info !== "object") {
    return null;
  }
  return {
    vendor: stringOrNull(info.vendor),
    architecture: stringOrNull(info.architecture),
    device: stringOrNull(info.device),
    description: stringOrNull(info.description)
  };
}

function describeLimits(limits) {
  if (!limits || typeof limits !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(limits)
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
