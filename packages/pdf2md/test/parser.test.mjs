import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ByteReader,
  PdfSyntaxError,
  parsePdfDocument,
  parsePdfValue
} from "../src/pdf-parser.mjs";
import { convertPdfToMarkdown, warningCodes } from "../src/index.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);

test("parsePdfValue parses primitive object types", () => {
  const parsed = parsePdfValue(
    "<< /Name /Example#20Name /Nums [1 -2 3.5] /Flag true /Missing null /Text (hi\\nthere) /Hex <4869> /Ref 3 0 R >>"
  );
  const entries = parsed.value.entries;

  assert.equal(parsed.value.type, "dict");
  assert.deepEqual(entries.Name, { type: "name", value: "Example Name" });
  assert.deepEqual(entries.Nums.items, [1, -2, 3.5]);
  assert.equal(entries.Flag, true);
  assert.equal(entries.Missing, null);
  assert.equal(entries.Text, "hi\nthere");
  assert.deepEqual(entries.Hex, { type: "hex-string", value: "4869" });
  assert.deepEqual(entries.Ref, { type: "ref", objectNumber: 3, generationNumber: 0 });
});

test("parsePdfDocument resolves classic xref entries, trailer, objects, and streams", async () => {
  const bytes = await readFile(fixturePath);
  const document = parsePdfDocument(bytes);

  assert.equal(document.version, "1.4");
  assert.equal(document.trailer.entries.Size, 6);
  assert.deepEqual(document.trailer.entries.Root, { type: "ref", objectNumber: 1, generationNumber: 0 });
  assert.equal(document.xrefEntries.length, 6);
  assert.equal(document.objects.size, 5);
  assert.equal(document.streams.length, 1);
  assert.match(document.getObject(5).stream.text, /Synthetic Simple Text/);
});

test("parser reports bounded byte-reader and syntax errors with codes and offsets", async () => {
  const bytes = await readFile(fixturePath);

  assert.throws(
    () => new ByteReader(bytes, { maxBytes: 1 }),
    (error) =>
      error instanceof PdfSyntaxError &&
      error.code === "pdf.input_too_large" &&
      error.offset === 1
  );

  assert.throws(
    () => parsePdfValue("[1 2"),
    (error) =>
      error instanceof PdfSyntaxError &&
      error.code === "pdf.array.unterminated" &&
      Number.isInteger(error.offset)
  );
});

test("public converter uses parsed content streams for generated PDFs", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname);

  assert.equal(result.diagnostics.extraction.mode, "parsed-uncompressed-streams");
  assert.equal(result.diagnostics.extraction.parser.mode, "classic-xref");
  assert.equal(result.diagnostics.extraction.parser.objects, 5);
  assert.equal(result.diagnostics.extraction.parser.streams, 1);
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PdfParseFailed));
});

test("public converter reports unsupported parser structures as warnings", async () => {
  const unsupportedXrefStream = Buffer.from(
    "%PDF-1.5\n1 0 obj\n<< /Type /XRef /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n",
    "latin1"
  );
  const result = await convertPdfToMarkdown(unsupportedXrefStream);
  const parseWarning = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);

  assert.ok(parseWarning);
  assert.equal(parseWarning.details.code, "pdf.xref.unsupported");
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
});
