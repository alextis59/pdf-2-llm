import assert from "node:assert/strict";
import test from "node:test";
import {
  compareMarkdownAst,
  createMarkdownAstDiffReport,
  parseMarkdownAst
} from "../../../scripts/qa/check-markdown-ast.mjs";

test("parseMarkdownAst captures headings, lists, images, and paragraphs", () => {
  assert.deepEqual(
    parseMarkdownAst(
      [
        "# Title",
        "",
        "- Parse objects",
        "- Decode streams",
        "",
        "![Figure 1](assets/figure-1.png)",
        "",
        "Final paragraph."
      ].join("\n")
    ),
    {
      type: "document",
      children: [
        { type: "heading", depth: 1, text: "Title" },
        {
          type: "list",
          ordered: false,
          items: ["Parse objects", "Decode streams"]
        },
        { type: "image", alt: "Figure 1", target: "assets/figure-1.png" },
        { type: "paragraph", text: "Final paragraph." }
      ]
    }
  );
});

test("parseMarkdownAst captures GFM tables and HTML table fallbacks", () => {
  const ast = parseMarkdownAst(
    [
      "| Quarter | Revenue |",
      "| --- | ---: |",
      "| Q1 | 100 |",
      "",
      "<table>",
      "  <tbody>",
      "    <tr><td colspan=\"2\">Merged</td></tr>",
      "  </tbody>",
      "</table>"
    ].join("\n")
  );

  assert.deepEqual(ast.children, [
    {
      type: "table",
      format: "gfm",
      header: ["Quarter", "Revenue"],
      alignments: ["default", "right"],
      rows: [["Q1", "100"]]
    },
    {
      type: "table",
      format: "html",
      html: [
        "<table>",
        "<tbody>",
        "<tr><td colspan=\"2\">Merged</td></tr>",
        "</tbody>",
        "</table>"
      ].join("\n")
    }
  ]);
});

test("compareMarkdownAst passes equivalent block structure", () => {
  assert.deepEqual(compareMarkdownAst("# Title\n\nWrapped paragraph\ncontinues.\n", "# Title\n\nWrapped paragraph continues.\n"), {
    expectedBlocks: 2,
    actualBlocks: 2,
    differences: [],
    passed: true
  });
});

test("compareMarkdownAst reports structural differences", () => {
  const comparison = compareMarkdownAst("# Title\n\n- One\n", "# Title\n\n1. One\n");

  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.differences, [
    {
      path: "$.children[1].ordered",
      expected: false,
      actual: true
    }
  ]);
});

test("createMarkdownAstDiffReport summarizes case results", () => {
  const report = createMarkdownAstDiffReport([
    compareMarkdownAst("# Title\n", "# Title\n"),
    compareMarkdownAst("# Title\n", "Body\n")
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.ok(report.results[1].differences.some((difference) => difference.path === "$.children[0].type"));
});
