# CLI Reference

The package exposes a `pdf-2-llm` command through
`packages/pdf2md/src/cli.mjs`. The older `pdf2md` command is also available as
an alias.

## Usage

```sh
pdf-2-llm <input.pdf> [--output <path>] [--json] [--debug] [--debug-trace <path>]
```

Local development command from a checkout:

```sh
npm exec -- pdf-2-llm <input.pdf> [--output <path>] [--json] [--debug]
```

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `<input.pdf>` | Yes | Local path to the PDF to convert. |

Unknown options, repeated options, and additional positional arguments are
errors. Use `--` before an input path that starts with a dash:

```sh
pdf-2-llm -- --document.pdf
```

The CLI currently accepts local file paths only. For `ArrayBuffer`,
`Uint8Array`, password callbacks, OCR result injection, WebGPU configuration,
or custom security limits, use the JavaScript API documented in
[API Reference](api.md).

## Options

| Option | Description |
| --- | --- |
| `--output <path>` | Write output to a file instead of stdout, creating missing parent directories. |
| `--json` | Emit the full `ConvertResult` JSON instead of only Markdown. |
| `--debug` | Write an NDJSON trace file under the system temp directory and print its path to stderr. |
| `--debug-trace <path>` | Write the debug NDJSON trace to an explicit file path. This also enables `--debug`. |
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

## Debug Traces

Use `--debug` when conversion fails on another machine or when stdout does not
explain what happened:

```sh
pdf-2-llm document.pdf --debug --output out.md
```

The CLI prints the trace path to stderr, for example:

```text
Debug trace: /tmp/pdf-2-llm-traces/convert-2026-07-08T12-00-00-000Z-1234.ndjson
```

Each line is one JSON event. The trace records CLI arguments, runtime metadata,
input file stat results, conversion progress, warnings, diagnostics, confidence
scores, output writes, and thrown errors with stack traces. The trace does not
include the generated Markdown body.

To control the destination:

```sh
pdf-2-llm document.pdf --debug-trace .temp/pdf-2-llm-debug.ndjson
```

## Exit Behavior

The CLI exits successfully when conversion completes and output is written.
Missing input and invalid, duplicate, or extra arguments print usage and exit
with a non-zero status.

Document-level PDF problems generally appear as structured warnings in
Markdown/JSON output rather than process failures. Examples include parse
warnings, unsupported encryption, password failures, image pixel limits, and
security limit warnings.

Unexpected process-level failures print a concise error to stderr and exit
non-zero. Rerun with `--debug` to capture the stack trace and conversion context
in an NDJSON trace file.

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
