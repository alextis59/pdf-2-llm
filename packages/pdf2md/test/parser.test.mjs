import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
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
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].widthPt, 612);
  assert.equal(document.pages[0].heightPt, 792);
  assert.equal(document.pages[0].rotation, 0);
  assert.equal(document.pages[0].contentStreams.length, 1);
  assert.equal(document.pages[0].resources.fonts.F1.baseFont, "Helvetica");
  assert.match(document.getObject(5).stream.text, /Synthetic Simple Text/);
});

test("parsePdfDocument resolves nested page trees and inherited resources", () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] /Rotate 90 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 /CropBox [10 20 210 220] >>",
    "<< /Type /Page /Parent 4 0 R /Contents 6 0 R /UserUnit 2 >>",
    streamObject("BT /F1 12 Tf 20 200 Td (Nested Page) Tj ET\n")
  ]);
  const document = parsePdfDocument(bytes);
  const page = document.pages[0];

  assert.equal(document.pages.length, 1);
  assert.deepEqual(page.mediaBox, [0, 0, 300, 400]);
  assert.deepEqual(page.cropBox, [10, 20, 210, 220]);
  assert.equal(page.widthPt, 400);
  assert.equal(page.heightPt, 400);
  assert.equal(page.rotation, 90);
  assert.equal(page.userUnit, 2);
  assert.equal(page.contentStreams.length, 1);
  assert.equal(page.resources.fonts.F1.objectNumber, 3);
  assert.equal(page.resources.fonts.F1.encoding, "WinAnsiEncoding");
});

test("parsePdfDocument decodes Flate content streams for text extraction", async () => {
  const content = "BT /F1 22 Tf 20 200 Td (Compressed Fixture) Tj ET\n";
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObject(deflateSync(Buffer.from(content, "latin1")), "/Filter /FlateDecode")
  ]);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.pages[0].contentStreams[0].filters[0], "FlateDecode");
  assert.match(document.pages[0].contentStreams[0].text, /Compressed Fixture/);
  assert.equal(result.markdown, "# Compressed Fixture\n");
  assert.equal(result.diagnostics.extraction.mode, "parsed-content-streams");
});

test("parsePdfDocument applies ToUnicode CMaps during conversion", async () => {
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    "<00> <FF>",
    "endcodespacerange",
    "1 beginbfchar",
    "<01> <0041>",
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end"
  ].join("\n");
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /CustomEncoding /ToUnicode 4 0 R >>",
    streamObject(toUnicode),
    "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>",
    streamObject("BT /F1 22 Tf 20 200 Td <01> Tj ET\n")
  ]);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.pages[0].resources.fonts.F1.toUnicodeEntries, 1);
  assert.equal(result.markdown, "# A\n");
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.TextUnicodeMappingSuspect));
});

test("convertPdfToMarkdown warns for suspicious font mappings without ToUnicode", async () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /CustomEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObject("BT /F1 12 Tf 20 200 Td (A) Tj ET\n")
  ]);
  const result = await convertPdfToMarkdown(bytes);
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.TextUnicodeMappingSuspect
  );

  assert.ok(warning);
  assert.equal(warning.details.fontName, "F1");
  assert.equal(warning.details.encoding, "CustomEncoding");
});

test("parsePdfDocument reports corrupt stream filters with structured syntax errors", () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObject(Buffer.from("not flate", "latin1"), "/Filter /FlateDecode")
  ]);

  assert.throws(
    () => parsePdfDocument(bytes),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.stream.flate_failed"
  );
});

test("parsePdfDocument supports strict and tolerant stream length handling", async () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObjectWithLength("BT /F1 22 Tf 20 200 Td (Tolerant Fixture) Tj ET\n", 999999)
  ]);

  assert.throws(
    () => parsePdfDocument(bytes),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.stream.length_out_of_bounds"
  );

  const document = parsePdfDocument(bytes, { mode: "tolerant" });
  const result = await convertPdfToMarkdown(bytes, { parser: { mode: "tolerant" } });

  assert.match(document.pages[0].contentStreams[0].text, /Tolerant Fixture/);
  assert.equal(result.markdown, "# Tolerant Fixture\n");
  assert.equal(result.diagnostics.options.parserMode, "tolerant");
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

  assert.equal(result.diagnostics.extraction.mode, "parsed-content-streams");
  assert.equal(result.diagnostics.extraction.parser.mode, "classic-xref");
  assert.equal(result.diagnostics.extraction.parser.objects, 5);
  assert.equal(result.diagnostics.extraction.parser.streams, 1);
  assert.equal(result.diagnostics.extraction.parser.pages, 1);
  assert.equal(result.ir.pages.length, 1);
  assert.equal(result.ir.pages[0].widthPt, 612);
  assert.equal(result.ir.pages[0].heightPt, 792);
  assert.deepEqual(result.diagnostics.pages[0].fonts, ["F1"]);
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

function createTestPdf(objects) {
  let body = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    const objectId = index + 1;
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f\n";
  for (let objectId = 1; objectId <= objects.length; objectId += 1) {
    body += `${String(offsets[objectId]).padStart(10, "0")} 00000 n\n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function streamObject(contents, extraDictionary = "") {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "binary") : Buffer.from(contents);
  return `<< /Length ${bytes.byteLength}${extraDictionary ? ` ${extraDictionary}` : ""} >>\nstream\n${bytes.toString("binary")}endstream`;
}

function streamObjectWithLength(contents, length) {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "binary") : Buffer.from(contents);
  return `<< /Length ${length} >>\nstream\n${bytes.toString("binary")}endstream`;
}
