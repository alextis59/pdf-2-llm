# Security Limits

PDF conversion runs with security limits enabled by default. The limits are
designed to keep malformed, oversized, deeply nested, or raster-heavy PDFs from
turning into unbounded CPU, memory, or output work.

Security limits are configured through `options.security`:

```js
const result = await convertPdfToMarkdown(bytes, {
  security: {
    maxBytes: 100 * 1024 * 1024,
    maxDecodedStreamBytes: 50 * 1024 * 1024,
    maxTotalDecodedStreamBytes: 200 * 1024 * 1024,
    maxPages: 5000,
    maxObjects: 100000,
    maxDepth: 100,
    maxCMapMappings: 65_536,
    maxContentStreamOperations: 1_000_000,
    maxContentStreamOutputs: 1_000_000,
    maxImagePixels: 100_000_000,
    timeoutMs: 120000
  }
});
```

## Defaults

| Option | Default | Applies to |
| --- | ---: | --- |
| `maxBytes` | `104857600` | Input byte length and parser byte reader. |
| `maxDecodedStreamBytes` | `52428800` | Decoded PDF streams and stream filter expansion. |
| `maxTotalDecodedStreamBytes` | `209715200` | Retained decoded bytes across all stream objects. |
| `maxPages` | `5000` | Parsed page count before page extraction. |
| `maxObjects` | `100000` | XRef/object count during parsing and repair. |
| `maxDepth` | `100` | PDF/content value nesting, indirect stream-length references, document and interaction trees, and content stacks. |
| `maxCMapMappings` | `65536` | Per-range and aggregate ToUnicode CMap mappings. |
| `maxContentStreamOperations` | `1000000` | Operand tokens parsed and operators interpreted per document extraction channel. |
| `maxContentStreamOutputs` | `1000000` | Text units and path/image records expanded per document extraction channel. |
| `maxImagePixels` | `100000000` | Raster page and thumbnail planning. |
| `timeoutMs` | `120000` | Conversion checkpoints. |

The defaults are also reflected in `result.diagnostics.options`.

## Result Shape

Most parser and raster security limit violations return a structured
`ConvertResult` with warnings and diagnostics. This lets applications inspect
what was blocked without losing the full result object.

Example for an input larger than `maxBytes`:

```json
{
  "code": "security.input_too_large",
  "message": "Input exceeds configured maxBytes.",
  "details": {
    "maxBytes": 799,
    "bytes": 800
  }
}
```

The same limit also creates a parser warning:

```json
{
  "code": "pdf.parse_failed",
  "message": "PDF input exceeds parser byte limit.",
  "details": {
    "code": "pdf.input_too_large",
    "bytes": 800,
    "maxBytes": 799
  }
}
```

Security-blocked parsing reports:

```json
{
  "diagnostics": {
    "extraction": {
      "parser": {
        "mode": "unavailable"
      },
      "textLines": 0
    }
  },
  "markdown": ""
}
```

## Warning Codes

| Warning code | Trigger |
| --- | --- |
| `security.input_too_large` | Input byte length exceeds `maxBytes`. |
| `security.page_count_exceeded` | Page-tree traversal observes more than `maxPages`. |
| `security.image_pixels_exceeded` | Raster page or thumbnail target exceeds `maxImagePixels`. |
| `pdf.parse_failed` | Parser stops on a security-related stream, object, depth, or CMap limit. |

Password and encryption security warnings are documented in the API reference,
but they are separate from resource limits:

| Warning code | Trigger |
| --- | --- |
| `security.password_required` | Encrypted PDF requires a password. |
| `security.password_incorrect` | Supplied password does not unlock the PDF. |
| `security.unsupported_encryption` | Encryption method is not supported. |

## Parser Limits

### `maxBytes`

`maxBytes` is checked before parsing. When the input is too large, conversion
returns an empty Markdown result with `security.input_too_large` and
`pdf.parse_failed` warnings.

Use this to reject unexpectedly large uploads before the parser allocates more
work:

```js
const result = await convertPdfToMarkdown(bytes, {
  security: { maxBytes: 10 * 1024 * 1024 }
});
```

### `maxDecodedStreamBytes`

`maxDecodedStreamBytes` caps stream expansion across supported filters. It
guards compressed streams that expand far beyond their encoded size.

When exceeded, the parser warning details use:

```txt
pdf.stream.decoded_too_large
```

The converter blocks fallback text extraction for this security parse warning
and returns empty Markdown.

### `maxTotalDecodedStreamBytes`

`maxTotalDecodedStreamBytes` caps cumulative decoded bytes retained across
distinct stream objects. The remaining document budget is also passed into
bounded filter decoding, so the stream that crosses the limit cannot first
allocate its full decoded output. Stream text is decoded lazily; binary image
streams retain bytes without an automatic Latin-1 string copy.

When exceeded, parser warning details use:

```txt
pdf.stream.total_decoded_too_large
```

This blocks fallback extraction and returns empty Markdown.

### Content stream work limits

`maxContentStreamOperations` independently caps parsed operand tokens and
interpreted operators across the document for each text, ruling-line, and image
extraction channel. Nested array and dictionary values count toward the token
budget before they can expand recursively.
`maxContentStreamOutputs` caps decoded text code units plus stored/emitted path
and image records before large output arrays are constructed. Content stream
tokens are consumed incrementally instead of first materializing the full token
list. Inline-image binary payloads are kept out of the operator stream and stay
bounded by the decoded-stream byte limits; an unterminated payload is skipped
through the end of its content stream.

The existing `maxDepth` value also applies to content stream array/dictionary
nesting, graphics-state stacks, and marked-content stacks. Limit failures block
extraction and use one of these
parser warning detail codes:

```txt
pdf.content_stream.operation_limit_exceeded
pdf.content_stream.output_limit_exceeded
pdf.content_stream.depth_limit_exceeded
pdf.content_stream.form_cycle_detected
```

### `maxObjects`

`maxObjects` limits the number of objects discovered through normal parsing and
repair paths. Classic and stream xref subsections are checked before all their
entries are decoded, and unique entries are checked incrementally while hybrid
and `Prev` sections are merged. When exceeded, the parser warning details use:

```txt
pdf.object_limit_exceeded
```

This blocks fallback extraction and returns empty Markdown.

### `maxDepth`

`maxDepth` limits nested PDF value parsing, iterative indirect stream `/Length`
reference walks, and recursive document structures such as page trees,
outlines, tagged structure, AcroForm fields, and EmbeddedFiles name trees.
Stream-length references use an indexed xref lookup, while interaction trees
track visited objects; both reject cycles independently. When exceeded, parser
warning details use:

```txt
pdf.depth_limit_exceeded
pdf.interactions.depth_limit_exceeded
pdf.stream.length_depth_exceeded
```

This blocks fallback extraction and returns empty Markdown.

### `maxCMapMappings`

`maxCMapMappings` caps mapping work in embedded ToUnicode CMaps, including a
single sequential `beginbfrange` and the aggregate mappings declared across
`beginbfchar` and `beginbfrange` blocks. When exceeded, parser warning details
use:

```txt
pdf.cmap_mapping_limit_exceeded
pdf.cmap_destination_limit_exceeded
```

Both limits block fallback extraction and return empty Markdown. Destinations
that are not complete UTF-16BE code units instead report
`pdf.cmap_destination_malformed` as a structured parse failure.

### `maxPages`

`maxPages` is enforced during page-tree traversal. The parser stops at the first
page beyond the configured budget, before resolving that page's resources or
associating its content streams with a page record, and the converter returns:

```json
{
  "code": "security.page_count_exceeded",
  "message": "PDF page count exceeds configured maxPages.",
  "details": {
    "pages": 1,
    "maxPages": 0
  }
}
```

The parser diagnostics also carry the page-count warning.

## Raster Pixel Limit

`maxImagePixels` applies to planned page rasters and thumbnails when raster
planning is enabled.

```js
const result = await convertPdfToMarkdown(bytes, {
  raster: { enabled: true, dpi: 144 },
  security: { maxImagePixels: 1000 }
});
```

If a page target exceeds the limit, the raster target is skipped and the
converter emits `security.image_pixels_exceeded`:

```json
{
  "code": "security.image_pixels_exceeded",
  "message": "Page raster target exceeds configured maxImagePixels and was skipped.",
  "details": {
    "pageIndex": 0,
    "pixelCount": 1938816,
    "maxImagePixels": 1000,
    "target": "page"
  }
}
```

Thumbnail skips use the same warning code with `target: "thumbnail"`.

Raster planning is metadata-only today. It does not retain page or thumbnail
pixel buffers:

```json
{
  "strategy": "metadata-only",
  "pagePixelsRetained": false,
  "thumbnailPixelsRetained": false,
  "retainedBytes": 0
}
```

## Timeout And Abort Behavior

`timeoutMs` is checked at conversion checkpoints. If the deadline is reached,
the converter throws a `DOMException`:

```txt
name: TimeoutError
message: Operation timed out
```

Abort signals also throw:

```txt
name: AbortError
message: Operation aborted
```

These cases do not return a `ConvertResult`; callers should catch them:

```js
try {
  await convertPdfToMarkdown(bytes, {
    signal: controller.signal,
    security: { timeoutMs: 30_000 }
  });
} catch (error) {
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    // Surface cancellation or timeout to the caller.
  }
  throw error;
}
```

## Invalid Limit Values

Invalid security values throw `RangeError` before conversion starts or an input
path is read:

| Option | Validation |
| --- | --- |
| `maxBytes` | Non-negative integer. |
| `maxDecodedStreamBytes` | Non-negative integer. |
| `maxTotalDecodedStreamBytes` | Non-negative integer. |
| `maxPages` | Non-negative integer. |
| `maxObjects` | Non-negative integer. |
| `maxDepth` | Non-negative integer. |
| `maxCMapMappings` | Non-negative integer. |
| `maxContentStreamOperations` | Non-negative integer. |
| `maxContentStreamOutputs` | Non-negative integer. |
| `timeoutMs` | Non-negative finite number. |
| `maxImagePixels` | Positive finite number. |

`raster.dpi` and `raster.thumbnailDpi` must also be positive finite numbers.

## Operational Guidance

Use lower limits for untrusted upload paths and interactive browser tools:

```js
const uploadResult = await convertPdfToMarkdown(bytes, {
  security: {
    maxBytes: 25 * 1024 * 1024,
    maxDecodedStreamBytes: 10 * 1024 * 1024,
    maxTotalDecodedStreamBytes: 50 * 1024 * 1024,
    maxPages: 250,
    maxObjects: 25000,
    maxDepth: 50,
    maxContentStreamOperations: 250_000,
    maxContentStreamOutputs: 250_000,
    maxImagePixels: 25_000_000,
    timeoutMs: 30_000
  }
});
```

Use higher limits only for trusted batch jobs where memory and runtime are
controlled externally.

Applications should log:

- All warnings whose code starts with `security.`.
- `pdf.parse_failed` warnings where `details.code` is a security parser code.
- `diagnostics.options` so the active limit values are visible in production
  traces.
- Timeout and abort exceptions, since they do not return a result object.

## Validation Commands

Focused checks:

```sh
node --test packages/pdf2md/test/security-limits.test.mjs packages/pdf2md/test/malicious-pdf.test.mjs
```

```sh
npm run qa:malformed
```

Full gate:

```sh
npm run check
```

The focused tests cover:

- `maxBytes` structured warnings.
- `maxPages` blocking before extraction.
- `maxDecodedStreamBytes`, `maxTotalDecodedStreamBytes`, `maxObjects`,
  `maxDepth`, `maxCMapMappings`, `maxContentStreamOperations`, and
  `maxContentStreamOutputs` parser failures.
- `maxImagePixels` page and thumbnail skips.
- Abort and timeout thrown errors.
- Malicious fixture regressions for deep page trees, object floods, compressed
  stream expansion, cycles, and malformed xref streams.

## Common Failure Modes

Markdown is empty with `parser.mode: "unavailable"`

A parser security limit blocked extraction. Inspect `warnings` for
`security.input_too_large`, `security.page_count_exceeded`, or
`pdf.parse_failed.details.code`.

Raster diagnostics show `skipped-pixel-limit`

The page or thumbnail exceeded `security.maxImagePixels`. Lower raster DPI or
increase the pixel limit for trusted documents.

`TimeoutError` is thrown

The conversion passed a timeout checkpoint after `security.timeoutMs`. Catch the
exception and decide whether to retry with a larger timeout.

`AbortError` is thrown

The caller's abort signal was already aborted or became aborted before a
checkpoint.

`RangeError` is thrown before conversion

One of the security or raster limit values is invalid. Validate configuration
before passing it to `convertPdfToMarkdown`.
