const defaultWasmUrl = new URL("./wasm/pdf2md_core.wasm", import.meta.url);

export async function loadPdf2mdCoreWasm(options = {}) {
  const source = isSourceLike(options) ? options : options.source ?? defaultWasmUrl;
  const imports = isSourceLike(options) ? {} : options.imports ?? {};
  const instance = await instantiateWasm(source, imports);
  return createPdf2mdCore(instance.exports);
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
  if (typeof fetch !== "function") {
    throw new TypeError("A URL or path source requires fetch support in this runtime.");
  }
  const response = await fetch(source);
  return instantiateResponse(response, imports);
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

function createPdf2mdCore(exports) {
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

function isResponse(value) {
  return typeof Response !== "undefined" && value instanceof Response;
}
