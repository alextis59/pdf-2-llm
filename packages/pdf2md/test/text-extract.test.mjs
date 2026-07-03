import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDocumentContent,
  extractImageDraws,
  extractRulingLines,
  extractTextLines,
  linesToMarkdown,
  linesToMarkdownWithSourceMap
} from "../src/text-extract.mjs";

test("extractDocumentContent streams parsed page content into text, rulings, and image draws", () => {
  const bytes = Buffer.from("%PDF-1.4\n", "binary");
  const document = {
    pages: [
      {
        pageIndex: 0,
        resources: {
          fonts: {
            F1: {
              subtype: "Type1",
              baseFont: "Helvetica",
              encoding: "WinAnsiEncoding",
              hasToUnicode: false,
              toUnicode: null
            }
          },
          xobjects: {
            Im1: {
              subtype: "Image",
              objectNumber: 5,
              width: 10,
              height: 20
            }
          }
        },
        contentStreams: [
          {
            text: [
              "BT /F1 12 Tf 10 20 Td (Hello) Tj ET",
              "0 0 30 10 re S",
              "q 15 0 0 25 40 50 cm /Im1 Do Q"
            ].join("\n")
          }
        ]
      }
    ],
    streams: [],
    structure: { markedContent: [] }
  };

  const content = extractDocumentContent(bytes, { document });

  assert.deepEqual(content.textLines, extractTextLines(bytes, { document }));
  assert.deepEqual(content.rulingLines, extractRulingLines(bytes, { document }));
  assert.deepEqual(content.imageDraws, extractImageDraws(bytes, { document }));
  assert.equal(content.textLines[0].text, "Hello");
  assert.equal(content.rulingLines.length, 4);
  assert.equal(content.imageDraws[0].name, "Im1");
});

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

test("linesToMarkdown applies script-specific compatibility normalization", () => {
  const heading = "\uff26\uff55\uff4c\uff4c\uff57\uff49\uff44\uff54\uff48\u3000\uff11\uff12\uff13";
  const halfwidthKatakana = "\uff76\uff80\uff76\uff85";
  const arabicPresentation = "\ufefb";
  const markdown = linesToMarkdown([
    { text: heading, fontSize: 22, x: 10, y: 40 },
    { text: halfwidthKatakana, fontSize: 12, x: 10, y: 20 },
    { text: arabicPresentation, fontSize: 12, x: 10, y: -20 }
  ]);

  assert.equal(markdown, "# Fullwidth 123\n\n\u30ab\u30bf\u30ab\u30ca\n\n<p dir=\"rtl\">\u0644\u0627</p>\n");
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

test("linesToMarkdown infers nested lists from indentation", () => {
  const markdown = linesToMarkdown([
    { text: "List Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "- Root item", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "- Child item", fontSize: 12, x: 96, y: 660, pageIndex: 0 },
    { text: "1) Ordered child", fontSize: 12, x: 120, y: 640, pageIndex: 0 },
    { text: "- Child sibling", fontSize: 12, x: 96, y: 620, pageIndex: 0 },
    { text: "- Second root", fontSize: 12, x: 72, y: 600, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    "# List Fixture\n\n- Root item\n  - Child item\n    1. Ordered child\n  - Child sibling\n- Second root\n"
  );
});

test("linesToMarkdown infers fenced code blocks from monospace text and indentation", () => {
  const markdown = linesToMarkdown([
    { text: "Code Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Intro paragraph.", fontSize: 12, x: 72, y: 690, pageIndex: 0 },
    {
      text: "function add(a, b) {",
      fontSize: 12,
      fontName: "FMono",
      font: { baseFont: "Courier" },
      x: 96,
      y: 650,
      pageIndex: 0
    },
    {
      text: "return a + b;",
      fontSize: 12,
      fontName: "FMono",
      font: { baseFont: "Courier" },
      x: 120,
      y: 634,
      pageIndex: 0
    },
    {
      text: "}",
      fontSize: 12,
      fontName: "FMono",
      font: { baseFont: "Courier" },
      x: 96,
      y: 618,
      pageIndex: 0
    },
    { text: "const value = add(1, 2);", fontSize: 12, x: 120, y: 578, pageIndex: 0 },
    { text: "return value;", fontSize: 12, x: 120, y: 562, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    "# Code Fixture\n\nIntro paragraph.\n\n```\nfunction add(a, b) {\n  return a + b;\n}\n```\n\n```\nconst value = add(1, 2);\nreturn value;\n```\n"
  );
});

test("linesToMarkdownWithSourceMap preserves display equations", () => {
  const equation = "\u03a3 x_i = n(n + 1) / 2";
  const result = linesToMarkdownWithSourceMap([
    textLine("Equation Fixture", 72, 720, 160, 22),
    textLine("A short lead-in.", 72, 690, 120, 12),
    textLine(equation, 168, 660, 170, 12),
    textLine("After the equation.", 72, 620, 130, 12)
  ]);

  assert.equal(
    result.markdown,
    `# Equation Fixture\n\nA short lead-in.\n\n$$\n${equation}\n$$\n\nAfter the equation.\n`
  );
  assert.deepEqual(
    result.sourceMap.entries.map((entry) => entry.kind),
    ["heading", "paragraph", "equation", "paragraph"]
  );
  assert.deepEqual(result.sourceMap.entries[2].regions, [
    {
      pageIndex: 0,
      x: 168,
      y: 660,
      width: 170,
      height: 12,
      source: "pdf-text"
    }
  ]);
  assert.deepEqual(result.equations, {
    total: 1,
    unicodeEquations: 1,
    textEquations: 1,
    imageEquations: 0,
    formulaOcr: {
      enabled: false,
      status: "not-configured"
    },
    equations: [
      {
        equationIndex: 0,
        pageIndex: 0,
        source: "pdf-text",
        text: equation,
        latex: null,
        lineCount: 1,
        containsUnicodeMath: true,
        x: 168,
        y: 660,
        width: 170,
        height: 12
      }
    ]
  });
});

test("linesToMarkdownWithSourceMap preserves low-confidence OCR equations as images", () => {
  const result = linesToMarkdownWithSourceMap(
    [
      textLine("Equation Fixture", 72, 720, 160, 22),
      textLine("A short lead-in.", 72, 690, 120, 12),
      {
        ...textLine("E = m c^2", 168, 660, 170, 12),
        source: "ocr",
        confidence: 0.42
      },
      textLine("After the equation.", 72, 620, 130, 12)
    ],
    {
      equations: {
        imageFallbackConfidence: 0.75,
        assetIdPrefix: "scan-equations"
      }
    }
  );

  assert.equal(
    result.markdown,
    "# Equation Fixture\n\nA short lead-in.\n\n![Equation 1](assets/scan-equations-page-1-equation-1.png)\n\nAfter the equation.\n"
  );
  assert.deepEqual(result.sourceMap.entries[2], {
    markdownStart: 38,
    markdownEnd: 96,
    kind: "equation",
    regions: [
      {
        pageIndex: 0,
        x: 168,
        y: 660,
        width: 170,
        height: 12,
        source: "ocr"
      }
    ]
  });
  assert.deepEqual(result.equations, {
    total: 1,
    unicodeEquations: 0,
    textEquations: 0,
    imageEquations: 1,
    formulaOcr: {
      enabled: false,
      status: "not-configured"
    },
    equations: [
      {
        equationIndex: 0,
        pageIndex: 0,
        source: "ocr",
        text: "E = m c^2",
        latex: null,
        lineCount: 1,
        containsUnicodeMath: false,
        x: 168,
        y: 660,
        width: 170,
        height: 12,
        output: "image",
        assetId: "scan-equations-page-1-equation-1",
        assetPath: "assets/scan-equations-page-1-equation-1.png",
        assetMediaType: "image/png",
        confidence: 0.42,
        fallbackReason: "low-ocr-confidence",
        fallbackThreshold: 0.75
      }
    ]
  });
});

test("linesToMarkdownWithSourceMap applies optional formula OCR LaTeX", () => {
  const result = linesToMarkdownWithSourceMap(
    [
      textLine("Equation Fixture", 72, 720, 160, 22),
      textLine("A short lead-in.", 72, 690, 120, 12),
      {
        ...textLine("E = m c^2", 168, 660, 170, 12),
        source: "ocr",
        confidence: 0.42
      },
      textLine("After the equation.", 72, 620, 130, 12)
    ],
    {
      equations: {
        imageFallbackConfidence: 0.75,
        formulaOcr: {
          results: [
            {
              equationIndex: 0,
              latex: "E = mc^{2}",
              confidence: 88
            }
          ]
        }
      }
    }
  );

  assert.equal(
    result.markdown,
    "# Equation Fixture\n\nA short lead-in.\n\n$$\nE = mc^{2}\n$$\n\nAfter the equation.\n"
  );
  assert.deepEqual(result.equations, {
    total: 1,
    unicodeEquations: 0,
    textEquations: 1,
    imageEquations: 0,
    formulaOcr: {
      enabled: true,
      status: "selected"
    },
    equations: [
      {
        equationIndex: 0,
        pageIndex: 0,
        source: "ocr",
        text: "E = m c^2",
        latex: "E = mc^{2}",
        lineCount: 1,
        containsUnicodeMath: false,
        x: 168,
        y: 660,
        width: 170,
        height: 12,
        formulaOcrSource: "options.equations.formulaOcr.results",
        formulaOcrConfidence: 0.88
      }
    ]
  });
});

test("linesToMarkdown infers heading levels across the document", () => {
  const markdown = linesToMarkdown([
    { text: "Document Title", fontSize: 24, x: 72, y: 720, pageIndex: 0 },
    { text: "Major Section", fontSize: 18, x: 72, y: 680, pageIndex: 0 },
    { text: "Body text starts here.", fontSize: 12, x: 72, y: 650, pageIndex: 0 },
    { text: "Minor Section", fontSize: 16, x: 72, y: 620, pageIndex: 0 },
    { text: "More body text.", fontSize: 12, x: 72, y: 590, pageIndex: 0 },
    { text: "Another Major Section", fontSize: 18, x: 72, y: 720, pageIndex: 1 },
    { text: "Second page body.", fontSize: 12, x: 72, y: 690, pageIndex: 1 }
  ]);

  assert.equal(
    markdown,
    "# Document Title\n\n## Major Section\n\nBody text starts here.\n\n### Minor Section\n\nMore body text.\n\n## Another Major Section\n\nSecond page body.\n"
  );
});

test("linesToMarkdown uses outlines as heading signals", () => {
  const markdown = linesToMarkdown(
    [
      { text: "Outlined Section", fontSize: 12, x: 72, y: 720, pageIndex: 0 },
      { text: "Body text starts here.", fontSize: 12, x: 72, y: 690, pageIndex: 0 }
    ],
    {
      outlines: [{ title: "Outlined Section", depth: 2 }]
    }
  );

  assert.equal(markdown, "## Outlined Section\n\nBody text starts here.\n");
});

test("linesToMarkdown uses consistent tagged PDF roles as heading signals", () => {
  const markdown = linesToMarkdown([
    { text: "Tagged Section", fontSize: 12, x: 72, y: 720, pageIndex: 0, structureRole: "H3" },
    { text: "Body text starts here.", fontSize: 12, x: 72, y: 690, pageIndex: 0 }
  ]);

  assert.equal(markdown, "### Tagged Section\n\nBody text starts here.\n");
});

test("linesToMarkdownWithSourceMap reports tagged heading layout conflicts", () => {
  const result = linesToMarkdownWithSourceMap([
    { text: "Body paragraph.", fontSize: 12, x: 72, y: 720, pageIndex: 0 },
    { text: "Another body paragraph.", fontSize: 12, x: 72, y: 700, pageIndex: 0 },
    {
      text: "Tiny tagged heading",
      fontSize: 6,
      x: 72,
      y: 660,
      pageIndex: 0,
      structureRole: "H1",
      markedContentId: 4
    }
  ]);

  assert.equal(
    result.markdown,
    "Body paragraph.\n\nAnother body paragraph.\n\nTiny tagged heading\n"
  );
  assert.deepEqual(result.taggedStructureConflicts, [
    {
      reason: "font-size-below-body",
      role: "H1",
      text: "Tiny tagged heading",
      pageIndex: 0,
      markedContentId: 4,
      fontSize: 6,
      bodyFontSize: 12,
      x: 72,
      y: 660
    }
  ]);
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

test("linesToMarkdownWithSourceMap exports no-span ruling tables as GFM", () => {
  const title = textLine("Ruled Table Fixture", 72, 720, 140, 22);
  const quarter = textLine("Quarter", 82, 684, 38, 11);
  const revenue = textLine("Revenue", 202, 680, 40, 11);
  const cost = textLine("Cost", 322, 676, 22, 11);
  const q1 = textLine("Q1", 82, 640, 12, 11);
  const amount = textLine("100", 202, 636, 18, 11);
  const costAmount = textLine("50", 322, 632, 12, 11);
  const result = linesToMarkdownWithSourceMap(
    [title, quarter, revenue, cost, q1, amount, costAmount],
    {
      rulingTables: [
        {
          pageIndex: 0,
          rows: 2,
          columns: 3,
          hasSpans: false,
          rowSpans: 0,
          columnSpans: 0,
          coveredCells: 0,
          cells: [
            tableCell(0, 0, "Quarter", [quarter]),
            tableCell(0, 1, "Revenue", [revenue]),
            tableCell(0, 2, "Cost", [cost]),
            tableCell(1, 0, "Q1", [q1]),
            tableCell(1, 1, "100", [amount]),
            tableCell(1, 2, "50", [costAmount])
          ]
        }
      ]
    }
  );

  assert.equal(
    result.markdown,
    "# Ruled Table Fixture\n\n| Quarter | Revenue | Cost |\n| --- | ---: | ---: |\n| Q1 | 100 | 50 |\n"
  );
  assert.equal(result.sourceMap.entries.length, 2);
  assert.equal(result.sourceMap.entries[1].kind, "table");
  assert.equal(result.sourceMap.entries[1].regions.length, 6);
  assert.deepEqual(result.tables, [
    {
      tableIndex: 0,
      source: "ruling-grid",
      pageIndex: 0,
      rows: 2,
      columns: 3,
      output: "gfm",
      confidence: 0.95,
      hasSpans: false,
      numericColumns: [1, 2],
      sourceLines: 6
    }
  ]);
});

test("linesToMarkdownWithSourceMap exports span-bearing ruling tables as HTML", () => {
  const title = textLine("Spanned Table Fixture", 72, 720, 150, 22);
  const merged = textLine("Revenue <Total>", 82, 684, 80, 11);
  const quarter = textLine("Q1 & Q2", 82, 640, 38, 11);
  const amount = textLine('100 "net"', 202, 636, 50, 11);
  const result = linesToMarkdownWithSourceMap(
    [title, merged, quarter, amount],
    {
      rulingTables: [
        {
          pageIndex: 0,
          rows: 2,
          columns: 2,
          hasSpans: true,
          rowSpans: 0,
          columnSpans: 1,
          coveredCells: 1,
          cells: [
            tableCell(0, 0, "Revenue <Total>", [merged], { columnSpan: 2 }),
            tableCell(0, 1, "", [], { coveredBy: { rowIndex: 0, columnIndex: 0 } }),
            tableCell(1, 0, "Q1 & Q2", [quarter]),
            tableCell(1, 1, '100 "net"', [amount])
          ]
        }
      ]
    }
  );

  assert.equal(
    result.markdown,
    "# Spanned Table Fixture\n\n<table>\n  <thead>\n    <tr>\n      <th colspan=\"2\">Revenue &lt;Total&gt;</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>Q1 &amp; Q2</td>\n      <td>100 &quot;net&quot;</td>\n    </tr>\n  </tbody>\n</table>\n"
  );
  assert.equal(result.sourceMap.entries.length, 2);
  assert.equal(result.sourceMap.entries[1].kind, "table");
  assert.equal(result.sourceMap.entries[1].regions.length, 3);
});

test("linesToMarkdown preserves URL and email links", () => {
  const markdown = linesToMarkdown([
    {
      text: "Visit https://example.com/docs and contact support@example.com.",
      fontSize: 12,
      x: 72,
      y: 720,
      pageIndex: 0
    },
    {
      text: "Mirror at www.example.org/path.",
      fontSize: 12,
      x: 72,
      y: 700,
      pageIndex: 0
    }
  ]);

  assert.equal(
    markdown,
    "Visit <https://example.com/docs> and contact <support@example.com>.\n\nMirror at <https://www.example.org/path>.\n"
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

test("linesToMarkdown repairs line-end hyphenation inside paragraphs", () => {
  const markdown = linesToMarkdown([
    { text: "This paragraph validates hyphen-", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "ation repair across a wrapped line.", fontSize: 12, x: 72, y: 666, pageIndex: 0 }
  ]);

  assert.equal(markdown, "This paragraph validates hyphenation repair across a wrapped line.\n");
});

test("linesToMarkdown orders RTL row fragments and emits bidi paragraph markup", () => {
  const right = "\u05d0\u05d1\u05d2";
  const left = "\u05d3\u05d4\u05d5";
  const markdown = linesToMarkdown([
    { text: "RTL Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: left, fontSize: 12, x: 260, y: 680, width: 48, height: 12, pageIndex: 0 },
    { text: right, fontSize: 12, x: 320, y: 680, width: 48, height: 12, pageIndex: 0 }
  ]);

  assert.equal(markdown, `# RTL Fixture\n\n<p dir="rtl">${right} ${left}</p>\n`);
});

test("linesToMarkdown groups wrapped RTL lines by right edge", () => {
  const first = "\u05d0\u05d1\u05d2 \u05d3\u05d4\u05d5";
  const second = "\u05d6\u05d7\u05d8 \u05d9\u05db\u05dc";
  const markdown = linesToMarkdown([
    { text: "RTL Wrap Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: first, fontSize: 12, x: 300, y: 680, width: 80, height: 12, pageIndex: 0 },
    { text: second, fontSize: 12, x: 260, y: 664, width: 120, height: 12, pageIndex: 0 }
  ]);

  assert.equal(markdown, `# RTL Wrap Fixture\n\n<p dir="rtl">${first} ${second}</p>\n`);
});

test("linesToMarkdown joins wrapped CJK lines without synthetic spaces", () => {
  const first = "\u3053\u308c\u306f\u4e00\u884c\u76ee";
  const second = "\u3067\u3059\u7d9a\u304d";
  const markdown = linesToMarkdown([
    { text: "CJK Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: first, fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: second, fontSize: 12, x: 72, y: 666, pageIndex: 0 }
  ]);

  assert.equal(markdown, `# CJK Fixture\n\n${first}${second}\n`);
});

test("linesToMarkdown treats CJK terminal punctuation as a paragraph boundary", () => {
  const first = "\u6700\u521d\u306e\u6587\u3067\u3059\u3002";
  const second = "\u6b21\u306e\u6bb5\u843d\u3067\u3059";
  const markdown = linesToMarkdown([
    { text: "CJK Boundary Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: first, fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: second, fontSize: 12, x: 72, y: 666, pageIndex: 0 }
  ]);

  assert.equal(markdown, `# CJK Boundary Fixture\n\n${first}\n\n${second}\n`);
});

test("linesToMarkdown orders vertical writing columns and emits writing mode markup", () => {
  const rightTop = "\u7e26";
  const rightBottom = "\u66f8\u304d";
  const leftTop = "\u5217";
  const leftBottom = "\u4e8c";
  const markdown = linesToMarkdown([
    { text: leftBottom, fontSize: 12, direction: "vertical", x: 260, y: 666, width: 12, height: 12, pageIndex: 0 },
    { text: rightBottom, fontSize: 12, direction: "vertical", x: 320, y: 666, width: 12, height: 12, pageIndex: 0 },
    { text: leftTop, fontSize: 12, direction: "vertical", x: 260, y: 680, width: 12, height: 12, pageIndex: 0 },
    { text: rightTop, fontSize: 12, direction: "vertical", x: 320, y: 680, width: 12, height: 12, pageIndex: 0 }
  ]);

  assert.equal(
    markdown,
    `<p style="writing-mode: vertical-rl">${rightTop}${rightBottom}</p>\n\n<p style="writing-mode: vertical-rl">${leftTop}${leftBottom}</p>\n`
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
  const result = linesToMarkdownWithSourceMap([
    { text: "Table Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Name", fontSize: 12, x: 72, y: 670, pageIndex: 0 },
    { text: "Count", fontSize: 12, x: 220, y: 670, pageIndex: 0 },
    { text: "Alpha", fontSize: 12, x: 72, y: 650, pageIndex: 0 },
    { text: "3", fontSize: 12, x: 220, y: 650, pageIndex: 0 },
    { text: "Beta", fontSize: 12, x: 72, y: 630, pageIndex: 0 },
    { text: "7", fontSize: 12, x: 220, y: 630, pageIndex: 0 }
  ]);

  assert.equal(
    result.markdown,
    "# Table Fixture\n\n| Name | Count |\n| --- | ---: |\n| Alpha | 3 |\n| Beta | 7 |\n"
  );
  assert.deepEqual(result.lowConfidenceTables, []);
  assert.deepEqual(result.tables, [
    {
      tableIndex: 0,
      source: "borderless-heuristic",
      pageIndex: 0,
      rows: 3,
      columns: 2,
      output: "gfm",
      confidence: 0.775,
      hasSpans: false,
      numericColumns: [1],
      sourceLines: 6
    }
  ]);
});

test("linesToMarkdown does not treat same-baseline prose columns as a table", () => {
  const result = linesToMarkdownWithSourceMap([
    { text: "Short Prose Columns", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Alpha topic", fontSize: 12, x: 72, y: 670, pageIndex: 0 },
    { text: "Beta topic", fontSize: 12, x: 330, y: 670, pageIndex: 0 },
    { text: "Alpha detail", fontSize: 12, x: 72, y: 650, pageIndex: 0 },
    { text: "Beta detail", fontSize: 12, x: 330, y: 650, pageIndex: 0 }
  ]);

  assert.equal(
    result.markdown,
    "# Short Prose Columns\n\nAlpha topic\n\nBeta topic\n\nAlpha detail\n\nBeta detail\n"
  );
  assert.deepEqual(result.tables, []);
  assert.deepEqual(result.lowConfidenceTables, []);
});

test("linesToMarkdownWithSourceMap reports low-confidence table-shaped text", () => {
  const result = linesToMarkdownWithSourceMap([
    { text: "Ambiguous Rows", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Name", fontSize: 12, x: 72, y: 670, pageIndex: 0 },
    { text: "Status", fontSize: 12, x: 220, y: 670, pageIndex: 0 },
    { text: "Alpha", fontSize: 12, x: 72, y: 650, pageIndex: 0 },
    { text: "Active", fontSize: 12, x: 220, y: 650, pageIndex: 0 },
    { text: "Beta", fontSize: 12, x: 72, y: 630, pageIndex: 0 },
    { text: "Pending", fontSize: 12, x: 220, y: 630, pageIndex: 0 },
    { text: "Gamma", fontSize: 12, x: 72, y: 610, pageIndex: 0 },
    { text: "Review", fontSize: 12, x: 220, y: 610, pageIndex: 0 }
  ]);

  assert.equal(
    result.markdown,
    "# Ambiguous Rows\n\nName\n\nStatus\n\nAlpha\n\nActive\n\nBeta\n\nPending\n\nGamma\n\nReview\n"
  );
  assert.deepEqual(result.tables, []);
  assert.deepEqual(result.lowConfidenceTables, [
    {
      tableIndex: 0,
      source: "borderless-heuristic",
      pageIndex: 0,
      rows: 4,
      columns: 2,
      confidence: 0.45,
      reason: "no-numeric-body-column",
      sourceLines: 8
    }
  ]);
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
  const result = linesToMarkdownWithSourceMap([
    { text: "Page Number Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "Body text.", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "1", fontSize: 9, x: 300, y: 40, width: 5, height: 9, pageIndex: 0 },
    { text: "2 / 3", fontSize: 9, x: 300, y: 40, width: 20, height: 9, pageIndex: 1 }
  ]);

  assert.equal(result.markdown, "# Page Number Fixture\n\nBody text.\n");
  assert.equal(result.layout.pages[0].pageNumbers.length, 1);
  assert.equal(result.layout.pages[0].pageNumbers[0].kind, "page-number");
});

test("linesToMarkdown can preserve configured running titles", () => {
  const lines = [
    { text: "Running Header", fontSize: 10, x: 72, y: 760, pageIndex: 0 },
    { text: "Header Footer Fixture", fontSize: 22, x: 72, y: 720, pageIndex: 0 },
    { text: "First page body.", fontSize: 12, x: 72, y: 680, pageIndex: 0 },
    { text: "Page Footer", fontSize: 10, x: 280, y: 40, pageIndex: 0 },
    { text: "Running Header", fontSize: 10, x: 72, y: 760, pageIndex: 1 },
    { text: "Second page body.", fontSize: 12, x: 72, y: 680, pageIndex: 1 },
    { text: "Page Footer", fontSize: 10, x: 280, y: 40, pageIndex: 1 }
  ];

  assert.equal(
    linesToMarkdown(lines),
    "# Header Footer Fixture\n\nFirst page body.\n\nSecond page body.\n"
  );
  assert.equal(
    linesToMarkdown(lines, { preserveRunningTitles: true }),
    "Running Header\n\n# Header Footer Fixture\n\nFirst page body.\n\nRunning Header\n\nSecond page body.\n"
  );
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

function textLine(text, x, y, width, fontSize) {
  return {
    text,
    fontSize,
    x,
    y,
    width,
    height: fontSize,
    pageIndex: 0
  };
}

function tableCell(rowIndex, columnIndex, text, lines, overrides = {}) {
  return {
    rowIndex,
    columnIndex,
    text,
    lines,
    lineCount: lines.length,
    rowSpan: 1,
    columnSpan: 1,
    coveredBy: null,
    ...overrides
  };
}
