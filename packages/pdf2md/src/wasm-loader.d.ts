export type Pdf2mdCoreWasm = {
  threading: WasmThreadingDiagnostics;
  version(): string;
  hasPdfHeader(input: ArrayBuffer | ArrayBufferView): boolean;
};

export type WasmThreadingMode = boolean | "single" | "auto" | "required";

export type WasmSource =
  | string
  | URL
  | ArrayBuffer
  | ArrayBufferView
  | WebAssembly.Module
  | Response;

export type WasmThreadSupport = {
  supported: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean | null;
  wasmSharedMemory: boolean;
  reasons: string[];
};

export type WasmThreadingDiagnostics = {
  requested: "single" | "auto" | "required";
  selected: "single" | "threaded";
  supported: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean | null;
  wasmSharedMemory: boolean;
  fallbackReason: string | null;
  reasons: string[];
};

export type LoadPdf2mdCoreWasmOptions = {
  source?: WasmSource;
  threadedSource?: WasmSource;
  threading?: WasmThreadingMode;
  threadSupport?: WasmThreadSupport;
  environment?: unknown;
  imports?: WebAssembly.Imports;
};

export type WasmLoadPlan = {
  source: WasmSource;
  threading: WasmThreadingDiagnostics;
};

export declare function loadPdf2mdCoreWasm(
  options?: LoadPdf2mdCoreWasmOptions | WasmSource
): Promise<Pdf2mdCoreWasm>;

export declare function detectWasmThreadSupport(environment?: unknown): WasmThreadSupport;

export declare function resolveWasmLoadPlan(
  options?: LoadPdf2mdCoreWasmOptions | WasmSource
): WasmLoadPlan;
