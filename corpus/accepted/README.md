# Acceptance Criteria

Each PDF that becomes part of the validation corpus needs an acceptance file in
this directory. The acceptance file defines what the converter must do for that
specific PDF at a specific capability gate.

Acceptance files are intentionally human-reviewed. Oracle outputs from other
PDF tools are useful references, but they are not ground truth until the
expected behavior has been written here.

## Gate Labels

- `text-mvp`
- `robust-parser`
- `layout-v1`
- `tables-v1`
- `ocr-v1`
- `webgpu-v1`
- `advanced-v1`
- `forms-v1`
- `hardening-v1`

## Source Types

- `digital`
- `scanned`
- `hybrid`
- `unknown`

## Expected Modes

- `pdf-text`
- `ocr`
- `hybrid`
- `asset-only`
- `metadata-only`
- `unsupported`

## Review Rules

- The file name should match the `id`, for example
  `corpus/accepted/simple-report.yaml` should contain `id: simple-report`.
- `gating: true` means the file blocks release gates.
- A gating file must have `review.humanReviewedBy` and `review.reviewedAt`.
- Unsupported content belongs in `warnings.allowed`, not in vague prose.
- Every metric threshold needs a reason in `review.notes` or a nearby comment.
- The converter must not invent values that are not present in the PDF.
- If `runningContent` labels are present, `metrics` must define
  `minRunningContentPrecision` and `minRunningContentRecall` from 0 to 1.
- If `metrics.maxReadingOrderDistance` is present, the QA comparator enforces
  normalized reading-order edit distance from 0 to 1. Reviewed expected
  Markdown is preferred as the reading-order oracle when available because
  external text tools can interleave multi-column pages.
- If `metrics.maxOcrCharacterErrorRate` or `metrics.maxOcrWordErrorRate` is
  present, the corpus runner compares expected Markdown with OCR-produced
  Markdown after Markdown syntax normalization. Character error rate catches
  small glyph mistakes; word error rate catches substitutions, insertions, and
  omissions at token level.
- If `metrics.maxRssDeltaBytes` or `metrics.maxHeapUsedDeltaBytes` is present,
  the benchmark harness enforces conversion memory deltas in bytes. Run these
  gates with `node --expose-gc` so before/after snapshots measure retained
  memory consistently.
- If `metrics.minTaggedMarkedContent` or `metrics.maxTaggedStructureConflicts`
  is present, the tagged-structure comparator enforces that tagged PDFs expose
  usable marked content and that unreliable tag/layout conflicts stay within the
  accepted fallback threshold.
- If `metrics.minRenderedHtmlTextChars`, `metrics.minRenderedHtmlHeadings`,
  `metrics.minRenderedHtmlParagraphs`, or `metrics.maxRenderedHtmlParagraphChars`
  is present, the rendered-HTML checker enforces structural readability after
  Markdown is rendered.
- `runningContent.expectedRemoved` is for repeated headers, footers, page
  numbers, and boilerplate that should disappear from Markdown.
- `runningContent.expectedRetained` is for meaningful title, section, or body
  phrases that must survive running-content removal.

Validate acceptance files with:

```sh
npm run corpus:acceptance
```
