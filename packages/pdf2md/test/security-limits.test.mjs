import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown, warningCodes } from "../src/index.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);

test("converter reports maxBytes violations without panicking", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    security: { maxBytes: bytes.byteLength - 1 }
  });

  assert.ok(result.warnings.some((warning) => warning.code === warningCodes.InputTooLarge));
  const parseFailure = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);
  assert.equal(parseFailure?.details.code, "pdf.input_too_large");
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.markdown, "");
  assert.equal(result.diagnostics.extraction.textLines, 0);
});

test("converter enforces maxPages before page extraction", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    security: { maxPages: 0 }
  });
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.PageCountExceeded
  );

  assert.equal(warning?.details.pages, 1);
  assert.equal(warning?.details.maxPages, 0);
  assert.equal(result.diagnostics.options.maxPages, 0);
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.diagnostics.extraction.parser.warning.code, warningCodes.PageCountExceeded);
  assert.equal(result.markdown, "");
  assert.equal(result.ir.pages.length, 0);
});

test("converter enforces maxDecodedStreamBytes before fallback extraction", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    security: { maxDecodedStreamBytes: 1 }
  });
  const parseFailure = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);

  assert.equal(parseFailure?.details.code, "pdf.stream.decoded_too_large");
  assert.equal(result.diagnostics.options.maxDecodedStreamBytes, 1);
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.markdown, "");
  assert.equal(result.diagnostics.extraction.textLines, 0);
});

test("converter validates maxTotalDecodedStreamBytes", async () => {
  const bytes = await readFile(fixturePath);

  await assert.rejects(
    () => convertPdfToMarkdown(bytes, { security: { maxTotalDecodedStreamBytes: -1 } }),
    (error) =>
      error instanceof RangeError &&
      error.message === "security.maxTotalDecodedStreamBytes must be a non-negative integer"
  );
});

test("converter enforces maxDepth before fallback extraction", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    security: { maxDepth: 0 }
  });
  const parseFailure = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);

  assert.equal(parseFailure?.details.code, "pdf.depth_limit_exceeded");
  assert.equal(result.diagnostics.options.maxDepth, 0);
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.markdown, "");
  assert.equal(result.diagnostics.extraction.textLines, 0);
});

test("converter reports maxObjects violations without panicking", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    security: { maxObjects: 1 }
  });
  const parseFailure = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);

  assert.equal(parseFailure?.details.code, "pdf.object_limit_exceeded");
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.markdown, "");
  assert.equal(result.diagnostics.extraction.textLines, 0);
});

test("converter validates maxCMapMappings", async () => {
  const bytes = await readFile(fixturePath);

  await assert.rejects(
    () => convertPdfToMarkdown(bytes, { security: { maxCMapMappings: -1 } }),
    (error) =>
      error instanceof RangeError &&
      error.message === "security.maxCMapMappings must be a non-negative integer"
  );
});

test("converter enforces maxImagePixels for raster page targets", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    raster: { enabled: true, dpi: 144 },
    security: { maxImagePixels: 1000 }
  });
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.ImagePixelsExceeded && item.details.target === "page"
  );
  const thumbnailWarning = result.warnings.find(
    (item) => item.code === warningCodes.ImagePixelsExceeded && item.details.target === "thumbnail"
  );

  assert.equal(result.diagnostics.options.maxImagePixels, 1000);
  assert.equal(result.diagnostics.extraction.raster.limitedPages, 1);
  assert.equal(result.diagnostics.extraction.raster.limitedThumbnails, 1);
  assert.equal(result.diagnostics.extraction.raster.pages[0].status, "skipped-pixel-limit");
  assert.equal(result.diagnostics.extraction.raster.pages[0].pixelCount, 1938816);
  assert.equal(result.diagnostics.extraction.raster.pages[0].thumbnail.status, "skipped-pixel-limit");
  assert.equal(warning?.details.pageIndex, 0);
  assert.equal(warning?.details.pixelCount, 1938816);
  assert.equal(warning?.details.maxImagePixels, 1000);
  assert.equal(thumbnailWarning?.details.pageIndex, 0);
  assert.equal(thumbnailWarning?.details.pixelCount, 121176);
});

test("converter rejects a pre-aborted signal", async () => {
  const bytes = await readFile(fixturePath);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => convertPdfToMarkdown(bytes, { signal: controller.signal }),
    (error) => error.name === "AbortError" && error.message === "Operation aborted"
  );
});

test("converter enforces timeoutMs checkpoints", async () => {
  const bytes = await readFile(fixturePath);

  await assert.rejects(
    () => convertPdfToMarkdown(bytes, { security: { timeoutMs: 0 } }),
    (error) => error.name === "TimeoutError" && error.message === "Operation timed out"
  );
});
