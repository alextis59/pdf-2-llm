import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown, warningCodes } from "../src/index.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);
const twoColumnFixturePath = new URL(
  "../../../corpus/generated/synthetic-two-column.pdf",
  import.meta.url
);
const footnoteFixturePath = new URL(
  "../../../corpus/generated/synthetic-footnote.pdf",
  import.meta.url
);
const headerFooterFixturePath = new URL(
  "../../../corpus/generated/synthetic-header-footer.pdf",
  import.meta.url
);
const vectorFigureFixturePath = new URL(
  "../../../corpus/generated/synthetic-vector-figure.pdf",
  import.meta.url
);
const visibleTableFixturePath = new URL(
  "../../../corpus/generated/synthetic-visible-table.pdf",
  import.meta.url
);

test("convertPdfToMarkdown returns the scaffold contract for a corpus PDF", async () => {
  const bytes = await readFile(fixturePath);
  const progress = [];
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    onProgress(event) {
      progress.push(event.stage);
    }
  });

  assert.match(result.markdown, /^# Synthetic Simple Text/);
  assert.equal(result.ir.schemaVersion, "0.1.0");
  assert.equal(result.ir.sourceType, "digital");
  assert.equal(result.ir.pages.length, 1);
  assert.equal(result.ir.pages[0].widthPt, 612);
  assert.equal(result.ir.pages[0].heightPt, 792);
  assert.equal(result.sourceMap.schemaVersion, "0.1.0");
  assert.equal(result.sourceMap.target, "markdown");
  assert.equal(result.sourceMap.entries[0].kind, "heading");
  assert.match(
    result.markdown.slice(
      result.sourceMap.entries[0].markdownStart,
      result.sourceMap.entries[0].markdownEnd
    ),
    /^# Synthetic Simple Text/
  );
  assert.equal(result.sourceMap.entries[0].regions[0].pageIndex, 0);
  assert.equal(result.diagnostics.input.bytes, bytes.byteLength);
  assert.equal(result.diagnostics.input.pdfVersion, "1.4");
  assert.equal(result.diagnostics.input.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.diagnostics.extraction.layout.pages[0].kind, "single-column");
  assert.equal(result.confidence.layout, 0.35);
  assert.deepEqual(progress, ["start", "complete"]);
  assert.ok(result.warnings.some((warning) => warning.code === warningCodes.HeuristicTextExtraction));
  assert.ok(result.warnings.some((warning) => warning.code === warningCodes.OcrDisabled));
});

test("convertPdfToMarkdown supports path input", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname);
  assert.equal(result.diagnostics.input.source.type, "path");
  assert.equal(result.diagnostics.input.pdfVersion, "1.4");
});

test("convertPdfToMarkdown can emit Markdown page anchors", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname, {
    markdown: { pageAnchors: true }
  });

  assert.match(result.markdown, /^<a id="page-1"><\/a>\n\n# Synthetic Simple Text/);
  assert.equal(result.diagnostics.options.pageAnchors, true);
});

test("convertPdfToMarkdown can preserve configured running titles", async () => {
  const result = await convertPdfToMarkdown(headerFooterFixturePath.pathname, {
    markdown: { preserveRunningTitles: true }
  });

  assert.match(result.markdown, /^Running Header\n\n# Header Footer Fixture/);
  assert.match(result.markdown, /Running Header\n\nSecond page body\./);
  assert.doesNotMatch(result.markdown, /Page Footer/);
  assert.equal(result.diagnostics.options.preserveRunningTitles, true);
});

test("convertPdfToMarkdown exposes the selected scoped raster path when enabled", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname, {
    raster: { enabled: true, dpi: 144 }
  });

  assert.equal(result.diagnostics.options.rasterEnabled, true);
  assert.equal(result.diagnostics.options.rasterRenderer, "internal-page-geometry");
  assert.equal(result.diagnostics.options.rasterDpi, 144);
  assert.equal(result.diagnostics.extraction.raster.enabled, true);
  assert.equal(result.diagnostics.extraction.raster.dpi, 144);
  assert.equal(result.diagnostics.extraction.raster.renderer.id, "internal-page-geometry");
  assert.equal(result.diagnostics.extraction.raster.renderer.dependency, null);
  assert.equal(result.diagnostics.extraction.raster.renderer.status, "selected");
  assert.deepEqual(result.diagnostics.extraction.raster.pages, [
    {
      pageIndex: 0,
      status: "planned",
      sourceBox: "mediaBox",
      boxPt: [0, 0, 612, 792],
      sourceWidthPt: 612,
      sourceHeightPt: 792,
      widthPt: 612,
      heightPt: 792,
      dpi: 144,
      scale: 2,
      widthPx: 1224,
      heightPx: 1584,
      pixelCount: 1938816,
      rotation: 0,
      quarterTurn: false,
      userUnit: 1
    }
  ]);
});

test("CLI emits JSON scaffold output", () => {
  const cliPath = new URL("../src/cli.mjs", import.meta.url);
  const run = spawnSync(process.execPath, [cliPath.pathname, fixturePath.pathname, "--json"], {
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.diagnostics.input.pdfVersion, "1.4");
  assert.ok(
    result.warnings.some((warning) => warning.code === warningCodes.HeuristicTextExtraction)
  );
});

test("convertPdfToMarkdown warns when content stream order may be uncertain", async () => {
  const result = await convertPdfToMarkdown(twoColumnFixturePath.pathname);
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.TextOrderingUncertain
  );

  assert.ok(warning);
  assert.equal(warning.details.pageIndex, 0);
  assert.match(warning.details.previous.text, /Left column continues/);
  assert.match(warning.details.current.text, /Right column starts/);
  assert.equal(result.diagnostics.extraction.layout.pages[0].kind, "multi-column");
  assert.deepEqual(
    result.diagnostics.extraction.layout.pages[0].columns.map((column) => column.index),
    [0, 1]
  );
});

test("convertPdfToMarkdown reports footnote layout regions", async () => {
  const result = await convertPdfToMarkdown(footnoteFixturePath.pathname);
  const page = result.diagnostics.extraction.layout.pages[0];

  assert.equal(page.footnotes.length, 1);
  assert.equal(page.footnotes[0].kind, "footnote");
  assert.match(result.markdown, /1\. Footnote text belongs after the paragraph\./);
});

test("convertPdfToMarkdown reports figure caption layout regions", async () => {
  const result = await convertPdfToMarkdown(vectorFigureFixturePath.pathname);
  const page = result.diagnostics.extraction.layout.pages[0];

  assert.equal(page.captions.length, 1);
  assert.equal(page.captions[0].kind, "caption");
  assert.equal(page.captions[0].target, "figure");
  assert.match(result.markdown, /Figure 1\. A generated vector box\./);
});

test("convertPdfToMarkdown reports visible table ruling-line diagnostics", async () => {
  const result = await convertPdfToMarkdown(visibleTableFixturePath.pathname);
  const rulingLines = result.diagnostics.extraction.rulingLines;
  const rulingGrids = result.diagnostics.extraction.rulingGrids;
  const rulingTables = result.diagnostics.extraction.rulingTables;

  assert.equal(result.confidence.tables, 0.95);
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.TableLowConfidence));
  assert.deepEqual(result.diagnostics.extraction.lowConfidenceTables, []);
  assert.deepEqual(result.diagnostics.extraction.tables, [
    {
      tableIndex: 0,
      source: "ruling-grid",
      pageIndex: 0,
      rows: 3,
      columns: 3,
      output: "gfm",
      confidence: 0.95,
      hasSpans: false,
      numericColumns: [1, 2],
      sourceLines: 9
    }
  ]);
  assert.deepEqual(result.assets, [
    {
      id: "table-page-1-1-csv",
      kind: "table-csv",
      path: "assets/table-page-1-1-csv.csv",
      mediaType: "text/csv",
      content: "Quarter,Revenue,Cost\nQ1,100,50\nQ2,120,60\n",
      pageIndex: 0,
      tableIndex: 0
    }
  ]);
  assert.deepEqual(result.ir.assets, result.assets);
  assert.equal(rulingLines.total, 8);
  assert.equal(rulingLines.horizontal, 4);
  assert.equal(rulingLines.vertical, 4);
  assert.deepEqual(rulingLines.pages, [
    {
      pageIndex: 0,
      total: 8,
      horizontal: 4,
      vertical: 4
    }
  ]);
  assert.equal(rulingGrids.total, 1);
  assert.equal(rulingGrids.complete, 1);
  assert.deepEqual(rulingGrids.pages, [
    {
      pageIndex: 0,
      total: 1,
      complete: 1,
      grids: [
        {
          rows: 3,
          columns: 3,
          cells: 9,
          x1: 72,
          y1: 610,
          x2: 432,
          y2: 700,
          complete: true
        }
      ]
    }
  ]);
  assert.equal(rulingTables.total, 1);
  assert.equal(rulingTables.assignedTextLines, 9);
  assert.equal(rulingTables.nonEmptyCells, 9);
  assert.equal(rulingTables.rowSpans, 0);
  assert.equal(rulingTables.columnSpans, 0);
  assert.equal(rulingTables.coveredCells, 0);
  assert.equal(rulingTables.csvSidecars, 1);
  assert.deepEqual(rulingTables.pages, [
    {
      pageIndex: 0,
      total: 1,
      assignedTextLines: 9,
      nonEmptyCells: 9,
      rowSpans: 0,
      columnSpans: 0,
      coveredCells: 0,
      csvSidecars: 1,
      tables: [
        {
          rows: 3,
          columns: 3,
          assignedTextLines: 9,
          nonEmptyCells: 9,
          rowSpans: 0,
          columnSpans: 0,
          coveredCells: 0,
          hasSpans: false,
          csvSidecarAssetId: "table-page-1-1-csv",
          cells: [
            { rowIndex: 0, columnIndex: 0, text: "Quarter", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 0, columnIndex: 1, text: "Revenue", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 0, columnIndex: 2, text: "Cost", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 1, columnIndex: 0, text: "Q1", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 1, columnIndex: 1, text: "100", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 1, columnIndex: 2, text: "50", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 2, columnIndex: 0, text: "Q2", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 2, columnIndex: 1, text: "120", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 2, columnIndex: 2, text: "60", lineCount: 1, rowSpan: 1, columnSpan: 1 }
          ]
        }
      ]
    }
  ]);
});

test("convertPdfToMarkdown warns and preserves low-confidence table candidates as text", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageTextPdf([
      textOperation(72, 720, 22, "Ambiguous Rows"),
      textOperation(72, 670, 12, "Name"),
      textOperation(220, 670, 12, "Status"),
      textOperation(72, 650, 12, "Alpha"),
      textOperation(220, 650, 12, "Active"),
      textOperation(72, 630, 12, "Beta"),
      textOperation(220, 630, 12, "Pending")
    ])
  );
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.TableLowConfidence
  );

  assert.equal(
    result.markdown,
    "# Ambiguous Rows\n\nName\n\nStatus\n\nAlpha\n\nActive\n\nBeta\n\nPending\n"
  );
  assert.deepEqual(result.diagnostics.extraction.tables, []);
  assert.deepEqual(result.diagnostics.extraction.lowConfidenceTables, [
    {
      tableIndex: 0,
      source: "borderless-heuristic",
      pageIndex: 0,
      rows: 3,
      columns: 2,
      confidence: 0.45,
      reason: "no-numeric-body-column",
      sourceLines: 6
    }
  ]);
  assert.ok(warning);
  assert.equal(warning.details.reason, "no-numeric-body-column");
  assert.equal(warning.details.confidence, 0.45);
});

test("convertPdfToMarkdown can disable table CSV sidecars", async () => {
  const result = await convertPdfToMarkdown(visibleTableFixturePath.pathname, {
    tables: { csvSidecars: false }
  });

  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.ir.assets, []);
  assert.equal(result.diagnostics.options.tableCsvSidecars, false);
  assert.equal(result.diagnostics.extraction.rulingTables.csvSidecars, 0);
  assert.equal(
    result.diagnostics.extraction.rulingTables.pages[0].tables[0].csvSidecarAssetId,
    null
  );
});

test("text MVP matches expected markdown for simple generated fixtures", async () => {
  const cases = [
    "synthetic-simple-text",
    "synthetic-headings-lists"
  ];

  for (const id of cases) {
    const pdf = new URL(`../../../corpus/generated/${id}.pdf`, import.meta.url);
    const expected = await readFile(new URL(`../../../corpus/expected/${id}.md`, import.meta.url), "utf8");
    const result = await convertPdfToMarkdown(pdf.pathname);
    assert.equal(result.markdown, expected);
  }
});

function pdfString(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function textOperation(x, y, size, value) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET`;
}

function streamObject(content) {
  const bytes = Buffer.from(content, "binary");
  return `<< /Length ${bytes.byteLength} >>\nstream\n${bytes.toString("binary")}\nendstream`;
}

function createSinglePageTextPdf(operations) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    streamObject(`${operations.join("\n")}\n`)
  ];
  let body = "%PDF-1.4\n% pdf-2-llm test fixture\n";
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

test("table MVP matches expected markdown for generated table fixtures", async () => {
  const cases = [
    "synthetic-visible-table",
    "synthetic-split-across-page-table",
    "synthetic-table-with-note",
    "synthetic-complex-spanned-table",
    "synthetic-borderless-table"
  ];

  for (const id of cases) {
    const pdf = new URL(`../../../corpus/generated/${id}.pdf`, import.meta.url);
    const expected = await readFile(new URL(`../../../corpus/expected/${id}.md`, import.meta.url), "utf8");
    const result = await convertPdfToMarkdown(pdf.pathname);
    assert.equal(result.markdown, expected);
  }
});

test("layout MVP matches expected markdown for generated layout fixtures", async () => {
  const cases = [
    "synthetic-two-column",
    "synthetic-header-footer",
    "synthetic-footnote"
  ];

  for (const id of cases) {
    const pdf = new URL(`../../../corpus/generated/${id}.pdf`, import.meta.url);
    const expected = await readFile(new URL(`../../../corpus/expected/${id}.md`, import.meta.url), "utf8");
    const result = await convertPdfToMarkdown(pdf.pathname);
    assert.equal(result.markdown, expected);
  }
});
