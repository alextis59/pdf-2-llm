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
      figure({ pageIndex: 0 }),
      figure({ pageIndex: 1 })
    ]
  );

  assert.equal(
    result.markdown,
    [
      "*[Figure 1 preview unavailable; metadata retained.]*",
      "",
      "Figure 1. Duplicate caption.",
      "",
      "Body text.",
      "",
      "*[Figure 1 preview unavailable; metadata retained.]*",
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
      { pageIndex: 0, markdownStart: result.markdown.indexOf("*[Figure 1 preview unavailable") },
      { pageIndex: 1, markdownStart: result.markdown.lastIndexOf("*[Figure 1 preview unavailable") }
    ]
  );
});

test("insertFigureMarkdown extends source-map entries spanning an insertion", () => {
  const caption = "Figure 2. Spanning caption.";
  const markdown = `Lead: ${caption} Tail.`;
  const captionStart = markdown.indexOf(caption);
  const result = insertFigureMarkdown(
    {
      markdown,
      sourceMap: {
        schemaVersion: "0.1.0",
        target: "markdown",
        entries: [
          { ...sourceMapEntry(0, captionStart, 0), kind: "before" },
          { ...sourceMapEntry(0, markdown.length, 0), kind: "spanning" },
          {
            ...sourceMapEntry(captionStart, captionStart + caption.length, 0),
            kind: "caption"
          }
        ]
      }
    },
    [
      {
        ...figure({ pageIndex: 0 }),
        captionNumber: "2",
        caption
      }
    ]
  );
  const insertion = "*[Figure 2 preview unavailable; metadata retained.]*\n\n";
  const byKind = Object.fromEntries(
    result.sourceMap.entries.map((entry) => [entry.kind, entry])
  );

  assert.equal(result.markdown, `Lead: ${insertion}${caption} Tail.`);
  assert.deepEqual(
    ["before", "spanning", "caption"].map((kind) => ({
      kind,
      markdownStart: byKind[kind].markdownStart,
      markdownEnd: byKind[kind].markdownEnd
    })),
    [
      { kind: "before", markdownStart: 0, markdownEnd: captionStart },
      { kind: "spanning", markdownStart: 0, markdownEnd: markdown.length + insertion.length },
      {
        kind: "caption",
        markdownStart: captionStart + insertion.length,
        markdownEnd: captionStart + caption.length + insertion.length
      }
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

function figure({ pageIndex }) {
  return {
    pageIndex,
    captionNumber: "1",
    figureNumber: 1,
    caption: "Figure 1. Duplicate caption.",
    kind: "vector",
    x: 10,
    y: 20,
    width: 30,
    height: 40
  };
}
