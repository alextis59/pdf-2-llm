export type Pdf2mdCoreWasm = {
  version(): string;
  hasPdfHeader(input: ArrayBuffer | Uint8Array): boolean;
};

export type LoadPdf2mdCoreWasmOptions = {
  source?: string | URL | ArrayBuffer | Uint8Array | WebAssembly.Module | Response;
  imports?: WebAssembly.Imports;
};

export declare function loadPdf2mdCoreWasm(
  options?: LoadPdf2mdCoreWasmOptions | LoadPdf2mdCoreWasmOptions["source"]
): Promise<Pdf2mdCoreWasm>;
