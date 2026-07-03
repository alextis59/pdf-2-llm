export type Pdf2mdCoreWasm = {
  threading: WasmThreadingDiagnostics;
  version(): string;
  hasPdfHeader(input: ArrayBuffer | Uint8Array): boolean;
};

export type WasmThreadingMode = boolean | "single" | "auto" | "required";

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
  source?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module | Response;
  threadedSource?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module | Response;
  threading?: WasmThreadingMode;
  imports?: WebAssembly.Imports;
};

export declare function loadPdf2mdCoreWasm(
  options?: LoadPdf2mdCoreWasmOptions | LoadPdf2mdCoreWasmOptions["source"]
): Promise<Pdf2mdCoreWasm>;

export declare function detectWasmThreadSupport(environment?: unknown): WasmThreadSupport;
