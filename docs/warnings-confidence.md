# Warnings And Confidence Scores

Warnings and confidence scores are part of the conversion contract. They are
designed for downstream policy decisions: whether to index output, send it to an
LLM, show a review banner, preserve sidecars, or reject a conversion.

Warnings identify concrete conditions. Confidence scores are coarse stability
signals, not calibrated probabilities.

## Result Fields

Every successful conversion returns:

```ts
type ConvertResult = {
  markdown: string;
  sourceMap: MarkdownSourceMap;
  assets: AssetResult[];
  ir: DocumentIr;
  warnings: Warning[];
  diagnostics: Diagnostics;
  confidence: Confidence;
};
```

Warnings have a stable shape:

```ts
type Warning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

Confidence currently has four top-level scores:

```ts
type Confidence = {
  overall: number;
  text: number;
  layout: number;
  tables: number;
};
```

## Warning Codes

The package exports `warningCodes` from the main entrypoint and from
`@pdf-2-llm/pdf2md/schema`.

```js
import { warningCodes } from "@pdf-2-llm/pdf2md";
```

Current warning constants:

| Constant | Code | Category |
| --- | --- | --- |
| `ConversionNotImplemented` | `conversion.not_implemented` | Capability |
| `InvalidPdfHeader` | `pdf.invalid_header` | Parse |
| `InputTooLarge` | `security.input_too_large` | Security |
| `PageCountExceeded` | `security.page_count_exceeded` | Security |
| `ImagePixelsExceeded` | `security.image_pixels_exceeded` | Security |
| `PasswordRequired` | `security.password_required` | Security |
| `PasswordIncorrect` | `security.password_incorrect` | Security |
| `UnsupportedEncryption` | `security.unsupported_encryption` | Security |
| `OcrDisabled` | `ocr.disabled` | OCR |
| `WebGpuUnavailable` | `webgpu.unavailable` | Acceleration |
| `HeuristicTextExtraction` | `text.heuristic_content_stream` | Text |
| `TextUnicodeMappingSuspect` | `text.unicode_mapping_suspect` | Text |
| `TextOrderingUncertain` | `text.ordering_uncertain` | Layout |
| `TableLowConfidence` | `table.low_confidence` | Tables |
| `EquationLowOcrConfidence` | `equation.low_ocr_confidence` | Equations |
| `FigureLowSemanticContent` | `figure.low_semantic_content` | Figures |
| `TaggedStructureConflict` | `structure.tagged_layout_conflict` | Structure |
| `PdfParseFailed` | `pdf.parse_failed` | Parse |

Use constants in assertions instead of hard-coded strings when possible.

## Warning Handling Policy

Treat these warnings as hard blockers for unattended ingestion:

- `security.input_too_large`
- `security.page_count_exceeded`
- `security.password_required`
- `security.password_incorrect`
- `security.unsupported_encryption`
- `pdf.parse_failed` when `details.code` is a security parser code such as
  `pdf.input_too_large`, `pdf.stream.decoded_too_large`,
  `pdf.object_limit_exceeded`, or `pdf.depth_limit_exceeded`

Treat these warnings as review signals:

- `pdf.invalid_header`
- `webgpu.unavailable`
- `text.heuristic_content_stream`
- `text.unicode_mapping_suspect`
- `text.ordering_uncertain`
- `table.low_confidence`
- `equation.low_ocr_confidence`
- `figure.low_semantic_content`
- `structure.tagged_layout_conflict`

`ocr.disabled` is expected when callers explicitly set `ocr.enabled: false`.
It is a blocker only for workflows that require scanned-page OCR.

## Text Warnings

### `text.heuristic_content_stream`

Emitted when the converter extracts text through the current heuristic content
stream path:

```json
{
  "code": "text.heuristic_content_stream",
  "message": "Text extraction used heuristic content stream interpretation."
}
```

This warning is common in the current JavaScript implementation. It means the
output should be inspected for ordering, encoding, and layout edge cases before
high-stakes use.

### `text.unicode_mapping_suspect`

Emitted once per page/font pair when text comes from a font without a trusted
Unicode map:

```json
{
  "code": "text.unicode_mapping_suspect",
  "details": {
    "pageIndex": 0,
    "fontName": "F1",
    "baseFont": "CustomFont",
    "encoding": "WinAnsiEncoding"
  }
}
```

Use this warning to route output through review or OCR reconciliation when
gibberish text would be costly.

### `text.ordering_uncertain`

Emitted when adjacent text lines show geometry jumps that suggest content
stream order may not match visual reading order:

```json
{
  "code": "text.ordering_uncertain",
  "details": {
    "pageIndex": 0,
    "previous": {
      "text": "Left column continues",
      "x": 72,
      "y": 640
    },
    "current": {
      "text": "Right column starts",
      "x": 340,
      "y": 700
    }
  }
}
```

Review reading order before using the Markdown as authoritative source text.

## Table, Equation, Figure, And Structure Warnings

### `table.low_confidence`

Emitted when a possible table is preserved as text instead of being emitted as a
table block:

```json
{
  "code": "table.low_confidence",
  "message": "Potential table was preserved as text because table confidence was low.",
  "details": {
    "tableIndex": 0,
    "source": "borderless-heuristic",
    "pageIndex": 0,
    "rows": 3,
    "columns": 2,
    "confidence": 0.45,
    "reason": "no-numeric-body-column"
  }
}
```

### `equation.low_ocr_confidence`

Emitted when an OCR-derived equation is below the image fallback threshold and
is preserved as an image asset:

```json
{
  "code": "equation.low_ocr_confidence",
  "details": {
    "equationIndex": 0,
    "pageIndex": 0,
    "assetId": "document-page-1-equation-1",
    "confidence": 0.42,
    "threshold": 0.75,
    "reason": "low-ocr-confidence"
  }
}
```

### `figure.low_semantic_content`

Emitted for visual figures that are preserved as assets without inferred
semantic chart or diagram data:

```json
{
  "code": "figure.low_semantic_content",
  "details": {
    "figureIndex": 0,
    "pageIndex": 0,
    "assetId": "synthetic-vector-figure-page-1-figure-1",
    "kind": "vector",
    "caption": "Figure 1. A generated vector box.",
    "reason": "visual-preview-only"
  }
}
```

### `structure.tagged_layout_conflict`

Emitted when tagged PDF structure conflicts with visible layout and the
conflicting tag signals are ignored:

```json
{
  "code": "structure.tagged_layout_conflict",
  "details": {
    "conflicts": 1,
    "samples": []
  }
}
```

## Security And Parse Warnings

Security warnings are documented in detail in [Security Limits](security-limits.md).

Parse failures use `pdf.parse_failed` and place the parser-specific code in
`details.code`:

```json
{
  "code": "pdf.parse_failed",
  "details": {
    "code": "pdf.xref.entry_malformed",
    "offset": 128
  }
}
```

Some parse failures still allow fallback text extraction. Security parser
failures block fallback extraction and usually produce empty Markdown.

## OCR Warning

`ocr.disabled` is emitted when OCR is explicitly disabled:

```js
const result = await convertPdfToMarkdown(bytes, {
  ocr: { enabled: false }
});
```

```json
{
  "code": "ocr.disabled",
  "message": "OCR is disabled by options."
}
```

This warning is expected in text-only workflows.

## WebGPU Warning

`webgpu.unavailable` is emitted when `webgpu.required` is true but WebGPU cannot
be selected. Conversion continues through CPU fallback:

```json
{
  "code": "webgpu.unavailable",
  "details": {
    "status": "fallback-cpu",
    "fallbackReason": "node-stable-gpu-path-unavailable",
    "runtime": "node",
    "selectedProvider": "cpu"
  }
}
```

See [WebGPU Behavior And Fallback](webgpu-behavior.md) for provider diagnostics.

## Confidence Scores

Top-level confidence values are intentionally conservative:

| Field | Current calculation |
| --- | --- |
| `confidence.overall` | `0.25` when Markdown has at least one text line; otherwise `0`. |
| `confidence.text` | `0.4` when reconciled PDF text is selected; otherwise average OCR text confidence, or `0`. |
| `confidence.layout` | `0.35` when layout diagnostics contain pages; otherwise `0`. |
| `confidence.tables` | Average detected table confidence rounded to three decimals; otherwise `0`. |

Do not treat these numbers as probabilities. They are monotonic quality hints
for this implementation stage.

## OCR Confidence Normalization

Caller-supplied OCR confidence accepts either `0..1` or `0..100` style values.
Values above `1` are divided by `100`, then clamped to `0..1`.

Examples:

| Input | Stored confidence |
| ---: | ---: |
| `94` | `0.94` |
| `0.82` | `0.82` |
| `-1` | `0` |
| `150` | `1` |
| Missing or non-number | `0` |

`diagnostics.extraction.ocr.textBoxes.averageConfidence` is the average of
normalized OCR line confidences, or `null` when no OCR lines are present.

## Table Confidence

Detected ruled tables use fixed confidence values today:

| Table output | Confidence |
| --- | ---: |
| GFM ruled table without spans | `0.95` |
| HTML ruled table with spans | `0.9` |
| Low-confidence borderless candidate preserved as text | typically `0.45` |

`confidence.tables` averages only emitted table blocks. Low-confidence table
candidates are reported separately in
`diagnostics.extraction.lowConfidenceTables` and warnings.

## Equation Confidence

Equation image fallback uses OCR line confidence when an equation came from OCR
text. The default image fallback threshold is `0.75`; it can be changed with:

```js
const result = await convertPdfToMarkdown(bytes, {
  equations: {
    imageFallbackConfidence: 0.8
  }
});
```

When equation confidence is below the threshold, the equation is preserved as an
image asset and `equation.low_ocr_confidence` is emitted.

## Diagnostics To Pair With Warnings

Warnings are concise. Pair them with diagnostics for decisions:

| Warning category | Useful diagnostics |
| --- | --- |
| Parse/security | `diagnostics.extraction.parser`, `diagnostics.options` |
| Text ordering | `diagnostics.extraction.layout.pages`, `sourceMap.entries` |
| Unicode mapping | `diagnostics.pages[].fonts`, text spans in IR/source map |
| OCR | `diagnostics.extraction.ocr` |
| Tables | `diagnostics.extraction.tables`, `diagnostics.extraction.lowConfidenceTables` |
| Figures/equations | `diagnostics.extraction.figures`, `diagnostics.extraction.equations`, `assets` |
| WebGPU | `diagnostics.acceleration.webgpu` |

## Example Policy

```js
import { warningCodes } from "@pdf-2-llm/pdf2md";

const hardBlockers = new Set([
  warningCodes.InputTooLarge,
  warningCodes.PageCountExceeded,
  warningCodes.PasswordRequired,
  warningCodes.PasswordIncorrect,
  warningCodes.UnsupportedEncryption
]);

function assessConversion(result) {
  const codes = new Set(result.warnings.map((warning) => warning.code));
  const parseSecurityFailure = result.warnings.some(
    (warning) =>
      warning.code === warningCodes.PdfParseFailed &&
      [
        "pdf.input_too_large",
        "pdf.stream.decoded_too_large",
        "pdf.object_limit_exceeded",
        "pdf.depth_limit_exceeded"
      ].includes(warning.details?.code)
  );

  if ([...hardBlockers].some((code) => codes.has(code)) || parseSecurityFailure) {
    return "reject";
  }
  if (result.confidence.text < 0.4 || codes.has(warningCodes.TextOrderingUncertain)) {
    return "review";
  }
  return "accept";
}
```

## Validation Commands

Focused checks:

```sh
node --test test/schema.test.mjs test/convert.test.mjs test/parser.test.mjs
```

Corpus warning checks:

```sh
npm run corpus:run:all
```

Full gate:

```sh
npm run check
```

The focused tests cover serialized result schema validation, warning constants
and payloads, heuristic text warnings, ordering warnings, parse/encryption
warnings, low-confidence tables, low-confidence equation fallback, figure
warnings, OCR confidence normalization, and coarse top-level confidence fields.

## Common Failure Modes

No warning is present, but confidence is low

Confidence scores can be low because the current implementation uses coarse
fixed values. Use diagnostics and corpus assertions before treating the score as
a failure.

`confidence.text` is `0.4` for good-looking PDF text

That is expected today. Born-digital text confidence is a conservative stage
signal, not a calibrated OCR-like score.

A low-confidence table warning appears but `confidence.tables` is `0`

The candidate was preserved as text and is not counted as an emitted table.
Inspect `diagnostics.extraction.lowConfidenceTables`.

Warnings appear both in `result.warnings` and `result.ir.warnings`

That is expected. The IR carries the same document-level warnings for persisted
IR consumers.
