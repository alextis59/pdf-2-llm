import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { loadPdf2mdCoreWasm } from "../src/wasm-loader.mjs";

const wasmPath = new URL("../src/wasm/pdf2md_core.wasm", import.meta.url);

test("loadPdf2mdCoreWasm exposes version and PDF header preflight", async () => {
  const wasmBytes = await readFile(wasmPath);
  const core = await loadPdf2mdCoreWasm(wasmBytes);

  assert.equal(core.version(), "0.0.0");
  assert.equal(core.hasPdfHeader(new TextEncoder().encode("%PDF-1.7\n")), true);
  assert.equal(core.hasPdfHeader(new TextEncoder().encode("not a pdf")), false);
});
