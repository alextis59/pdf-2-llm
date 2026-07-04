const defaultWasmUrl = new URL("./wasm/pdf2md_core.wasm", import.meta.url);
const sharedMemoryProbe = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x03,
  0x01, 0x01
]);

export async function loadPdf2mdCoreWasm(options = {}) {
  const plan = resolveWasmLoadPlan(options);
  const imports = isSourceLike(options) ? {} : options.imports ?? {};
  const instance = await instantiateWasm(plan.source, imports);
  return createPdf2mdCore(instance.exports, plan.threading);
}

export function detectWasmThreadSupport(environment = globalThis) {
  const webAssembly = environment.WebAssembly ?? WebAssembly;
  const sharedArrayBuffer = typeof environment.SharedArrayBuffer === "function";
  const browserLike = environment.window === environment && typeof environment.document !== "undefined";
  const isolated = browserLike ? environment.crossOriginIsolated === true : true;
  const wasmSharedMemory =
    typeof webAssembly?.validate === "function" && webAssembly.validate(sharedMemoryProbe);
  const reasons = [];
  if (!sharedArrayBuffer) {
    reasons.push("shared-array-buffer-unavailable");
  }
  if (!isolated) {
    reasons.push("cross-origin-isolation-required");
  }
  if (!wasmSharedMemory) {
    reasons.push("wasm-shared-memory-unavailable");
  }
  return {
    supported: sharedArrayBuffer && isolated && wasmSharedMemory,
    sharedArrayBuffer,
    crossOriginIsolated: browserLike ? isolated : null,
    wasmSharedMemory,
    reasons
  };
}

export function resolveWasmLoadPlan(options = {}) {
  if (isSourceLike(options)) {
    return {
      source: options,
      threading: createThreadingDiagnostics({
        requested: "single",
        selected: "single",
        support: detectWasmThreadSupport()
      })
    };
  }

  const requested = normalizeThreadingMode(options.threading);
  const source = options.source ?? defaultWasmUrl;
  const support = options.threadSupport ?? detectWasmThreadSupport(options.environment ?? globalThis);
  if (requested === "single") {
    return {
      source,
      threading: createThreadingDiagnostics({ requested, selected: "single", support })
    };
  }
  if (!support.supported) {
    if (requested === "required") {
      throw new Error(`Threaded WASM requested but unsupported: ${support.reasons.join(", ")}`);
    }
    return {
      source,
      threading: createThreadingDiagnostics({
        requested,
        selected: "single",
        support,
        fallbackReason: support.reasons[0] ?? "threaded-wasm-unsupported"
      })
    };
  }
  if (!options.threadedSource) {
    if (requested === "required") {
      throw new Error("Threaded WASM requested but no threadedSource was provided.");
    }
    return {
      source,
      threading: createThreadingDiagnostics({
        requested,
        selected: "single",
        support,
        fallbackReason: "threaded-source-unavailable"
      })
    };
  }
  return {
    source: options.threadedSource,
    threading: createThreadingDiagnostics({ requested, selected: "threaded", support })
  };
}

async function instantiateWasm(source, imports) {
  if (source instanceof WebAssembly.Module) {
    return new WebAssembly.Instance(source, imports);
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const bytes = source instanceof ArrayBuffer
      ? source
      : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    return (await WebAssembly.instantiate(bytes, imports)).instance;
  }
  if (isResponse(source)) {
    return instantiateResponse(source, imports);
  }
  if (isFileUrlSource(source)) {
    return instantiateFileUrl(source, imports);
  }
  if (typeof fetch !== "function") {
    throw new TypeError("A URL or path source requires fetch support in this runtime.");
  }
  const response = await fetch(source);
  return instantiateResponse(response, imports);
}

async function instantiateFileUrl(source, imports) {
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import("node:fs/promises"),
    import("node:url")
  ]);
  const bytes = await readFile(fileURLToPath(source));
  return (await WebAssembly.instantiate(bytes, imports)).instance;
}

async function instantiateResponse(response, imports) {
  if (!response.ok) {
    throw new Error(`WASM request failed with HTTP ${response.status}`);
  }
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try {
      return (await WebAssembly.instantiateStreaming(response.clone(), imports)).instance;
    } catch {
      // Some dev servers do not serve application/wasm. Fall back to bytes so
      // examples still work while preserving streaming for correctly served assets.
    }
  }
  return (await WebAssembly.instantiate(await response.arrayBuffer(), imports)).instance;
}

function createPdf2mdCore(exports, threading) {
  const required = [
    "memory",
    "pdf2md_alloc",
    "pdf2md_dealloc",
    "pdf2md_has_pdf_header",
    "pdf2md_core_version_major",
    "pdf2md_core_version_minor",
    "pdf2md_core_version_patch"
  ];
  for (const name of required) {
    if (!exports[name]) {
      throw new Error(`WASM export missing: ${name}`);
    }
  }

  return Object.freeze({
    threading,
    version() {
      return [
        exports.pdf2md_core_version_major(),
        exports.pdf2md_core_version_minor(),
        exports.pdf2md_core_version_patch()
      ].join(".");
    },
    hasPdfHeader(input) {
      const bytes = toBytes(input);
      if (bytes.byteLength === 0) {
        return false;
      }
      const ptr = exports.pdf2md_alloc(bytes.byteLength);
      if (!Number.isInteger(ptr) || ptr <= 0) {
        throw new Error("WASM allocation failed.");
      }
      try {
        new Uint8Array(exports.memory.buffer, ptr, bytes.byteLength).set(bytes);
        return exports.pdf2md_has_pdf_header(ptr, bytes.byteLength) === 1;
      } finally {
        exports.pdf2md_dealloc(ptr, bytes.byteLength);
      }
    }
  });
}

function normalizeThreadingMode(threading) {
  if (threading === true || threading === "auto") {
    return "auto";
  }
  if (threading === "required") {
    return "required";
  }
  return "single";
}

function createThreadingDiagnostics({ requested, selected, support, fallbackReason }) {
  return Object.freeze({
    requested,
    selected,
    supported: support.supported,
    sharedArrayBuffer: support.sharedArrayBuffer,
    crossOriginIsolated: support.crossOriginIsolated,
    wasmSharedMemory: support.wasmSharedMemory,
    fallbackReason: fallbackReason ?? null,
    reasons: Object.freeze([...(support.reasons ?? [])])
  });
}

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("WASM PDF preflight expects ArrayBuffer or Uint8Array input.");
}

function isSourceLike(value) {
  return (
    typeof value === "string" ||
    value instanceof URL ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof WebAssembly.Module ||
    isResponse(value)
  );
}

function isFileUrlSource(value) {
  if (value instanceof URL) {
    return value.protocol === "file:";
  }
  return typeof value === "string" && value.startsWith("file:");
}

function isResponse(value) {
  return typeof Response !== "undefined" && value instanceof Response;
}
