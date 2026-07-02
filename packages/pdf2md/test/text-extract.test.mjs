import assert from "node:assert/strict";
import test from "node:test";
import { linesToMarkdown, linesToMarkdownWithSourceMap } from "../src/text-extract.mjs";

test("linesToMarkdown normalizes common ligatures and whitespace", () => {
  const markdown = linesToMarkdown([
    {
      text: "\uFB01le   \uFB02ow",
      fontSize: 22,
      x: 10,
      y: 20
    },
    {
      text: "plain\t\ttext",
      fontSize: 12,
      x: 10,
      y: 10
    }
  ]);

  assert.equal(markdown, "# file flow\n\nplain text\n");
});

test("linesToMarkdown infers headings and ordered lists", () => {
  const markdown = linesToMarkdown([
    { text: "Title", fontSize: 22, x: 10, y: 40 },
    { text: "Section", fontSize: 16, x: 10, y: 30 },
    { text: "1. First", fontSize: 12, x: 10, y: 20 },
    { text: "2) Second", fontSize: 12, x: 10, y: 10 }
  ]);

  assert.equal(markdown, "# Title\n\n## Section\n\n1. First\n2. Second\n");
});

test("linesToMarkdown escapes Markdown metacharacters in text and tables", () => {
  const markdown = linesToMarkdown([
    { text: "literal *star* and [label] uses \\ slash", fontSize: 12, x: 10, y: 40 },
    { text: "# not heading", fontSize: 12, x: 10, y: 30 },
    { text: "A|B", fontSize: 12, x: 10, y: 20 },
    { text: "Value", fontSize: 12, x: 50, y: 20 },
    { text: "x*y", fontSize: 12, x: 10, y: 10 },
    { text: "3", fontSize: 12, x: 50, y: 10 }
  ]);

  assert.equal(
    markdown,
    "literal \\*star\\* and \\[label\\] uses \\\\ slash\n\n\\# not heading\n\n| A\\|B | Value |\n| --- | ---: |\n| x\\*y | 3 |\n"
  );
});

test("linesToMarkdown can add page anchors", () => {
  const markdown = linesToMarkdown(
    [
      { text: "Page One", fontSize: 22, x: 10, y: 40, pageIndex: 0 },
      { text: "Page Two", fontSize: 22, x: 10, y: 40, pageIndex: 1 }
    ],
    { pageAnchors: true }
  );

  assert.equal(
    markdown,
    '<a id="page-1"></a>\n\n# Page One\n\n<a id="page-2"></a>\n\n# Page Two\n'
  );
});

test("linesToMarkdown groups wrapped lines into paragraphs", () => {
  const markdown = linesToMarkdown([
    { text: "A wrapped paragraph continues", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "on the next visual line.", fontSize: 12, x: 72, y: 666, pageIndex: 0 },
    { text: "A separate paragraph.", fontSize: 12, x: 72, y: 630, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    "A wrapped paragraph continues on the next visual line.\n\nA separate paragraph.\n"
  );
});

test("linesToMarkdown orders interleaved two-column lines by geometry", () => {
  const markdown = linesToMarkdown([
    { text: "Layout Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Left column starts here.", fontSize: 12, x: 72, y: 670, pageIndex: 0 },
    { text: "Right column starts here.", fontSize: 12, x: 330, y: 670, pageIndex: 0 },
    { text: "Left column continues here.", fontSize: 12, x: 72, y: 650, pageIndex: 0 },
    { text: "Right column continues here.", fontSize: 12, x: 330, y: 650, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    "# Layout Fixture\n\nLeft column starts here.\n\nLeft column continues here.\n\nRight column starts here.\n\nRight column continues here.\n"
  );
});

test("linesToMarkdown keeps mixed-layout spanning rows in vertical order", () => {
  const markdown = linesToMarkdown([
    { text: "Mixed Layout", fontSize: 22, x: 72, y: 720, width: 120, pageIndex: 0 },
    { text: "Left top.", fontSize: 12, x: 72, y: 680, width: 80, pageIndex: 0 },
    { text: "Right top.", fontSize: 12, x: 330, y: 680, width: 90, pageIndex: 0 },
    { text: "Left lower.", fontSize: 12, x: 72, y: 660, width: 90, pageIndex: 0 },
    { text: "Right lower.", fontSize: 12, x: 330, y: 660, width: 100, pageIndex: 0 },
    { text: "Full width summary.", fontSize: 12, x: 72, y: 620, width: 430, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    "# Mixed Layout\n\nLeft top.\n\nLeft lower.\n\nRight top.\n\nRight lower.\n\nFull width summary.\n"
  );
});

test("linesToMarkdown keeps same-baseline table cells in row-major order", () => {
  const markdown = linesToMarkdown([
    { text: "Table Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Name", fontSize: 12, x: 72, y: 670, pageIndex: 0 },
    { text: "Count", fontSize: 12, x: 220, y: 670, pageIndex: 0 },
    { text: "Alpha", fontSize: 12, x: 72, y: 650, pageIndex: 0 },
    { text: "3", fontSize: 12, x: 220, y: 650, pageIndex: 0 },
    { text: "Beta", fontSize: 12, x: 72, y: 630, pageIndex: 0 },
    { text: "7", fontSize: 12, x: 220, y: 630, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    "# Table Fixture\n\n| Name | Count |\n| --- | ---: |\n| Alpha | 3 |\n| Beta | 7 |\n"
  );
});

test("linesToMarkdownWithSourceMap reports page layout classifications", () => {
  const single = linesToMarkdownWithSourceMap([
    { text: "Single", fontSize: 22, x: 72, y: 720, width: 80, pageIndex: 0 },
    { text: "One column body starts here.", fontSize: 12, x: 72, y: 680, width: 160, pageIndex: 0 },
    { text: "It continues here.", fontSize: 12, x: 72, y: 660, width: 100, pageIndex: 0 }
  ]);
  assert.equal(single.layout.pages[0].kind, "single-column");
  assert.equal(single.layout.pages[0].columns.length, 0);

  const multi = linesToMarkdownWithSourceMap([
    { text: "Multi", fontSize: 22, x: 72, y: 720, width: 80, pageIndex: 0 },
    { text: "Left top.", fontSize: 12, x: 72, y: 680, width: 80, pageIndex: 0 },
    { text: "Right top.", fontSize: 12, x: 330, y: 680, width: 90, pageIndex: 0 },
    { text: "Left lower.", fontSize: 12, x: 72, y: 660, width: 90, pageIndex: 0 },
    { text: "Right lower.", fontSize: 12, x: 330, y: 660, width: 100, pageIndex: 0 }
  ]);
  assert.equal(multi.layout.pages[0].kind, "multi-column");
  assert.deepEqual(
    multi.layout.pages[0].columns.map((column) => column.index),
    [0, 1]
  );
  assert.equal(multi.layout.pages[0].sidebars.length, 0);

  const mixed = linesToMarkdownWithSourceMap([
    { text: "Mixed", fontSize: 22, x: 72, y: 720, width: 80, pageIndex: 0 },
    { text: "Left top.", fontSize: 12, x: 72, y: 680, width: 80, pageIndex: 0 },
    { text: "Right top.", fontSize: 12, x: 330, y: 680, width: 90, pageIndex: 0 },
    { text: "Left lower.", fontSize: 12, x: 72, y: 660, width: 90, pageIndex: 0 },
    { text: "Right lower.", fontSize: 12, x: 330, y: 660, width: 100, pageIndex: 0 },
    { text: "Full width summary.", fontSize: 12, x: 72, y: 620, width: 430, pageIndex: 0 }
  ]);
  assert.equal(mixed.layout.pages[0].kind, "mixed");
  assert.equal(mixed.layout.pages[0].columns.length, 2);
});

test("linesToMarkdownWithSourceMap reports sidebar and callout regions", () => {
  const result = linesToMarkdownWithSourceMap([
    { text: "Sidebar Fixture", fontSize: 22, x: 72, y: 720, width: 150, pageIndex: 0 },
    { text: "Main body starts.", fontSize: 12, x: 72, y: 680, width: 120, pageIndex: 0 },
    { text: "Aside fact", fontSize: 10, x: 420, y: 670, width: 80, pageIndex: 0 },
    { text: "Main body continues.", fontSize: 12, x: 72, y: 660, width: 140, pageIndex: 0 },
    { text: "Aside detail", fontSize: 10, x: 420, y: 650, width: 90, pageIndex: 0 },
    { text: "Main body adds detail.", fontSize: 12, x: 72, y: 640, width: 150, pageIndex: 0 },
    { text: "Main body keeps going.", fontSize: 12, x: 72, y: 620, width: 150, pageIndex: 0 },
    { text: "Main body ends.", fontSize: 12, x: 72, y: 600, width: 110, pageIndex: 0 },
    { text: "Note: Check exceptions.", fontSize: 12, x: 90, y: 560, width: 170, pageIndex: 0 }
  ]);

  const page = result.layout.pages[0];
  assert.equal(page.sidebars.length, 1);
  assert.equal(page.sidebars[0].kind, "sidebar");
  assert.equal(page.sidebars[0].columnIndex, 1);
  assert.equal(page.sidebars[0].rows, 2);
  assert.equal(page.callouts.length, 1);
  assert.equal(page.callouts[0].kind, "callout");
  assert.equal(page.callouts[0].rows, 1);
});

test("linesToMarkdownWithSourceMap reports footnote regions", () => {
  const result = linesToMarkdownWithSourceMap([
    { text: "Footnote Fixture", fontSize: 22, x: 72, y: 720, width: 160, pageIndex: 0 },
    { text: "A measured result refers to note 1.", fontSize: 12, x: 72, y: 680, width: 220, pageIndex: 0 },
    { text: "1. Footnote text belongs after the paragraph.", fontSize: 9, x: 72, y: 96, width: 230, pageIndex: 0 }
  ]);

  const page = result.layout.pages[0];
  assert.equal(page.footnotes.length, 1);
  assert.equal(page.footnotes[0].kind, "footnote");
  assert.equal(page.footnotes[0].rows, 1);
});

test("linesToMarkdownWithSourceMap reports figure and table caption regions", () => {
  const result = linesToMarkdownWithSourceMap([
    { text: "Caption Fixture", fontSize: 22, x: 72, y: 720, width: 160, pageIndex: 0 },
    { text: "Figure 1. A generated vector box.", fontSize: 11, x: 120, y: 490, width: 190, pageIndex: 0 },
    { text: "Table 1. Revenue by quarter.", fontSize: 11, x: 72, y: 420, width: 170, pageIndex: 0 }
  ]);

  const captions = result.layout.pages[0].captions;
  assert.deepEqual(
    captions.map((caption) => caption.target),
    ["figure", "table"]
  );
  assert.deepEqual(
    captions.map((caption) => caption.kind),
    ["caption", "caption"]
  );
});

test("linesToMarkdown removes high-confidence page numbers", () => {
  const markdown = linesToMarkdown([
    { text: "Page Number Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Body text.", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "1", fontSize: 9, x: 300, y: 40, pageIndex: 0 },
    { text: "2 / 3", fontSize: 9, x: 300, y: 40, pageIndex: 1 }
  ]);

  assert.equal(markdown, "# Page Number Fixture\n\nBody text.\n");
});

test("linesToMarkdownWithSourceMap maps Markdown blocks back to page regions", () => {
  const result = linesToMarkdownWithSourceMap(
    [
      { text: "Mapped Title", fontSize: 22, x: 72, y: 720, width: 120, height: 22, pageIndex: 0 },
      { text: "A mapped paragraph continues", fontSize: 12, x: 72, y: 680, width: 160, height: 12, pageIndex: 0 },
      { text: "on another line.", fontSize: 12, x: 72, y: 666, width: 96, height: 12, pageIndex: 0 }
    ],
    { pageAnchors: true }
  );

  assert.equal(
    result.markdown,
    '<a id="page-1"></a>\n\n# Mapped Title\n\nA mapped paragraph continues on another line.\n'
  );
  assert.equal(result.sourceMap.entries.length, 3);
  assert.deepEqual(
    result.sourceMap.entries.map((entry) => entry.kind),
    ["page_anchor", "heading", "paragraph"]
  );
  for (const entry of result.sourceMap.entries) {
    assert.equal(result.markdown.slice(entry.markdownStart, entry.markdownEnd).length > 0, true);
  }
  assert.deepEqual(result.sourceMap.entries[1].regions[0], {
    pageIndex: 0,
    x: 72,
    y: 720,
    width: 120,
    height: 22,
    source: "pdf-text"
  });
  assert.equal(result.sourceMap.entries[2].regions.length, 2);
});
