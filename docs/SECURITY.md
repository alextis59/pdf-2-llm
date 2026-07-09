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

## Resource Limits

Resource limits are enabled by default through `options.security`:

| Limit | Default |
| --- | ---: |
| `maxBytes` | `104857600` |
| `maxDecodedStreamBytes` | `52428800` |
| `maxPages` | `5000` |
| `maxObjects` | `100000` |
| `maxDepth` | `100` |
| `maxCMapMappings` | `65536` |
| `maxImagePixels` | `100000000` |
| `timeoutMs` | `120000` |

Keep these limits visible when adding parser, raster, OCR, WebGPU, or corpus
behavior. Security-limit violations should preserve warning codes documented in
[Security Limits](security-limits.md).

`maxDecodedStreamBytes` is passed to Flate decompression as an output bound, so
high-ratio compressed streams are rejected before the full decoded buffer is
allocated.

`maxCMapMappings` bounds both individual ToUnicode ranges and aggregate mapping
work so compact font CMaps cannot expand into unbounded entries.

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
- The parser supports only the implemented encryption path. Unsupported
  security handlers must stay explicit warnings, not silent extraction.

## Filesystem And Corpus Safety

- Do not commit non-redistributable PDFs. Place local-only inputs under
  `corpus/raw/local-only/`; this directory is ignored except for `.gitkeep`.
- Place newly downloaded PDFs in `corpus/raw/_incoming/` until provenance,
  license notes, hashes, and redistribution status are reviewed.
- Generated and mutated corpus PDFs need reproducible commands in
  `corpus/manifest.json`.
- Asset paths returned by the API are logical sidecar paths unless the caller
  writes returned assets. The conversion API does not currently write asset
  files to `assets.outputDir`.

## Dependency And Package Policy

- Project package manifests use the `0BSD` license.
- `scripts/qa/check-dependencies.mjs` validates manifest license fields and
  dependency license metadata from `package-lock.json`.
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
