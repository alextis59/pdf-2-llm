# CLI Reference

The package exposes a `pdf-2-llm` command through
`packages/pdf2md/src/cli.mjs`. The older `pdf2md` command is also available as
an alias.

## Usage

```sh
pdf-2-llm <input.pdf> [--output <path>] [--json]
```

Local development command from a checkout:

```sh
npm exec -- pdf-2-llm <input.pdf> [--output <path>] [--json]
```

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<input.pdf>` | Yes | Local path to the PDF to convert. |

The CLI currently accepts local file paths only. For `ArrayBuffer`,
`Uint8Array`, password callbacks, OCR result injection, WebGPU configuration,
or custom security limits, use the JavaScript API documented in
[API Reference](api.md).

## Options

| Option | Description |
| --- | --- |
| `--output <path>` | Write output to a file instead of stdout. |
| `--json` | Emit the full `ConvertResult` JSON instead of only Markdown. |
| `--help`, `-h` | Print usage and exit successfully. |

## Markdown Output

By default the CLI writes Markdown to stdout:

```sh
pdf-2-llm corpus/generated/synthetic-simple-text.pdf
```

Example output:

```md
# Synthetic Simple Text

This fixture validates basic paragraph extraction.

The expected output is deterministic.
```

To write Markdown to a file:

```sh
pdf-2-llm corpus/generated/synthetic-simple-text.pdf --output .temp/simple.md
```

## JSON Output

Use `--json` to emit the full structured conversion result:

```sh
pdf-2-llm corpus/generated/synthetic-simple-text.pdf --json
```

The JSON object includes:

- `markdown`
- `sourceMap`
- `assets`
- `ir`
- `warnings`
- `diagnostics`
- `confidence`

To write JSON to a file:

```sh
pdf-2-llm corpus/generated/synthetic-simple-text.pdf --json --output .temp/simple.json
```

## Exit Behavior

The CLI exits successfully when conversion completes and output is written.
Missing input prints usage and exits with a non-zero status.

Document-level PDF problems generally appear as structured warnings in
Markdown/JSON output rather than process failures. Examples include parse
warnings, unsupported encryption, password failures, image pixel limits, and
security limit warnings.

## Current Limitations

The CLI does not currently expose flags for:

- OCR language/model options.
- Password callbacks.
- Parser mode.
- Security limits.
- Raster planning.
- WebGPU preference or requirement.
- Table CSV sidecar toggles.
- Attachment extraction.
- Asset output directories.

Use `convertPdfToMarkdown()` directly when those controls are needed.
