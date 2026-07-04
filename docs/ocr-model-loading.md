# OCR Model Loading

This package currently exposes the OCR loading contract, diagnostics, routing,
and injected-result path. It does not bundle OCR model binaries and does not
download or execute OCR models during conversion.

The current implementation is therefore suitable for:

- Planning OCR model and cache behavior.
- Routing scanned and hybrid pages to OCR.
- Reconciling caller-supplied OCR boxes with PDF text.
- Verifying OCR outputs in deterministic corpus tests.

It is not yet an automatic OCR engine. To produce OCR text today, callers pass
page-level OCR boxes through `options.ocr.results`.

## Current Adapter

The only supported adapter identifier is:

```txt
tesseract.js
```

When selected, diagnostics report a CPU adapter:

```json
{
  "id": "tesseract.js",
  "kind": "cpu",
  "packageName": "tesseract.js",
  "version": "7.0.0",
  "license": "Apache-2.0",
  "runtimes": ["browser", "node", "worker"],
  "output": "ocr-plan"
}
```

Unsupported adapter names leave OCR enabled but report
`diagnostics.extraction.ocr.status` as `unsupported`.

Disable OCR explicitly when callers only want born-digital PDF extraction:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: { enabled: false }
});
```

Disabled OCR emits the `ocr.disabled` warning and keeps OCR diagnostics visible.

## Model Files

Model files are represented by Tesseract language codes with a `.traineddata`
suffix.

The default language is English:

```txt
eng.traineddata
```

Global language selection:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    adapter: "tesseract.js",
    languages: ["eng", "fra"]
  }
});
```

Expected model-loading diagnostics include:

```json
{
  "strategy": "lazy",
  "trigger": "routed-scanned-or-hybrid-pages",
  "workerLifecycle": "reuse-worker-per-language-set",
  "source": "adapter-default",
  "languages": ["eng", "fra"],
  "modelFiles": ["eng.traineddata", "fra.traineddata"]
}
```

The files are planned, not fetched by the current converter.

## Model Source

Use `modelBaseUrl` to describe where application-hosted OCR models should come
from once recognition execution is wired:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    modelBaseUrl: "/models/tesseract",
    languages: ["eng", "spa"]
  }
});
```

Diagnostics then report the source as `/models/tesseract`.

Current behavior:

- No request is made to `modelBaseUrl`.
- No model file is required in the npm package.
- No model file is copied by the bundler.
- Model-size QA checks enforce that model binaries are not accidentally added
  to the repository or package.

Future recognition behavior should keep model binaries external to the package
and let applications choose a CDN, same-origin static path, or Node cache path.

## Cache Behavior

Cache options describe the intended adapter cache:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    cache: {
      enabled: true,
      strategy: "adapter-default",
      directory: ".cache/pdf2md-ocr"
    }
  }
});
```

When enabled, diagnostics use:

```json
{
  "enabled": true,
  "strategy": "adapter-default",
  "directory": ".cache/pdf2md-ocr",
  "keyPrefix": "tesseract.js:7.0.0",
  "browser": "adapter-default-indexeddb",
  "node": "adapter-default-filesystem"
}
```

When disabled:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    cache: { enabled: false }
  }
});
```

Diagnostics report `strategy: "none"` and disabled browser/Node cache targets.

Current behavior does not read or write cache files.

## Language And Script Selection

Language codes can be supplied directly:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    languages: ["eng", "deu"]
  }
});
```

Script hints expand into language profiles:

| Script hint | Model languages |
| --- | --- |
| `latin` | `eng` |
| `rtl` | `ara`, `heb` |
| `arabic` | `ara` |
| `hebrew` | `heb` |
| `cjk` | `chi_sim`, `chi_tra`, `jpn`, `kor` |
| `chinese` | `chi_sim`, `chi_tra` |
| `japanese` | `jpn` |
| `korean` | `kor` |
| `vertical` | `jpn_vert` |

Example:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    scripts: ["japanese", "vertical"]
  }
});
```

This plans `jpn.traineddata` and `jpn_vert.traineddata`.

## Page Overrides

Use `pageLanguages` when different scanned or hybrid pages require different
language sets:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    languages: ["eng"],
    pageLanguages: [
      {
        pageIndex: 1,
        languages: ["spa", "eng"]
      },
      {
        pageIndex: 2,
        scripts: ["rtl"]
      }
    ]
  }
});
```

Diagnostics include per-page `workerLanguage` values such as `spa+eng` and the
corresponding model files. Page overrides only appear on pages routed as
`scanned` or `hybrid`; digital pages do not trigger OCR model loading.

## Routing Trigger

OCR model loading is lazy by contract. The trigger is:

```txt
routed-scanned-or-hybrid-pages
```

The converter classifies pages as `digital`, `scanned`, `hybrid`, or `unknown`
before OCR text is reconciled. Only scanned and hybrid pages are routed to OCR.

Important statuses:

| Diagnostic path | Meaning |
| --- | --- |
| `diagnostics.extraction.ocr.language.status: "no-routed-pages"` | OCR is configured, but no scanned or hybrid page needs a model. |
| `diagnostics.extraction.ocr.language.status: "configured"` | At least one scanned or hybrid page has a language/model plan. |
| `diagnostics.extraction.ocr.textBoxes.status: "pending"` | OCR pages exist, but no matching `options.ocr.results` were supplied. |
| `diagnostics.extraction.ocr.textBoxes.status: "completed"` | Supplied OCR boxes covered the routed pages. |

## Supplying OCR Results Today

Automatic recognition is not active yet. Pass OCR boxes explicitly:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    results: [
      {
        pageIndex: 0,
        language: "eng",
        coordinateSpace: "page",
        lines: [
          {
            text: "OCR fixture body text.",
            confidence: 96,
            x: 72,
            y: 690,
            width: 180,
            height: 14
          }
        ]
      }
    ]
  }
});
```

`coordinateSpace` can be `page` or `raster`. Raster-space boxes should include
`widthPx` and `heightPx` so they can be normalized against the page geometry.

Accepted box arrays are `boxes`, `lines`, or `words`. The converter normalizes
them into OCR text lines with confidence and source-map data.

## Debug Sidecars

Set `debugSidecars` to retain normalized OCR boxes as assets:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: {
    debugSidecars: true,
    results
  }
});
```

OCR sidecars appear in `result.assets` with the `ocr-debug-json` kind. They are
intended for tests, audits, and fixture debugging.

## Browser And Worker Notes

Browser and worker entrypoints support the same OCR options:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/browser";
```

```js
import { convertPdfToMarkdown } from "pdf-2-llm/worker";
```

Current browser behavior:

- No model files are fetched.
- No Tesseract worker is spawned.
- Injected `ocr.results` can be reconciled with PDF text.

Future automatic OCR should load model files from same-origin or CORS-enabled
URLs. Large model files should remain external assets and should not be inlined
into JavaScript bundles.

## Node Notes

Node code should use the Node entrypoint:

```js
import { convertPdfToMarkdown } from "pdf-2-llm/node";
```

Current Node behavior mirrors browser behavior: OCR models are planned in
diagnostics but not loaded from disk or network. If future automatic OCR uses a
filesystem cache, `ocr.cache.directory` should point to an application-owned
directory outside the package.

## Verification

For the current implementation, validate OCR loading behavior through
diagnostics:

- `diagnostics.extraction.ocr.adapter.id` is `tesseract.js`.
- `diagnostics.extraction.ocr.modelLoading.strategy` is `lazy`.
- `diagnostics.extraction.ocr.modelLoading.modelFiles` matches the configured
  languages and page overrides.
- Digital-only documents report `language.status: "no-routed-pages"`.
- Scanned or hybrid documents without `ocr.results` report
  `textBoxes.status: "pending"`.
- Scanned or hybrid documents with matching `ocr.results` report completed OCR
  text boxes and include OCR text in Markdown when selected by reconciliation.
- `npm run qa:model-size` reports zero packaged model files unless a future
  release intentionally changes the packaging contract.

The accepted OCR fixtures use injected results under `corpus/ocr/` so the
Markdown and accuracy thresholds are deterministic.

## Common Failure Modes

`diagnostics.extraction.ocr.status` is `unsupported`

The requested `ocr.adapter` is not `tesseract.js`.

`language.status` is `no-routed-pages`

The document was classified as digital, so no OCR model is needed.

`textBoxes.status` is `pending`

A scanned or hybrid page was routed to OCR, but no matching
`options.ocr.results` entry was supplied.

OCR text is duplicated with PDF text

Check the scan-detection and reconciliation diagnostics. Hybrid pages select
PDF text, OCR text, or a combined region path depending on hidden text
alignment and visible image regions.

No model files appear in the package

That is expected for the current package. OCR model binaries are external by
contract and automatic model loading is not implemented yet.
