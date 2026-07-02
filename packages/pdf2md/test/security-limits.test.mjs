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
