import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  detectWasmThreadSupport,
  loadPdf2mdCoreWasm,
  resolveWasmLoadPlan
} from "../src/wasm-loader.mjs";

const wasmPath = new URL("../src/wasm/pdf2md_core.wasm", import.meta.url);

test("loadPdf2mdCoreWasm exposes version and PDF header preflight", async () => {
  const wasmBytes = await readFile(wasmPath);
  const core = await loadPdf2mdCoreWasm(wasmBytes);

  assert.equal(core.version(), "0.0.0");
  assert.equal(core.threading.selected, "single");
  assert.equal(core.hasPdfHeader(new TextEncoder().encode("%PDF-1.7\n")), true);
  assert.equal(core.hasPdfHeader(new TextEncoder().encode("not a pdf")), false);
});

test("loadPdf2mdCoreWasm loads the bundled file URL source by default", async () => {
  const core = await loadPdf2mdCoreWasm();

  assert.equal(core.version(), "0.0.0");
  assert.equal(core.threading.selected, "single");
});

test("detectWasmThreadSupport reports missing browser isolation prerequisites", () => {
  const browserEnvironment = {
    WebAssembly,
    document: {},
    crossOriginIsolated: false
  };
  browserEnvironment.window = browserEnvironment;

  assert.deepEqual(
    detectWasmThreadSupport(browserEnvironment),
    {
      supported: false,
      sharedArrayBuffer: false,
      crossOriginIsolated: false,
      wasmSharedMemory: WebAssembly.validate(
        new Uint8Array([
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x03,
          0x01, 0x01
        ])
      ),
      reasons: ["shared-array-buffer-unavailable", "cross-origin-isolation-required"]
    }
  );
});

test("resolveWasmLoadPlan selects threaded source only behind support detection", () => {
  const supported = {
    supported: true,
    sharedArrayBuffer: true,
    crossOriginIsolated: true,
    wasmSharedMemory: true,
    reasons: []
  };
  const unsupported = {
    supported: false,
    sharedArrayBuffer: false,
    crossOriginIsolated: false,
    wasmSharedMemory: true,
    reasons: ["shared-array-buffer-unavailable"]
  };

  assert.deepEqual(resolveWasmLoadPlan({ source: "single", threadedSource: "threaded", threading: "auto", threadSupport: supported }), {
    source: "threaded",
    threading: {
      requested: "auto",
      selected: "threaded",
      supported: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: true,
      wasmSharedMemory: true,
      fallbackReason: null,
      reasons: []
    }
  });

  assert.deepEqual(resolveWasmLoadPlan({ source: "single", threadedSource: "threaded", threading: "auto", threadSupport: unsupported }), {
    source: "single",
    threading: {
      requested: "auto",
      selected: "single",
      supported: false,
      sharedArrayBuffer: false,
      crossOriginIsolated: false,
      wasmSharedMemory: true,
      fallbackReason: "shared-array-buffer-unavailable",
      reasons: ["shared-array-buffer-unavailable"]
    }
  });

  assert.throws(
    () => resolveWasmLoadPlan({ source: "single", threading: "required", threadSupport: unsupported }),
    /Threaded WASM requested but unsupported/
  );
});

test("loadPdf2mdCoreWasm instantiates a shared-memory threaded fixture and falls back", async () => {
  const wasmBytes = await readFile(wasmPath);
  const threadedModule = new WebAssembly.Module(sharedMemoryFixtureBytes());
  assert.deepEqual(WebAssembly.Module.imports(threadedModule), [
    { module: "env", name: "memory", kind: "memory" }
  ]);
  assert.deepEqual(
    WebAssembly.Module.exports(threadedModule),
    [
      ["memory", "memory"],
      ["pdf2md_alloc", "function"],
      ["pdf2md_dealloc", "function"],
      ["pdf2md_has_pdf_header", "function"],
      ["pdf2md_core_version_major", "function"],
      ["pdf2md_core_version_minor", "function"],
      ["pdf2md_core_version_patch", "function"]
    ].map(([name, kind]) => ({ name, kind }))
  );

  const sharedMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.equal(sharedMemory.buffer instanceof SharedArrayBuffer, true);
  const core = await loadPdf2mdCoreWasm({
    source: wasmBytes,
    threadedSource: threadedModule,
    threading: "auto",
    imports: { env: { memory: sharedMemory } },
    threadSupport: {
      supported: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: null,
      wasmSharedMemory: true,
      reasons: []
    }
  });

  assert.equal(core.threading.selected, "threaded");
  assert.equal(core.version(), "1.2.3");
  assert.equal(core.hasPdfHeader(new TextEncoder().encode("fixture input")), true);

  await assert.rejects(
    () =>
      loadPdf2mdCoreWasm({
        source: wasmBytes,
        threadedSource: threadedModule,
        threading: "required",
        imports: {
          env: { memory: new WebAssembly.Memory({ initial: 1, maximum: 1 }) }
        },
        threadSupport: {
          supported: true,
          sharedArrayBuffer: true,
          crossOriginIsolated: null,
          wasmSharedMemory: true,
          reasons: []
        }
      }),
    WebAssembly.LinkError
  );

  const fallback = await loadPdf2mdCoreWasm({
    source: wasmBytes,
    threadedSource: threadedModule,
    threading: "auto",
    threadSupport: {
      supported: false,
      sharedArrayBuffer: false,
      crossOriginIsolated: false,
      wasmSharedMemory: true,
      reasons: ["shared-array-buffer-unavailable"]
    }
  });
  assert.equal(fallback.threading.selected, "single");
  assert.equal(fallback.threading.fallbackReason, "shared-array-buffer-unavailable");
  assert.equal(fallback.version(), "0.0.0");
});

function sharedMemoryFixtureBytes() {
  const types = [
    4,
    0x60, 1, 0x7f, 1, 0x7f,
    0x60, 2, 0x7f, 0x7f, 0,
    0x60, 2, 0x7f, 0x7f, 1, 0x7f,
    0x60, 0, 1, 0x7f
  ];
  const memoryImport = [
    1,
    ...wasmName("env"),
    ...wasmName("memory"),
    2,
    3, 1, 1
  ];
  const functions = [6, 0, 1, 2, 3, 3, 3];
  const exports = [
    7,
    ...wasmExport("memory", 2, 0),
    ...wasmExport("pdf2md_alloc", 0, 0),
    ...wasmExport("pdf2md_dealloc", 0, 1),
    ...wasmExport("pdf2md_has_pdf_header", 0, 2),
    ...wasmExport("pdf2md_core_version_major", 0, 3),
    ...wasmExport("pdf2md_core_version_minor", 0, 4),
    ...wasmExport("pdf2md_core_version_patch", 0, 5)
  ];
  const code = [
    6,
    ...wasmFunctionBody([0x41, 8]),
    ...wasmFunctionBody([]),
    ...wasmFunctionBody([0x41, 1]),
    ...wasmFunctionBody([0x41, 1]),
    ...wasmFunctionBody([0x41, 2]),
    ...wasmFunctionBody([0x41, 3])
  ];
  return new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...wasmSection(1, types),
    ...wasmSection(2, memoryImport),
    ...wasmSection(3, functions),
    ...wasmSection(7, exports),
    ...wasmSection(10, code)
  ]);
}

function wasmSection(id, payload) {
  return [id, ...wasmU32(payload.length), ...payload];
}

function wasmName(value) {
  const bytes = new TextEncoder().encode(value);
  return [...wasmU32(bytes.length), ...bytes];
}

function wasmExport(name, kind, index) {
  return [...wasmName(name), kind, ...wasmU32(index)];
}

function wasmFunctionBody(instructions) {
  const body = [0, ...instructions, 0x0b];
  return [...wasmU32(body.length), ...body];
}

function wasmU32(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}
