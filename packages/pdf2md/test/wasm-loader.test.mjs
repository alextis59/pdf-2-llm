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

test("loadPdf2mdCoreWasm can opt into a supported threaded source", async () => {
  const wasmBytes = await readFile(wasmPath);
  const core = await loadPdf2mdCoreWasm({
    source: new Uint8Array([0]),
    threadedSource: wasmBytes,
    threading: "auto",
    threadSupport: {
      supported: true,
      sharedArrayBuffer: true,
      crossOriginIsolated: null,
      wasmSharedMemory: true,
      reasons: []
    }
  });

  assert.equal(core.threading.selected, "threaded");
  assert.equal(core.version(), "0.0.0");
});
