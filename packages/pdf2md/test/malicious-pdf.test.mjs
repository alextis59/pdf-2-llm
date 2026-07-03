import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown, warningCodes } from "../src/index.mjs";

const maliciousFixtures = [
  {
    id: "deep-page-tree",
    bytes: createDeepPageTreePdf(12),
    options: { security: { maxDepth: 4 } },
    expectedCode: "pdf.depth_limit_exceeded",
    blocksFallback: true
  },
  {
    id: "cyclic-page-tree",
    bytes: createCyclicPageTreePdf(),
    expectedCode: "pdf.pages.cycle",
    blocksFallback: false
  },
  {
    id: "object-count-flood",
    bytes: createObjectFloodPdf(32),
    options: { security: { maxObjects: 8 } },
    expectedCode: "pdf.object_limit_exceeded",
    blocksFallback: true
  },
  {
    id: "flate-expansion-stream",
    bytes: createFlateExpansionPdf(),
    options: { security: { maxDecodedStreamBytes: 64 } },
    expectedCode: "pdf.stream.decoded_too_large",
    blocksFallback: true
  },
  {
    id: "malformed-xref-stream-widths",
    bytes: createMalformedXrefStreamPdf(),
    expectedCode: "pdf.xref.stream_w_malformed",
    blocksFallback: false
  }
];

for (const fixture of maliciousFixtures) {
  test(`malicious PDF fixture ${fixture.id} reports a structured parse warning`, async () => {
    const result = await convertPdfToMarkdown(fixture.bytes, {
      ...fixture.options,
      ocr: { enabled: false }
    });
    const parseFailure = result.warnings.find(
      (warning) => warning.code === warningCodes.PdfParseFailed
    );

    assert.equal(parseFailure?.details?.code, fixture.expectedCode);
    assert.equal(result.diagnostics.extraction.parser.mode, "unavailable");
    if (fixture.blocksFallback) {
      assert.equal(result.markdown, "");
      assert.equal(result.diagnostics.extraction.textLines, 0);
    }
  });
}

function createDeepPageTreePdf(depth) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
  ];

  for (let objectId = 3; objectId < 3 + depth; objectId += 1) {
    const nextObjectId = objectId + 1;
    objects.push(`<< /Type /Pages /Kids [${nextObjectId} 0 R] /Count 1 >>`);
  }
  objects.push(
    `<< /Type /Page /Parent ${objects.length} 0 R /MediaBox [0 0 300 400] /Resources << >> >>`
  );

  return createPdf(objects);
}

function createCyclicPageTreePdf() {
  return createPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [2 0 R] /Count 1 >>"
  ]);
}

function createObjectFloodPdf(count) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [] /Count 0 >>"
  ];
  for (let index = 0; index < count; index += 1) {
    objects.push(`<< /FloodIndex ${index} >>`);
  }
  return createPdf(objects);
}

function createFlateExpansionPdf() {
  const inflated = Buffer.from("A".repeat(4096), "ascii");
  const compressed = deflateSync(inflated);
  return createPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R >>",
    streamObject(compressed, "/Filter /FlateDecode")
  ]);
}

function createMalformedXrefStreamPdf() {
  let body = "%PDF-1.5\n% pdf-2-llm malicious regression fixture\n";
  body += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  body += "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n";
  const xrefOffset = Buffer.byteLength(body, "binary");
  body += "3 0 obj\n";
  body += "<< /Type /XRef /Size 4 /Root 1 0 R /W [0 0 0] /Length 0 >>\n";
  body += "stream\n\nendstream\nendobj\n";
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

function streamObject(content, extraDictionary = "") {
  const bytes = Buffer.from(content);
  return `<< /Length ${bytes.byteLength}${extraDictionary ? ` ${extraDictionary}` : ""} >>\nstream\n${bytes.toString("binary")}\nendstream`;
}

function createPdf(objects) {
  let body = "%PDF-1.4\n% pdf-2-llm malicious regression fixture\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(body, "binary");
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f\n";
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n\n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, "binary");
}
