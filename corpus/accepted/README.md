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

Validate acceptance files with:

```sh
npm run corpus:acceptance
```
