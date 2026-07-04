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
const encryptedRc4FixturePath = new URL(
  "../../../corpus/generated/synthetic-encrypted-rc4-40.pdf",
  import.meta.url
);
const damagedXrefFixturePath = new URL(
  "../../../corpus/generated/synthetic-damaged-xref.pdf",
  import.meta.url
);
const linearizedFixturePath = new URL(
  "../../../corpus/generated/synthetic-linearized.pdf",
  import.meta.url
);
const qpdfObjectStreamFixturePath = new URL(
  "../../../corpus/generated/synthetic-qpdf-object-stream.pdf",
  import.meta.url
);
const incrementalFixturePath = new URL(
  "../../../corpus/generated/synthetic-incremental-update.pdf",
  import.meta.url
);

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

test("parsePdfDocument resolves outlines and uses them as structure signals", async () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObject(
      "BT /F1 12 Tf 20 200 Td (Outlined Section) Tj ET\nBT /F1 12 Tf 20 180 Td (Deep Dive) Tj ET\nBT /F1 12 Tf 20 160 Td (Body text.) Tj ET\n"
    ),
    "<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 2 >>",
    "<< /Title (Outlined Section) /Parent 6 0 R /First 8 0 R /Last 8 0 R /Count 1 >>",
    "<< /Title <FEFF004400650065007000200044006900760065> /Parent 7 0 R >>"
  ]);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);
  const outlineSummary = [
    { title: "Outlined Section", depth: 1 },
    { title: "Deep Dive", depth: 2 }
  ];

  assert.deepEqual(
    document.outlines.map(({ title, depth }) => ({ title, depth })),
    outlineSummary
  );
  assert.equal(result.markdown, "# Outlined Section\n\n## Deep Dive\n\nBody text.\n");
  assert.deepEqual(
    result.diagnostics.extraction.outlines.map(({ title, depth }) => ({ title, depth })),
    outlineSummary
  );
});

test("parsePdfDocument resolves tagged structure and uses consistent tags", async () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /StructParents 0 >>",
    streamObject(
      "/H2 << /MCID 0 >> BDC\nBT /F1 12 Tf 20 200 Td (Tagged Heading) Tj ET\nEMC\n/P << /MCID 1 >> BDC\nBT /F1 12 Tf 20 180 Td (Body text.) Tj ET\nEMC\n"
    ),
    "<< /Type /StructTreeRoot /K 7 0 R /RoleMap << /HeadingTwo /H2 >> >>",
    "<< /Type /StructElem /S /Document /K [8 0 R 9 0 R] >>",
    "<< /Type /StructElem /S /HeadingTwo /P 7 0 R /K << /Type /MCR /Pg 4 0 R /MCID 0 >> >>",
    "<< /Type /StructElem /S /P /P 7 0 R /K << /Type /MCR /Pg 4 0 R /MCID 1 >> >>"
  ]);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.structure.tagged, true);
  assert.deepEqual(document.structure.roleMap, { HeadingTwo: "H2" });
  assert.deepEqual(
    document.structure.markedContent.map(({ mcid, pageIndex, role, rawRole, path }) => ({
      mcid,
      pageIndex,
      role,
      rawRole,
      path
    })),
    [
      { mcid: 0, pageIndex: 0, role: "H2", rawRole: "HeadingTwo", path: ["Document", "H2"] },
      { mcid: 1, pageIndex: 0, role: "P", rawRole: "P", path: ["Document", "P"] }
    ]
  );
  assert.equal(result.markdown, "## Tagged Heading\n\nBody text.\n");
  assert.equal(result.diagnostics.extraction.structure.tagged, true);
  assert.equal(result.diagnostics.extraction.structure.markedContent, 2);
  assert.equal(result.diagnostics.extraction.structure.roles.H2, 1);
});

test("parsePdfDocument preserves tagged figure alt text", () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /StructParents 0 >>",
    streamObject("/Figure << /MCID 0 >> BDC\n20 200 120 80 re S\nEMC\n"),
    "<< /Type /StructTreeRoot /K 7 0 R >>",
    "<< /Type /StructElem /S /Document /K 8 0 R >>",
    "<< /Type /StructElem /S /Figure /P 7 0 R /Alt (Flow diagram showing intake and review) /K << /Type /MCR /Pg 4 0 R /MCID 0 >> >>"
  ]);
  const document = parsePdfDocument(bytes);

  assert.deepEqual(
    document.structure.elements.map(({ role, altText }) => ({ role, altText })),
    [
      { role: "Document", altText: undefined },
      { role: "Figure", altText: "Flow diagram showing intake and review" }
    ]
  );
  assert.deepEqual(document.structure.markedContent, [
    {
      mcid: 0,
      pageObjectNumber: 4,
      pageIndex: 0,
      role: "Figure",
      rawRole: "Figure",
      path: ["Document", "Figure"],
      altText: "Flow diagram showing intake and review"
    }
  ]);
});

test("convertPdfToMarkdown warns when tagged structure conflicts with layout", async () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R /StructParents 0 >>",
    streamObject(
      "BT /F1 12 Tf 20 220 Td (Body paragraph.) Tj ET\nBT /F1 12 Tf 20 200 Td (Another body paragraph.) Tj ET\n/H1 << /MCID 0 >> BDC\nBT /F1 6 Tf 20 160 Td (Tiny tagged heading) Tj ET\nEMC\n"
    ),
    "<< /Type /StructTreeRoot /K 7 0 R >>",
    "<< /Type /StructElem /S /Document /K 8 0 R >>",
    "<< /Type /StructElem /S /H1 /P 7 0 R /K << /Type /MCR /Pg 4 0 R /MCID 0 >> >>"
  ]);
  const result = await convertPdfToMarkdown(bytes);
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.TaggedStructureConflict
  );

  assert.equal(
    result.markdown,
    "Body paragraph.\n\nAnother body paragraph.\n\nTiny tagged heading\n"
  );
  assert.ok(warning);
  assert.equal(warning.details.conflicts, 1);
  assert.equal(warning.details.samples[0].reason, "font-size-below-body");
  assert.equal(warning.details.samples[0].role, "H1");
  assert.equal(result.diagnostics.extraction.taggedStructureConflicts, 1);
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

test("parsePdfDocument records metadata for raster image XObject filters", async () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> /XObject << /ImJpeg 6 0 R /ImJpx 7 0 R /ImFax 8 0 R /ImJbig 9 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObject("BT /F1 22 Tf 20 200 Td (Image Metadata Fixture) Tj ET\n"),
    imageStreamObject("/DCTDecode", "/DeviceRGB"),
    imageStreamObject("/JPXDecode", "/DeviceRGB"),
    imageStreamObject("/CCITTFaxDecode", "/DeviceGray"),
    imageStreamObject("/JBIG2Decode", "/DeviceGray")
  ]);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);
  const images = document.pages[0].resources.xobjects;

  assert.equal(document.streams.length, 5);
  assert.equal(images.ImJpeg.mediaType, "image/jpeg");
  assert.equal(images.ImJpeg.width, 8);
  assert.equal(images.ImJpeg.height, 4);
  assert.equal(images.ImJpeg.colorSpace, "DeviceRGB");
  assert.deepEqual(images.ImJpeg.filters, ["DCTDecode"]);
  assert.deepEqual(images.ImJpx.filters, ["JPXDecode"]);
  assert.deepEqual(images.ImFax.filters, ["CCITTFaxDecode"]);
  assert.deepEqual(images.ImJbig.filters, ["JBIG2Decode"]);
  assert.deepEqual(
    Object.values(images).map((image) => image.skippedFilters[0].reason),
    ["metadata-only", "metadata-only", "metadata-only", "metadata-only"]
  );
  assert.equal(result.markdown, "# Image Metadata Fixture\n");
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PdfParseFailed));
  assert.deepEqual(
    result.diagnostics.pages[0].images.map((image) => image.mediaType),
    ["image/jpeg", "image/jp2", "image/g3fax", "image/jbig2"]
  );
});

test("parsePdfDocument resolves xref stream entries", async () => {
  const bytes = createXrefStreamTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
    streamObject("BT /F1 22 Tf 20 200 Td (XRef Stream Fixture) Tj ET\n")
  ]);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.xrefMode, "xref-stream");
  assert.equal(document.trailer.entries.Size, 7);
  assert.equal(document.xrefEntries.length, 7);
  assert.equal(document.objects.size, 6);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].resources.fonts.F1.baseFont, "Helvetica");
  assert.equal(result.markdown, "# XRef Stream Fixture\n");
  assert.equal(result.diagnostics.extraction.parser.mode, "xref-stream");
});

test("parsePdfDocument resolves compressed object streams", async () => {
  const bytes = createObjectStreamTestPdf();
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.xrefMode, "xref-stream");
  assert.equal(document.objects.size, 7);
  assert.equal(document.getObject(4).compressed, true);
  assert.equal(document.getObject(6).objectStreamNumber, 3);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].objectNumber, 6);
  assert.equal(document.pages[0].contentStreams.length, 1);
  assert.equal(result.markdown, "# Object Stream Fixture\n");
  assert.equal(result.diagnostics.extraction.parser.objects, 7);
});

test("parsePdfDocument resolves incremental xref Prev chains with newest objects", async () => {
  const bytes = await readFile(incrementalFixturePath);
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.xrefMode, "classic-xref+prev");
  assert.equal(document.xrefSections.length, 2);
  assert.equal(document.getObject(1).offset, document.xrefEntries.find((entry) => entry.objectNumber === 1).offset);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].objectNumber, 7);
  assert.equal(result.markdown, "# Updated Incremental Fixture\n");
});

test("parsePdfDocument resolves hybrid-reference xref streams", async () => {
  const bytes = createHybridReferenceTestPdf();
  const document = parsePdfDocument(bytes);
  const result = await convertPdfToMarkdown(bytes);

  assert.equal(document.xrefMode, "classic-xref+hybrid-xref-stream");
  assert.equal(document.xrefSections.length, 1);
  assert.equal(document.getObject(4).compressed, true);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].objectNumber, 6);
  assert.equal(result.markdown, "# Hybrid Reference Fixture\n");
});

test("parsePdfDocument resolves qpdf-generated linearized and object-stream variants", async () => {
  const linearizedBytes = await readFile(linearizedFixturePath);
  const objectStreamBytes = await readFile(qpdfObjectStreamFixturePath);

  const linearizedDocument = parsePdfDocument(linearizedBytes);
  const linearizedResult = await convertPdfToMarkdown(linearizedBytes);
  const objectStreamDocument = parsePdfDocument(objectStreamBytes);
  const objectStreamResult = await convertPdfToMarkdown(objectStreamBytes);

  assert.equal(linearizedDocument.xrefMode, "classic-xref+prev");
  assert.equal(linearizedDocument.xrefSections.length, 2);
  assert.equal(linearizedDocument.pages.length, 1);
  assert.equal(linearizedResult.markdown, "# Synthetic Simple Text\n\nThis fixture validates basic paragraph extraction.\n\nThe expected output is deterministic.\n");
  assert.equal(objectStreamDocument.xrefMode, "xref-stream");
  assert.ok([...objectStreamDocument.objects.values()].some((object) => object.compressed === true));
  assert.equal(objectStreamDocument.pages.length, 1);
  assert.equal(objectStreamResult.markdown, "# Synthetic Simple Text\n\nThis fixture validates basic paragraph extraction.\n\nThe expected output is deterministic.\n");
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

test("tolerant parser repairs damaged xref tables by scanning object headers", async () => {
  const damaged = await readFile(damagedXrefFixturePath);

  assert.throws(
    () => parsePdfDocument(damaged),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.xref.entry_malformed"
  );

  const document = parsePdfDocument(damaged, { mode: "tolerant" });
  const result = await convertPdfToMarkdown(damaged, { parser: { mode: "tolerant" } });

  assert.equal(document.repaired, true);
  assert.equal(document.repairReason, "pdf.xref.entry_malformed");
  assert.equal(document.xrefMode, "object-scan-repair");
  assert.equal(document.startXref, null);
  assert.equal(document.pages.length, 1);
  assert.equal(
    result.markdown,
    "# Synthetic Simple Text\n\nThis fixture validates basic paragraph extraction.\n\nThe expected output is deterministic.\n"
  );
  assert.equal(result.diagnostics.extraction.parser.mode, "object-scan-repair");
  assert.equal(result.diagnostics.extraction.parser.repaired, true);
  assert.equal(result.diagnostics.extraction.parser.repairReason, "pdf.xref.entry_malformed");
});

test("tolerant object-scan repair enforces maxDepth while parsing discovered objects", () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R /Nested [[1]] >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>"
  ]);
  const damaged = corruptFirstXrefEntry(bytes);

  assert.throws(
    () => parsePdfDocument(damaged, { mode: "tolerant", maxDepth: 1 }),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.depth_limit_exceeded"
  );
});

test("unrecoverable tolerant repair failures report structured parse warnings", async () => {
  const damaged = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "binary");

  assert.throws(
    () => parsePdfDocument(damaged, { mode: "tolerant" }),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.repair.failed"
  );

  const result = await convertPdfToMarkdown(damaged, { parser: { mode: "tolerant" } });
  const warning = result.warnings.find((item) => item.code === warningCodes.PdfParseFailed);

  assert.ok(warning);
  assert.equal(warning.details.code, "pdf.repair.failed");
  assert.equal(result.markdown, "");
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.diagnostics.extraction.parser.warning.code, "pdf.repair.failed");
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

  assert.throws(
    () => parsePdfValue("[[1]]", { maxDepth: 1 }),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.depth_limit_exceeded"
  );

  assert.throws(
    () => parsePdfDocument(bytes, { deadline: 0 }),
    (error) => error.name === "TimeoutError" && error.message === "Operation timed out"
  );
});

test("parser enforces page tree depth limits", () => {
  const bytes = createTestPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 4 0 R /MediaBox [0 0 300 400] >>"
  ]);

  assert.throws(
    () => parsePdfDocument(bytes, { maxDepth: 2 }),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.depth_limit_exceeded"
  );
});

test("parser and converter reject encrypted PDFs without a password", async () => {
  const bytes = createEncryptedTestPdf("Encrypted Fixture");

  assert.throws(
    () => parsePdfDocument(bytes),
    (error) =>
      error instanceof PdfSyntaxError && error.code === "pdf.encryption.password_required"
  );

  const result = await convertPdfToMarkdown(bytes);
  const passwordWarning = result.warnings.find(
    (warning) => warning.code === warningCodes.PasswordRequired
  );

  assert.ok(passwordWarning);
  assert.equal(passwordWarning.details.code, "pdf.encryption.password_required");
  assert.equal(result.markdown, "");
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PdfParseFailed));
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.diagnostics.extraction.textLines, 0);
});

test("converter invokes password callback and reports unsupported encrypted PDFs", async () => {
  const bytes = createEncryptedTestPdf("Encrypted Password Fixture");
  const secret = "top-secret-password-please-do-not-leak";
  let calls = 0;
  let request = null;

  assert.throws(
    () => parsePdfDocument(bytes, { password: secret }),
    (error) => error instanceof PdfSyntaxError && error.code === "pdf.encryption.unsupported"
  );

  const result = await convertPdfToMarkdown(bytes, {
    password: async (callbackRequest) => {
      calls += 1;
      request = callbackRequest;
      return secret;
    }
  });
  const unsupportedWarning = result.warnings.find(
    (warning) => warning.code === warningCodes.UnsupportedEncryption
  );

  assert.equal(calls, 1);
  assert.deepEqual(request, { reason: "encrypted-pdf" });
  assert.ok(unsupportedWarning);
  assert.equal(unsupportedWarning.details.code, "pdf.encryption.unsupported");
  assert.equal(unsupportedWarning.details.passwordProvided, true);
  assert.equal(unsupportedWarning.details.passwordSource, "callback");
  assert.equal(result.markdown, "");
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PasswordRequired));
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PdfParseFailed));
  assert.equal(result.diagnostics.options.passwordProvided, true);
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.diagnostics.extraction.parser.warning.code, "pdf.encryption.unsupported");
  assert.equal(result.diagnostics.extraction.textLines, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("parser and converter decrypt Standard revision 2 RC4-40 PDFs with the user password", async () => {
  const bytes = await readFile(encryptedRc4FixturePath);
  const secret = "userpass";

  assert.throws(
    () => parsePdfDocument(bytes),
    (error) =>
      error instanceof PdfSyntaxError && error.code === "pdf.encryption.password_required"
  );

  const document = parsePdfDocument(bytes, { password: secret });
  const result = await convertPdfToMarkdown(bytes, { password: secret });

  assert.equal(document.pages.length, 1);
  assert.match(document.pages[0].contentStreams[0].text, /Synthetic Simple Text/);
  assert.equal(
    result.markdown,
    "# Synthetic Simple Text\n\nThis fixture validates basic paragraph extraction.\n\nThe expected output is deterministic.\n"
  );
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PasswordRequired));
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PasswordIncorrect));
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.UnsupportedEncryption));
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.PdfParseFailed));
  assert.equal(result.diagnostics.extraction.parser.mode, "classic-xref");
  assert.equal(result.diagnostics.extraction.textLines, 3);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("converter reports wrong passwords for Standard revision 2 RC4-40 PDFs", async () => {
  const bytes = await readFile(encryptedRc4FixturePath);
  const result = await convertPdfToMarkdown(bytes, { password: "wrongpass" });
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.PasswordIncorrect
  );

  assert.throws(
    () => parsePdfDocument(bytes, { password: "wrongpass" }),
    (error) =>
      error instanceof PdfSyntaxError && error.code === "pdf.encryption.password_incorrect"
  );
  assert.ok(warning);
  assert.equal(warning.details.code, "pdf.encryption.password_incorrect");
  assert.equal(warning.details.passwordProvided, true);
  assert.equal(warning.details.passwordSource, "string");
  assert.equal(result.markdown, "");
  assert.ok(!result.warnings.some((item) => item.code === warningCodes.PdfParseFailed));
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
  assert.equal(result.diagnostics.extraction.parser.warning.code, "pdf.encryption.password_incorrect");
  assert.equal(result.diagnostics.extraction.textLines, 0);
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

test("public converter reports malformed xref streams as warnings", async () => {
  const malformedXrefStream = Buffer.from(
    "%PDF-1.5\n1 0 obj\n<< /Type /XRef /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n",
    "latin1"
  );
  const result = await convertPdfToMarkdown(malformedXrefStream);
  const parseWarning = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);

  assert.ok(parseWarning);
  assert.equal(parseWarning.details.code, "pdf.xref.stream_size_malformed");
  assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
});

function createTestPdf(objects, { trailerEntries = "" } = {}) {
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
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerEntries} >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function corruptFirstXrefEntry(bytes) {
  return Buffer.from(
    bytes.toString("binary").replace("0000000000 65535 f", "xxxxxxxxxx 65535 f"),
    "binary"
  );
}

function createEncryptedTestPdf(label) {
  return createTestPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [4 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 300 400] >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>",
      streamObject(`BT /F1 22 Tf 20 200 Td (${label}) Tj ET\n`),
      "<< /Filter /Standard /V 1 /R 2 /Length 40 >>"
    ],
    { trailerEntries: " /Encrypt 6 0 R" }
  );
}

function createXrefStreamTestPdf(objects) {
  let body = "%PDF-1.5\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    const objectId = index + 1;
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${object}\nendobj\n`;
  });

  const xrefObjectId = objects.length + 1;
  offsets[xrefObjectId] = Buffer.byteLength(body, "binary");
  const xrefStream = createXrefStreamBytes(offsets);
  body += `${xrefObjectId} 0 obj\n`;
  body += `<< /Type /XRef /Size ${xrefObjectId + 1} /Root 1 0 R /W [1 4 2] /Length ${xrefStream.byteLength} >>\n`;
  body += `stream\n${xrefStream.toString("binary")}endstream\nendobj\n`;
  body += `startxref\n${offsets[xrefObjectId]}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function createObjectStreamTestPdf() {
  let body = "%PDF-1.5\n";
  const offsets = [0];
  const directObjects = [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamObject("BT /F1 22 Tf 20 200 Td (Object Stream Fixture) Tj ET\n"),
    objectStreamObject([
      { objectNumber: 4, value: "<< /Type /Catalog /Pages 5 0 R >>" },
      {
        objectNumber: 5,
        value: "<< /Type /Pages /Kids [6 0 R] /Count 1 /Resources << /Font << /F1 1 0 R >> >> /MediaBox [0 0 300 400] >>"
      },
      { objectNumber: 6, value: "<< /Type /Page /Parent 5 0 R /Contents 2 0 R >>" }
    ])
  ];

  directObjects.forEach((object, index) => {
    const objectId = index + 1;
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${object}\nendobj\n`;
  });

  const xrefObjectId = 7;
  offsets[xrefObjectId] = Buffer.byteLength(body, "binary");
  const xrefStream = createObjectStreamXrefBytes(offsets, xrefObjectId);
  body += `${xrefObjectId} 0 obj\n`;
  body += `<< /Type /XRef /Size ${xrefObjectId + 1} /Root 4 0 R /W [1 4 2] /Length ${xrefStream.byteLength} >>\n`;
  body += `stream\n${xrefStream.toString("binary")}endstream\nendobj\n`;
  body += `startxref\n${offsets[xrefObjectId]}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function createHybridReferenceTestPdf() {
  let body = "%PDF-1.5\n";
  const offsets = [0];
  const directObjects = [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamObject("BT /F1 22 Tf 20 200 Td (Hybrid Reference Fixture) Tj ET\n"),
    objectStreamObject([
      { objectNumber: 4, value: "<< /Type /Catalog /Pages 5 0 R >>" },
      {
        objectNumber: 5,
        value: "<< /Type /Pages /Kids [6 0 R] /Count 1 /Resources << /Font << /F1 1 0 R >> >> /MediaBox [0 0 300 400] >>"
      },
      { objectNumber: 6, value: "<< /Type /Page /Parent 5 0 R /Contents 2 0 R >>" }
    ])
  ];

  directObjects.forEach((object, index) => {
    const objectId = index + 1;
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${object}\nendobj\n`;
  });

  const xrefStreamObjectId = 7;
  offsets[xrefStreamObjectId] = Buffer.byteLength(body, "binary");
  const xrefStream = createHybridXrefStreamBytes();
  body += `${xrefStreamObjectId} 0 obj\n`;
  body += `<< /Type /XRef /Size 8 /Index [4 3] /W [1 4 2] /Length ${xrefStream.byteLength} >>\n`;
  body += `stream\n${xrefStream.toString("binary")}endstream\nendobj\n`;

  const classicXrefOffset = Buffer.byteLength(body, "binary");
  body += "xref\n0 8\n";
  body += "0000000000 65535 f\n";
  body += `${xrefLine(offsets[1], 0, true)}\n`;
  body += `${xrefLine(offsets[2], 0, true)}\n`;
  body += `${xrefLine(offsets[3], 0, true)}\n`;
  body += `${xrefLine(0, 0, false)}\n`;
  body += `${xrefLine(0, 0, false)}\n`;
  body += `${xrefLine(0, 0, false)}\n`;
  body += `${xrefLine(offsets[xrefStreamObjectId], 0, true)}\n`;
  body += `trailer\n<< /Size 8 /Root 4 0 R /XRefStm ${offsets[xrefStreamObjectId]} >>\n`;
  body += `startxref\n${classicXrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function createHybridXrefStreamBytes() {
  const bytes = Buffer.alloc(21);
  writeXrefStreamEntry(bytes, 0, 2, 3, 0);
  writeXrefStreamEntry(bytes, 7, 2, 3, 1);
  writeXrefStreamEntry(bytes, 14, 2, 3, 2);
  return bytes;
}

function xrefLine(offset, generationNumber, inUse) {
  return `${String(offset).padStart(10, "0")} ${String(generationNumber).padStart(5, "0")} ${inUse ? "n" : "f"}`;
}

function createXrefStreamBytes(offsets) {
  const bytes = Buffer.alloc(offsets.length * 7);
  writeXrefStreamEntry(bytes, 0, 0, 0, 65535);
  for (let objectId = 1; objectId < offsets.length; objectId += 1) {
    writeXrefStreamEntry(bytes, objectId * 7, 1, offsets[objectId], 0);
  }
  return bytes;
}

function createObjectStreamXrefBytes(offsets, xrefObjectId) {
  const bytes = Buffer.alloc((xrefObjectId + 1) * 7);
  writeXrefStreamEntry(bytes, 0, 0, 0, 65535);
  writeXrefStreamEntry(bytes, 7, 1, offsets[1], 0);
  writeXrefStreamEntry(bytes, 14, 1, offsets[2], 0);
  writeXrefStreamEntry(bytes, 21, 1, offsets[3], 0);
  writeXrefStreamEntry(bytes, 28, 2, 3, 0);
  writeXrefStreamEntry(bytes, 35, 2, 3, 1);
  writeXrefStreamEntry(bytes, 42, 2, 3, 2);
  writeXrefStreamEntry(bytes, 49, 1, offsets[xrefObjectId], 0);
  return bytes;
}

function writeXrefStreamEntry(bytes, offset, type, field2, field3) {
  bytes[offset] = type;
  bytes.writeUInt32BE(field2, offset + 1);
  bytes.writeUInt16BE(field3, offset + 5);
}

function objectStreamObject(objects) {
  let currentOffset = 0;
  const offsets = objects.map((object) => {
    const offset = currentOffset;
    currentOffset += Buffer.byteLength(object.value, "binary") + 1;
    return offset;
  });
  const header = objects
    .map((object, index) => `${object.objectNumber} ${offsets[index]}`)
    .join(" ");
  const values = objects.map((object) => object.value).join(" ");
  const objectStream = `${header} ${values}`;
  const first = Buffer.byteLength(`${header} `, "binary");
  return streamObject(deflateSync(Buffer.from(objectStream, "binary")), `/Type /ObjStm /N ${objects.length} /First ${first} /Filter /FlateDecode`);
}

function imageStreamObject(filter, colorSpace) {
  return streamObject(
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    `/Type /XObject /Subtype /Image /Width 8 /Height 4 /BitsPerComponent 8 /ColorSpace ${colorSpace} /Filter ${filter}`
  );
}

function streamObject(contents, extraDictionary = "") {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "binary") : Buffer.from(contents);
  return `<< /Length ${bytes.byteLength}${extraDictionary ? ` ${extraDictionary}` : ""} >>\nstream\n${bytes.toString("binary")}endstream`;
}

function streamObjectWithLength(contents, length) {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "binary") : Buffer.from(contents);
  return `<< /Length ${length} >>\nstream\n${bytes.toString("binary")}endstream`;
}
