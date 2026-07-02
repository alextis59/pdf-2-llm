# PDF Corpus

This directory contains the validation corpus used to evaluate PDF-to-Markdown
behavior. The corpus is part of the product contract: a PDF should not become a
release gate until its provenance, license, static analysis, and acceptance
criteria are recorded.

## Directory Layout

```text
corpus/
  manifest.json
  manifest.schema.json
  raw/
    _incoming/
    local-only/
    public/
  generated/
  mutated/
  accepted/
  expected/
  baselines/
  reports/
```

- `raw/_incoming/` is a quarantine area for newly downloaded PDFs.
- `raw/local-only/` is for files that may be tested locally but must not be
  committed.
- `raw/public/` is for external PDFs cleared for repository storage.
- `generated/` is for reproducible fixtures created by repo scripts.
- `mutated/` is for reproducible damaged or stress fixtures created from
  cleared source PDFs.
- `accepted/` contains per-PDF acceptance criteria.
- `expected/` contains reviewed expected Markdown, IR, or sidecar snapshots.
- `baselines/` contains analysis and oracle outputs.
- `reports/` contains corpus inventory and benchmark reports.

## Entry Policy

Every corpus entry must be listed in `corpus/manifest.json` and must include:

- Stable `id`.
- Corpus `kind`.
- `path` relative to the repository root.
- `source` with retrieval or generation details.
- Retrieval or generation date.
- License notes.
- Redistribution status.
- SHA-256 hash.
- File size in bytes.
- Page count when known.
- PDF version when known.
- Feature tags.
- Acceptance file path.
- Notes.

Externally retrieved PDFs must also record their source URL or a local-only
source note. Generated and mutated PDFs must record the command that reproduces
the file.

## Redistribution Rules

Committed PDFs must be public domain, permissively licensed, self-generated, or
otherwise explicitly cleared for redistribution. Copyrighted reports, manuals,
papers, or forms with unclear redistribution terms belong in `raw/local-only/`
and must not be committed.

The repository ignores `raw/_incoming/` and `raw/local-only/` contents by
default. Keep only `.gitkeep` placeholders there.

## Acceptance Rules

Oracle outputs from PDF.js, PDFium, MuPDF, Tesseract, Docling, Marker, MinerU,
or similar tools are analysis aids. They are not ground truth until reviewed.

Each PDF must have an acceptance YAML file before it becomes a release gate.
The acceptance file should define required behavior, forbidden behavior,
allowed warnings, snippets, structural assertions, metric thresholds, and human
review status.

Unsupported content is acceptable only when the expected warning, sidecar, or
asset fallback is documented.

Acceptance files must include `skipReason` when `gating: false`, when
`expectedMode: unsupported`, or when the manifest entry points at a local-only
PDF. The corpus runner prints that reason instead of silently omitting or
attempting to convert the file.

## Storage Rules

Prefer generated fixtures for exact-output tests. Prefer small public-domain or
permissively licensed external PDFs for committed corpus files.

Use these storage thresholds unless a later release policy changes them:

- Under 5 MiB: may be committed if redistribution is cleared.
- 5 MiB to 50 MiB: prefer Git LFS or release artifacts.
- Over 50 MiB: keep outside Git unless the file is essential and explicitly
  approved.

Run `npm run corpus:validate` after modifying the manifest or any tracked
corpus file.
