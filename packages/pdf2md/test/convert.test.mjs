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

test("table MVP matches expected markdown for generated table fixtures", async () => {
  const cases = [
    "synthetic-visible-table",
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
