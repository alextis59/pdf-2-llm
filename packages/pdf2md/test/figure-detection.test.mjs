import assert from "node:assert/strict";
import test from "node:test";
import { insertFigureMarkdown } from "../src/figure-detection.mjs";

test("insertFigureMarkdown attaches duplicate captions to their source-map pages", () => {
  const caption = "Figure 1. Duplicate caption.";
  const markdown = `${caption}\n\nBody text.\n\n${caption}\n`;
  const firstCaptionStart = markdown.indexOf(caption);
  const secondCaptionStart = markdown.indexOf(caption, firstCaptionStart + caption.length);
  const result = insertFigureMarkdown(
    {
      markdown,
      sourceMap: {
        schemaVersion: "0.1.0",
        target: "markdown",
        entries: [
          sourceMapEntry(firstCaptionStart, firstCaptionStart + caption.length, 0),
          sourceMapEntry(secondCaptionStart, secondCaptionStart + caption.length, 1)
        ]
      }
    },
    [
      figure({ pageIndex: 0, assetPath: "assets/page-1-figure.png" }),
      figure({ pageIndex: 1, assetPath: "assets/page-2-figure.png" })
    ]
  );

  assert.equal(
    result.markdown,
    [
      "![Figure 1](assets/page-1-figure.png)",
      "",
      "Figure 1. Duplicate caption.",
      "",
      "Body text.",
      "",
      "![Figure 1](assets/page-2-figure.png)",
      "",
      "Figure 1. Duplicate caption.",
      ""
    ].join("\n")
  );
  assert.deepEqual(
    result.sourceMap.entries.filter((entry) => entry.kind === "figure").map((entry) => ({
      pageIndex: entry.regions[0].pageIndex,
      markdownStart: entry.markdownStart
    })),
    [
      { pageIndex: 0, markdownStart: result.markdown.indexOf("![Figure 1](assets/page-1-figure.png)") },
      { pageIndex: 1, markdownStart: result.markdown.indexOf("![Figure 1](assets/page-2-figure.png)") }
    ]
  );
});

function sourceMapEntry(markdownStart, markdownEnd, pageIndex) {
  return {
    markdownStart,
    markdownEnd,
    kind: "paragraph",
    regions: [{ pageIndex }]
  };
}

function figure({ pageIndex, assetPath }) {
  return {
    pageIndex,
    captionNumber: "1",
    figureNumber: 1,
    caption: "Figure 1. Duplicate caption.",
    assetPath,
    kind: "vector",
    x: 10,
    y: 20,
    width: 30,
    height: 40
  };
}
