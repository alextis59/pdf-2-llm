# WebGPU Behavior And Fallback

WebGPU is an optional acceleration path. It is never required for Markdown
correctness. The converter always preserves a CPU-compatible output contract,
and unavailable WebGPU support falls back to CPU diagnostics instead of failing
conversion.

The current implementation performs:

- Runtime and browser WebGPU capability detection.
- Adapter and device health checks in browsers.
- OCR workload batch planning for scanned and hybrid pages.
- A browser WebGPU OCR-preprocessing binarization kernel for validation
  workloads.
- CPU parity diagnostics when WebGPU is unavailable or not requested.

The converter path does not yet materialize PDF raster image buffers, but it can
route OCR-preprocessing validation samples through the binarization kernel when
a browser caller supplies a `GPUDevice` or test runner. This keeps
caller-facing result shapes stable while browser OCR/layout acceleration is
incrementally wired in.

## Options

```js
const result = await convertPdfToMarkdown(bytes, {
  webgpu: {
    preferred: true,
    powerPreference: "high-performance",
    maxBatchPixels: 8_000_000,
    maxMemoryBytes: 256 * 1024 * 1024
  }
});
```

Supported options:

| Option | Default | Description |
| --- | --- | --- |
| `preferred` | `false` | Try WebGPU when available, otherwise use CPU. |
| `required` | `false` | Request WebGPU and emit `webgpu.unavailable` when CPU fallback is selected. |
| `powerPreference` | `"high-performance"` | Passed to `navigator.gpu.requestAdapter()` in browsers. |
| `maxBatchPixels` | `8000000` | Maximum planned pixels per WebGPU OCR batch. |
| `maxMemoryBytes` | `268435456` | Maximum planned bytes per page/batch for WebGPU OCR planning. |
| `device` | `undefined` | Advanced browser hook for supplying an already-created `GPUDevice`. |
| `preprocessing.enabled` | `true` | Controls conversion-routed OCR preprocessing diagnostics when WebGPU is selected. |
| `preprocessing.workload` | `"binarize-rgba"` | Selects `binarize-rgba` or compute-heavy `adaptive-threshold-rgba` diagnostics. |
| `preprocessing.threshold` | `128` | Binarization threshold used by WebGPU preprocessing samples. |
| `preprocessing.radius` | `8` | Adaptive threshold local-window radius. Border pixels use self-thresholding. |
| `preprocessing.bias` | `7` | Adaptive threshold bias added to the current pixel luma before comparison. |
| `preprocessing.maxSamplePixelsPerPage` | `262144` | Maximum deterministic sample pixels per routed OCR page. |
| `preprocessing.minSpeedup` | `1.05` | Minimum preprocessing speed ratio used for diagnostic pass/fail status. |
| `preprocessing.runner` | `undefined` | Test and integration hook for injecting a compatible preprocessing runner. |

`required` does not throw today. It records a structured warning if WebGPU
cannot be selected.

## Default CPU Path

Without `webgpu.preferred` or `webgpu.required`, diagnostics select CPU:

```json
{
  "enabled": false,
  "requested": "disabled",
  "status": "disabled",
  "selectedProvider": "cpu",
  "fallbackReason": "not-requested"
}
```

This is the normal path for server-side use and for browser applications that do
not opt into acceleration.

## Browser Selection

Browser WebGPU selection requires:

1. A browser runtime with `navigator.gpu`.
2. A callable `navigator.gpu.requestAdapter`.
3. A returned adapter.
4. A device request that succeeds.
5. A device that is not already lost during setup.

When all checks pass, diagnostics use:

```json
{
  "enabled": true,
  "requested": "preferred",
  "runtime": "browser",
  "status": "selected",
  "selectedProvider": "webgpu",
  "fallbackReason": null,
  "provider": {
    "id": "webgpu",
    "kind": "gpu",
    "status": "selected"
  }
}
```

Adapter diagnostics include optional adapter name, adapter info, sorted feature
names, and numeric limits. Device diagnostics report `available` when the
requested device is healthy.

## Supplied Device

Advanced browser callers may supply a concrete `GPUDevice`:

```js
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const result = await convertPdfToMarkdown(bytes, {
  raster: { enabled: true },
  webgpu: {
    preferred: true,
    device
  }
});
```

When a device is supplied, the converter selects `webgpu` before Node fallback
checks and records `device.source: "supplied"` in diagnostics. This path is
intended for browser or worker integrations that manage adapter/device lifetime
outside the converter.

## Node Behavior

Node currently falls back to CPU even if a process exposes experimental WebGPU
objects:

```json
{
  "runtime": "node",
  "status": "fallback-cpu",
  "selectedProvider": "cpu",
  "fallbackReason": "node-stable-gpu-path-unavailable"
}
```

This keeps Node behavior deterministic until a stable Node GPU execution path is
supported.

## CPU Fallback Reasons

Common fallback reasons:

| Reason | Meaning |
| --- | --- |
| `not-requested` | WebGPU was neither preferred nor required. |
| `node-stable-gpu-path-unavailable` | Runtime is Node and the stable GPU path is disabled. |
| `navigator-gpu-missing` | Browser-like runtime has no `navigator.gpu`. |
| `request-adapter-missing` | `navigator.gpu.requestAdapter` is not available. |
| `adapter-unavailable` | `requestAdapter()` returned no adapter. |
| `adapter-request-failed` | Adapter request threw. |
| `device-request-failed` | Device request threw. |
| `device-lost` | Device loss was already signaled during setup. |
| `webgpu-unavailable` | Execution planning received no selected WebGPU provider. |

Fallback diagnostics always set `selectedProvider` to `cpu`.

## Required Mode Warning

When `webgpu.required` is true and WebGPU cannot be selected, conversion still
continues through CPU fallback and emits a warning:

```json
{
  "code": "webgpu.unavailable",
  "message": "WebGPU execution is unavailable; CPU fallback was selected.",
  "details": {
    "status": "fallback-cpu",
    "fallbackReason": "navigator-gpu-missing",
    "runtime": "browser",
    "selectedProvider": "cpu"
  }
}
```

Use this warning to detect unmet acceleration requirements in application logs,
test assertions, or user-facing status messages.

## Execution Planning

The execution plan currently covers the OCR workload:

```json
{
  "workload": "ocr",
  "provider": "cpu",
  "status": "cpu-fallback",
  "routedPages": 1,
  "plannedPages": 0,
  "skippedPages": 0
}
```

Only pages classified as `scanned` or `hybrid` are routed to WebGPU OCR
planning. Digital pages do not need OCR acceleration and produce
`status: "no-routed-pages"` when there is no routed OCR work.

When WebGPU is selected, each routed page is matched with the raster plan:

```json
{
  "provider": "webgpu",
  "status": "planned",
  "limits": {
    "maxBatchPixels": 8000000,
    "maxMemoryBytes": 268435456,
    "bytesPerPixel": 4
  },
  "batches": [
    {
      "batchIndex": 0,
      "pixelCount": 5000,
      "estimatedBytes": 20000
    }
  ]
}
```

Pages can be skipped during planning:

| Page status | Meaning |
| --- | --- |
| `missing-raster` | No raster target exists for the routed OCR page. |
| `exceeds-memory-limit` | The page exceeds `maxMemoryBytes`. |

The plan uses RGBA memory estimation, so estimated bytes are
`pixelCount * 4`.

## Preprocessing Diagnostics

When WebGPU is selected and the execution plan has routed OCR pages, conversion
also emits preprocessing diagnostics:

```json
{
  "provider": "webgpu",
  "status": "completed",
  "workload": "ocr-preprocess-adaptive-threshold-rgba",
  "processedPages": 1,
  "parity": true,
  "speedupRatio": 1.2,
  "speedupPassed": true
}
```

Without a supplied device or injected runner, preprocessing reports
`status: "device-unavailable"` and leaves Markdown output unchanged. With CPU
fallback it reports `status: "cpu-fallback"` and the WebGPU fallback reason.

## Output Parity

CPU and WebGPU execution plans expose the same OCR output contract:

```json
{
  "format": "ocr-result-pages",
  "source": "options.ocr.results",
  "normalizedBy": "ocr-text",
  "coordinateSpaces": ["page", "raster"],
  "compatibleWith": "cpu"
}
```

Current WebGPU preference must not change Markdown, source maps, IR, or assets.
The API tests verify that OCR outputs are preserved when a WebGPU-preferred run
falls back to CPU.

## Browser Integration Notes

Use the browser or worker entrypoints:

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/browser";
```

```js
import { convertPdfToMarkdown } from "@pdf-2-llm/pdf2md/worker";
```

Practical browser checks:

- Confirm the target browser exposes `navigator.gpu`.
- Prefer module workers for heavy PDF conversion.
- Treat WebGPU as an optimization, not a correctness dependency.
- Surface `diagnostics.acceleration.webgpu.selectedProvider` if users need to
  know whether acceleration was selected.
- Log `webgpu.unavailable` warnings when `required` is used.

No cross-origin isolation headers are required by this current WebGPU planner.
Threaded WASM may need separate COOP/COEP headers later, but that is distinct
from the current WebGPU detection path.

## Validation Commands

Useful checks:

```sh
npm run test:api -- --test-name-pattern=WebGPU
```

```sh
node --expose-gc scripts/qa/benchmark.mjs \
  --id synthetic-scanned-text \
  --id synthetic-searchable-scan-regions \
  --id synthetic-two-column \
  --webgpu-comparison \
  --iterations 1 \
  --warmup 0 \
  --report .temp/qa/webgpu-benchmark.json
```

The benchmark comparison should report equivalent accepted output between CPU
and WebGPU-preferred modes. In Node, the WebGPU-preferred mode is expected to
select CPU with `node-stable-gpu-path-unavailable`.

```sh
npm run qa:webgpu-preprocess
```

This browser harness serves the preprocessing module from localhost, launches
Chrome with WebGPU flags, and runs the adaptive-threshold RGBA preprocessing
kernel when `requestAdapter()` succeeds. The harness includes
`--disable-vulkan-surface` because Chrome 126 headless can otherwise fail Vulkan
initialization on Linux. Without a usable adapter it writes an explicit
not-applicable summary. On a WebGPU-capable host, use the strict form to require
measurable speedup:

```sh
node scripts/qa/browser-webgpu-preprocess.mjs \
  --summary .temp/qa/webgpu-preprocess.json \
  --require-speedup
```

## Common Failure Modes

`selectedProvider` is `cpu` even with `preferred: true`

This is expected in Node and in browsers without usable WebGPU. Check
`fallbackReason` for the exact cause.

`webgpu.unavailable` appears in warnings

`required: true` was set, but WebGPU was not selected. Conversion completed on
CPU fallback.

Execution status is `no-routed-pages`

The document had no scanned or hybrid pages routed to OCR. WebGPU had no OCR
work to plan.

Execution status is `skipped`

Routed OCR pages existed, but none could be planned because raster data was
missing or memory limits were exceeded.

Benchmark ratios vary between runs

Current WebGPU-preferred benchmarks in Node still execute through CPU fallback,
so timing differences are process noise. Use `equivalentAcceptedOutput` and
provider diagnostics as the primary correctness checks.

`qa:webgpu-preprocess` reports `adapter-unavailable`

Chrome exposed `navigator.gpu`, but `requestAdapter()` returned no adapter.
This usually means the local browser/GPU stack cannot run WebGPU compute in the
current environment. The harness records this as not-applicable unless
`--require-speedup` is used.
