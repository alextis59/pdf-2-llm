# Security

`pdf-2-llm` processes attacker-controlled PDF bytes. The repository does not
implement authentication, authorization, deployment, or server-side tenant
isolation; those concerns belong to applications that embed the package. This
document records the security behavior this repository can actually support.

## Security Model

- Inputs can be local paths in Node, bytes in Node/browser/worker runtimes, or
  objects with explicit bytes. Treat all PDF bytes as untrusted.
- The converter should return structured warnings and diagnostics for
  document-level PDF problems whenever possible.
- Timeout and abort checkpoints throw `TimeoutError` and `AbortError`; callers
  must catch those separately from `ConvertResult` warnings.
- The CLI reads one local PDF path and writes to stdout or an optional local
  output path. With `--debug`, it also writes a local NDJSON trace under the
  system temp directory, or to an explicit `--debug-trace <path>` destination.
  It does not fetch URLs, spawn shell commands, or expose advanced
  parser/OCR/security controls.
- The library does not download OCR models, execute OCR engines, or read/write
  OCR caches today. OCR model and cache options are recorded as diagnostics.
- WebGPU is optional. CPU fallback remains the correctness baseline.
- Source-derived LTR Markdown text entity-escapes `&`, `<`, and `>` before
  rendering. Raw anchors, bidi wrappers, HTML tables, and autolinks are emitted
  only by converter-owned formatting paths.
- Generated code fences use a delimiter longer than every matching source run,
  so code containing backticks, tildes, or raw HTML cannot close its own block.
- CSV table sidecars prefix cells beginning with `=`, `+`, `-`, or `@` with a
  single quote before RFC 4180 escaping, preventing untrusted PDF text from
  being opened as a spreadsheet formula. Markdown and IR values are unchanged.
- When an untrusted font has no usable Unicode mapping, raw C0 and DEL bytes are
  rendered as visible Unicode control-picture symbols instead of invisible
  control characters. The result still carries `text.unicode_mapping_suspect`
  so callers can treat that text as lossy.

## Resource Limits

Resource limits are enabled by default through `options.security`:

| Limit | Default |
| --- | ---: |
| `maxBytes` | `104857600` |
| `maxDecodedStreamBytes` | `52428800` |
| `maxTotalDecodedStreamBytes` | `209715200` |
| `maxPages` | `5000` |
| `maxObjects` | `100000` |
| `maxDepth` | `100` |
| `maxCMapMappings` | `65536` |
| `maxContentStreamOperations` | `1000000` |
| `maxContentStreamOutputs` | `1000000` |
| `maxImagePixels` | `100000000` |
| `timeoutMs` | `120000` |

Every security limit is validated before path input is read. Byte, stream,
page, object, depth, CMap, and content-work limits require non-negative
integers; `maxImagePixels` requires a positive finite number, and `timeoutMs`
requires a non-negative finite number.

Keep these limits visible when adding parser, raster, OCR, WebGPU, or corpus
behavior. Security-limit violations should preserve warning codes documented in
[Security Limits](security-limits.md).

`maxDecodedStreamBytes` is passed to Flate decompression as an output bound, so
high-ratio compressed streams are rejected before the full decoded buffer is
allocated. Node uses its bounded native inflater; browser and worker runtimes
use a chunked synchronous portable inflater with the same limit and checksum
validation.

`maxTotalDecodedStreamBytes` caps retained decoded bytes across all stream
objects, while stream text is materialized lazily so binary image streams do not
also retain an unnecessary Latin-1 copy.

Indirect stream `/Length` references are resolved iteratively through an indexed
xref lookup. `maxDepth` caps reference hops, and cycles are rejected before any
stream bytes are sliced.

`maxPages` is enforced while walking the page tree. Traversal stops at the first
page beyond the configured budget, before resolving that page's resources or
associating its content streams with a page record.

`maxObjects` is enforced before each classic or stream xref subsection is
decoded and while unique entries are merged across hybrid and incremental xref
sections, so over-budget indexes stop before object materialization.

`maxCMapMappings` bounds both individual ToUnicode ranges and aggregate mapping
work so compact font CMaps cannot expand into unbounded entries. Each mapping
destination is also capped at the PDF-defined 512-byte maximum and decoded
incrementally, preventing one mapping from triggering an unbounded function
call or output allocation.

Content stream interpretation tokenizes incrementally. The operation budget
applies to both parsed operand tokens (including values nested in arrays and
dictionaries) and interpreted operators across the document for each text,
ruling-line, and image extraction channel. The output budget applies to emitted
records; `maxDepth` caps syntax nesting as well as graphics-state and
marked-content stacks. Limit failures return `pdf.parse_failed` with a specific
`pdf.content_stream.*_limit_exceeded` detail code.

Inline-image data is consumed as one binary token inside the already bounded
decoded content stream. Exact unfiltered byte lengths are used when the image
dictionary supplies enough information; other payloads require a delimited
`EI` operator, and unterminated payloads consume the remainder of the stream
instead of being reinterpreted as text or graphics operators.

Form XObject streams share the same per-channel work budgets as their invoking
page stream. Form resource graphs and execution are capped by `maxDepth`, and
an object/generation stack rejects recursive Form cycles with
`pdf.content_stream.form_cycle_detected`.

AcroForm field trees and EmbeddedFiles name trees are cycle-safe and share the
same `maxDepth` boundary. Exceeding it blocks extraction with
`pdf.interactions.depth_limit_exceeded` rather than recursively walking the
remaining objects.

## Passwords And Encryption

- Passwords may be supplied as strings or callbacks for encrypted PDFs.
- Password values must not be copied into warnings, diagnostics, logs, report
  files, snapshots, trace output, or corpus fixtures. CLI debug traces redact
  password, passphrase, and secret value fields before serialization while
  preserving non-secret metadata such as `passwordProvided` and
  `passwordSource`.
- Missing, incorrect, and unsupported encryption are represented with
  `security.password_required`, `security.password_incorrect`, and
  `security.unsupported_encryption`.
- The supported Standard security handler revision 2 RC4-40 path decrypts both
  streams and literal/hex strings throughout each indirect object with its
  object/generation key. The encryption dictionary and XRef objects are never
  decrypted as ordinary objects.
- The parser supports only the implemented encryption path. Unsupported
  security handlers must stay explicit warnings, not silent extraction.

## Filesystem And Corpus Safety

- Do not commit non-redistributable PDFs. Place local-only inputs under
  `corpus/raw/local-only/`; this directory is ignored except for `.gitkeep`.
- Place newly downloaded PDFs in `corpus/raw/_incoming/` until provenance,
  license notes, hashes, and redistribution status are reviewed.
- Generated and mutated corpus PDFs need reproducible commands in
  `corpus/manifest.json`.
- Generated fixtures that incorporate third-party font-derived glyph masks
  must record that provenance in the manifest and keep the applicable notices
  under `corpus/licenses/`. The multilingual fixtures use vector rectangles
  derived from the permissively licensed DejaVu Sans and Droid Sans Fallback
  glyphs; no system font file is read when fixtures are regenerated.
- Asset paths returned by the API are logical sidecar paths unless the caller
  writes returned assets. The conversion API does not currently write asset
  files to `assets.outputDir`.

## Dependency And Package Policy

- Project package manifests use the `0BSD` license.
- `scripts/qa/check-dependencies.mjs` validates manifest license fields and
  dependency license metadata from `package-lock.json`.
- The MIT-licensed `fflate` runtime dependency provides bounded portable Flate
  decoding where Node's native `zlib` module is unavailable.
- `npm run qa:dependencies` also runs `npm audit --audit-level=moderate
  --omit=dev`.
- OCR model binaries should not be added to the package. `npm run
  qa:model-size` enforces the current zero-bundled-model expectation.
- `npm run qa:package-size` guards accidental broad tarball contents.

## Network And Runtime Boundaries

- Core conversion does not perform network requests.
- `scripts/corpus/retrieve.mjs` is the controlled network path for corpus
  retrieval and records source metadata before files become gates.
- `pdf-2-llm/wasm` may fetch a WASM URL when callers pass URL-like sources or
  rely on bundler-emitted package assets. Node `file:` package assets are read
  through local filesystem APIs.
- Browser and worker integrations must pass bytes; local path strings are a
  Node-only input form.

## Security Validation

Use focused checks for security-sensitive work:

```sh
node --test packages/pdf2md/test/security-limits.test.mjs packages/pdf2md/test/malicious-pdf.test.mjs
npm run qa:malformed
npm run qa:dependencies
npm run qa:model-size
```

Use `npm run check` before release or when security behavior crosses parser,
corpus, WebGPU, dependency, or package boundaries.
