import assert from "node:assert/strict";
import test from "node:test";
import { linesToMarkdown } from "../src/text-extract.mjs";

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

test("linesToMarkdown removes high-confidence page numbers", () => {
  const markdown = linesToMarkdown([
    { text: "Page Number Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Body text.", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "1", fontSize: 9, x: 300, y: 40, pageIndex: 0 },
    { text: "2 / 3", fontSize: 9, x: 300, y: 40, pageIndex: 1 }
  ]);

  assert.equal(markdown, "# Page Number Fixture\n\nBody text.\n");
});
