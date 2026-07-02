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
