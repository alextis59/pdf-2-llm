import assert from "node:assert/strict";
import test from "node:test";
import {
  PdfContentStreamLimitError,
  extractContentStreamImageDraws,
  extractContentStreamRulingLines,
  extractContentStreamTextLines,
  mergeRulingLines,
  tokenizeContentStream
} from "../src/content-stream.mjs";

const resources = {
  fonts: {
    F1: {
      subtype: "Type1",
      baseFont: "Helvetica",
      encoding: "WinAnsiEncoding",
      hasToUnicode: false,
      toUnicode: null
    },
    F2: {
      subtype: "Type1",
      baseFont: "Custom",
      encoding: "CustomEncoding",
      hasToUnicode: true,
      toUnicode: {
        entries: 2,
        codespaces: [{ start: "00", end: "FF", length: 1 }],
        map: new Map([
          ["01", "A"],
          ["02", "B"]
        ])
      }
    },
    FWidth: {
      subtype: "Type1",
      baseFont: "Helvetica",
      encoding: "WinAnsiEncoding",
      hasToUnicode: false,
      toUnicode: null,
      firstChar: 32,
      widths: Array.from({ length: 95 }, () => 500)
    },
    FRemap: {
      subtype: "Type1",
      baseFont: "Custom",
      encoding: "CustomEncoding",
      hasToUnicode: true,
      toUnicode: {
        entries: 2,
        codespaces: [{ start: "00", end: "FF", length: 1 }],
        map: new Map([
          ["01", "W"],
          ["03", "ffi"]
        ])
      },
      firstChar: 1,
      widths: [250, 1_000, 750]
    }
  },
  xobjects: {
    ImScan: {
      objectNumber: 8,
      subtype: "Image",
      width: 20,
      height: 10
    },
    ImRot: {
      objectNumber: 9,
      subtype: "Image",
      width: 4,
      height: 8
    },
    Form1: {
      objectNumber: 10,
      subtype: "Form"
    }
  }
};

test("tokenizeContentStream decodes strings, names, arrays, numbers, and comments", () => {
  const tokens = tokenizeContentStream("/F#31 12 Tf % comment\n[(A\\050) -20 <42>] TJ /H2 << /MCID 3 >> BDC");
  assert.deepEqual(tokens.slice(0, 3), [
    { type: "name", value: "F1" },
    { type: "number", value: 12 },
    { type: "word", value: "Tf" }
  ]);
  assert.equal(tokens[3].type, "array");
  assert.deepEqual(tokens[3].items, [
    { type: "string", value: "A(", bytes: [65, 40] },
    { type: "number", value: -20 },
    { type: "string", value: "B", bytes: [66] }
  ]);
  assert.deepEqual(tokens[4], { type: "word", value: "TJ" });
  assert.deepEqual(tokens[6], {
    type: "dict",
    entries: {
      MCID: { type: "number", value: 3 }
    }
  });
  assert.deepEqual(tokens[7], { type: "word", value: "BDC" });
});

test("inline images skip binary operators and expose transformed image geometry", () => {
  const payload = "BT (phantom) Tj";
  const stream = [
    `q 20 0 0 10 5 7 cm BI /W ${payload.length} /H 1 /BPC 8 /CS /G ID ${payload}`,
    "EI Q",
    "BT /F1 12 Tf 10 20 Td (real) Tj ET"
  ].join("\n");
  const inlineImage = tokenizeContentStream(stream).find(
    (token) => token.type === "inline-image"
  );

  assert.deepEqual(inlineImage, {
    type: "inline-image",
    entries: {
      W: { type: "number", value: payload.length },
      H: { type: "number", value: 1 },
      BPC: { type: "number", value: 8 },
      CS: { type: "name", value: "G" }
    },
    dataLength: payload.length,
    complete: true
  });
  assert.deepEqual(
    extractContentStreamTextLines(stream, { resources }).map((line) => line.text),
    ["real"]
  );
  assert.deepEqual(extractContentStreamImageDraws(stream, { pageIndex: 2, streamIndex: 3 }), [
    {
      type: "image-draw",
      name: "inline-image",
      objectNumber: null,
      x: 5,
      y: 7,
      width: 20,
      height: 10,
      area: 200,
      imageWidth: payload.length,
      imageHeight: 1,
      imagePixels: payload.length,
      pageIndex: 2,
      streamIndex: 3,
      source: "inline-image"
    }
  ]);
});

test("filtered inline images require a valid EI operator boundary", () => {
  const payload = "abc EIx BT (phantom) Tj";
  const stream = [
    `BI /W 1 /H 1 /BPC 8 /CS /G /F /Fl ID ${payload}`,
    "EI",
    "BT /F1 12 Tf 10 20 Td (real) Tj ET"
  ].join("\n");
  const inlineImage = tokenizeContentStream(stream).find(
    (token) => token.type === "inline-image"
  );

  assert.equal(inlineImage.dataLength, payload.length);
  assert.equal(inlineImage.complete, true);
  assert.deepEqual(
    extractContentStreamTextLines(stream, { resources }).map((line) => line.text),
    ["real"]
  );
});

test("unterminated inline image data is never interpreted as content operators", () => {
  const stream = "BI /W 1 /H 1 /BPC 8 /CS /G ID BT /F1 12 Tf (phantom) Tj";
  const inlineImage = tokenizeContentStream(stream).find(
    (token) => token.type === "inline-image"
  );

  assert.equal(inlineImage.complete, false);
  assert.deepEqual(extractContentStreamTextLines(stream, { resources }), []);
  assert.deepEqual(extractContentStreamImageDraws(stream), []);
});

test("content stream operation limits accept the boundary and reject the next operator", () => {
  assert.deepEqual(
    extractContentStreamTextLines("BT ET", {
      contentStreamLimits: { maxOperations: 2 }
    }),
    []
  );
  assert.throws(
    () =>
      extractContentStreamTextLines("BT ET", {
        contentStreamLimits: { maxOperations: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.operation_limit_exceeded" &&
      error.details.limit === 1 &&
      error.details.actual === 2 &&
      error.details.extractor === "text"
  );
});

test("content stream depth limits cover graphics and marked-content stacks", () => {
  assert.doesNotThrow(() =>
    extractContentStreamTextLines("q q Q Q", {
      contentStreamLimits: { maxDepth: 2 }
    })
  );
  assert.throws(
    () =>
      extractContentStreamTextLines("q q Q Q", {
        contentStreamLimits: { maxDepth: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.depth_limit_exceeded" &&
      error.details.stackType === "graphics" &&
      error.details.actual === 2
  );
  assert.doesNotThrow(() =>
    extractContentStreamTextLines("/Span BMC /Span BMC EMC EMC", {
      contentStreamLimits: { maxDepth: 2 }
    })
  );
  assert.throws(
    () =>
      extractContentStreamTextLines("/Span BMC /Span BMC EMC EMC", {
        contentStreamLimits: { maxDepth: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.depth_limit_exceeded" &&
      error.details.stackType === "marked-content" &&
      error.details.actual === 2
  );
});

test("content stream limits bound nested syntax depth and operand tokens", () => {
  const deeplyNestedArray = `${"[".repeat(10_000)}(A)${"]".repeat(10_000)}`;

  assert.doesNotThrow(() =>
    tokenizeContentStream("[[[(A)]]]", {
      contentStreamLimits: { maxDepth: 3 }
    })
  );
  assert.throws(
    () =>
      tokenizeContentStream(deeplyNestedArray, {
        contentStreamLimits: { maxDepth: 32 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.depth_limit_exceeded" &&
      error.details.stackType === "syntax" &&
      error.details.limit === 32 &&
      error.details.actual === 33 &&
      error.details.extractor === "tokenizer"
  );
  assert.throws(
    () =>
      extractContentStreamTextLines(`BT /F1 12 Tf ${deeplyNestedArray} TJ ET`, {
        resources,
        contentStreamLimits: { maxDepth: 32 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.depth_limit_exceeded" &&
      error.details.stackType === "syntax" &&
      error.details.actual === 33 &&
      error.details.extractor === "text"
  );
  assert.throws(
    () =>
      tokenizeContentStream("<< /A << /B 1 >> >>", {
        contentStreamLimits: { maxDepth: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.depth_limit_exceeded" &&
      error.details.stackType === "syntax" &&
      error.details.actual === 2
  );
  assert.doesNotThrow(() =>
    tokenizeContentStream("[0 1 2 3]", {
      contentStreamLimits: { maxOperations: 5 }
    })
  );
  assert.throws(
    () =>
      tokenizeContentStream("[0 1 2 3]", {
        contentStreamLimits: { maxOperations: 4 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.operation_limit_exceeded" &&
      error.details.limit === 4 &&
      error.details.actual === 5 &&
      error.details.extractor === "tokenizer"
  );
});

test("content stream output limits bound text, path, and image expansion", () => {
  assert.equal(
    extractContentStreamTextLines("BT (AB) Tj ET", {
      resources,
      contentStreamLimits: { maxOutputs: 2 }
    })[0].text,
    "AB"
  );
  assert.throws(
    () =>
      extractContentStreamTextLines("BT (AB) Tj ET", {
        resources,
        contentStreamLimits: { maxOutputs: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.output_limit_exceeded" &&
      error.details.extractor === "text" &&
      error.details.actual === 2
  );

  assert.equal(
    extractContentStreamRulingLines("0 0 m 10 0 l S", {
      contentStreamLimits: { maxOutputs: 2 }
    }).length,
    1
  );
  assert.throws(
    () =>
      extractContentStreamRulingLines("0 0 m 10 0 l S", {
        contentStreamLimits: { maxOutputs: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.output_limit_exceeded" &&
      error.details.extractor === "ruling" &&
      error.details.actual === 2
  );

  assert.equal(
    extractContentStreamImageDraws("/ImScan Do", {
      resources,
      contentStreamLimits: { maxOutputs: 1 }
    }).length,
    1
  );
  assert.throws(
    () =>
      extractContentStreamImageDraws("/ImScan Do", {
        resources,
        contentStreamLimits: { maxOutputs: 0 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.output_limit_exceeded" &&
      error.details.extractor === "image" &&
      error.details.actual === 1
  );
});

test("extractContentStreamTextLines interprets text showing operators", () => {
  const lines = extractContentStreamTextLines(
    [
      "BT",
      "/F1 12 Tf",
      "10 20 Td",
      "(Hello) Tj",
      "[(, ) -120 (world)] TJ",
      "14 TL",
      "(next) '",
      "20 5 (quoted) \"",
      "ET"
    ].join("\n"),
    { resources, pageIndex: 2, streamIndex: 1 }
  );

  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, "Hello, world");
  assert.equal(lines[0].fontName, "F1");
  assert.equal(lines[0].font.baseFont, "Helvetica");
  assert.equal(lines[0].fontSize, 12);
  assert.equal(lines[0].x, 10);
  assert.equal(lines[0].y, 20);
  assert.equal(lines[0].width, 73.44);
  assert.equal(lines[0].height, 12);
  assert.equal(lines[0].direction, "ltr");
  assert.equal(lines[0].spans.length, 3);
  assert.equal(lines[0].spans[0].text, "Hello");
  assert.equal(lines[0].spans[0].direction, "ltr");
  assert.equal(lines[0].spans[1].text, ", ");
  assert.equal(lines[0].spans[2].text, "world");
  assert.equal(lines[0].glyphs.length, 12);
  assert.deepEqual(
    lines[0].glyphs.slice(0, 2).map((glyph) => [glyph.text, glyph.x, glyph.width]),
    [
      ["H", 10, 6],
      ["e", 16, 6]
    ]
  );
  assert.deepEqual(
    lines[0].glyphs.slice(5, 8).map((glyph) => [glyph.text, glyph.x, glyph.width]),
    [
      [",", 40, 6],
      [" ", 46, 6],
      ["w", 53.44, 6]
    ]
  );
  assert.equal(lines[0].pageIndex, 2);
  assert.equal(lines[0].streamIndex, 1);
  assert.equal(lines[1].text, "next");
  assert.equal(lines[1].y, 6);
  assert.equal(lines[2].text, "quoted");
  assert.equal(lines[2].y, -8);
});

test("extractContentStreamTextLines inserts word spaces for large TJ gaps", () => {
  const lines = extractContentStreamTextLines("BT /F1 12 Tf 10 20 Td [(Hello) -500 (world)] TJ ET", {
    resources
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Hello world");
  assert.equal(lines[0].width, 66);
  assert.deepEqual(
    lines[0].glyphs.slice(4, 7).map((glyph) => [glyph.text, glyph.x, glyph.width]),
    [
      ["o", 34, 6],
      [" ", 40, 6],
      ["w", 46, 6]
    ]
  );
});

test("extractContentStreamTextLines marks vertical text matrices", () => {
  const lines = extractContentStreamTextLines(
    [
      "BT",
      "/F1 12 Tf",
      "0 1 -1 0 300 700 Tm",
      "(AB) Tj",
      "ET"
    ].join("\n"),
    { resources, pageIndex: 0, streamIndex: 0 }
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "AB");
  assert.deepEqual(
    [lines[0].x, lines[0].y, lines[0].width, lines[0].height],
    [288, 700, 12, 12]
  );
  assert.equal(lines[0].direction, "vertical");
  assert.equal(lines[0].spans[0].direction, "vertical");
  assert.deepEqual(
    lines[0].glyphs.map((glyph) => [glyph.text, glyph.x, glyph.y, glyph.width, glyph.height]),
    [
      ["A", 288, 700, 12, 6],
      ["B", 288, 706, 12, 6]
    ]
  );
});

test("extractContentStreamTextLines bounds glyphs under a skewed text matrix", () => {
  const [line] = extractContentStreamTextLines(
    "BT /F1 12 Tf 1 0.5 0.25 1 10 20 Tm (AB) Tj ET",
    { resources, pageIndex: 0, streamIndex: 0 }
  );

  assert.deepEqual([line.x, line.y, line.width, line.height], [10, 20, 15, 18]);
  assert.deepEqual(
    [line.spans[0].x, line.spans[0].y, line.spans[0].width, line.spans[0].height],
    [10, 20, 15, 18]
  );
  assert.deepEqual(
    line.glyphs.map((glyph) => [glyph.text, glyph.x, glyph.y, glyph.width, glyph.height]),
    [
      ["A", 10, 20, 9, 15],
      ["B", 16, 23, 9, 15]
    ]
  );
});

test("extractContentStreamRulingLines detects stroked axis-aligned paths", () => {
  const lines = extractContentStreamRulingLines(
    [
      "2 w",
      "10 20 m 70 20 l S",
      "30 40 20 10 re S",
      "0 0 m 10 10 l S",
      "q 1 0 0 1 5 10 cm 0 0 m 0 20 l S Q"
    ].join("\n"),
    { pageIndex: 3, streamIndex: 2 }
  );

  assert.equal(lines.length, 6);
  assert.deepEqual(
    lines.map((line) => line.orientation),
    ["horizontal", "horizontal", "vertical", "horizontal", "vertical", "vertical"]
  );
  assert.deepEqual(
    lines.map((line) => [line.x1, line.y1, line.x2, line.y2]),
    [
      [10, 20, 70, 20],
      [30, 40, 50, 40],
      [50, 40, 50, 50],
      [30, 50, 50, 50],
      [30, 40, 30, 50],
      [5, 10, 5, 30]
    ]
  );
  assert.deepEqual([...new Set(lines.map((line) => line.width))], [2]);
  assert.deepEqual([...new Set(lines.map((line) => line.pageIndex))], [3]);
  assert.deepEqual([...new Set(lines.map((line) => line.streamIndex))], [2]);
  assert.deepEqual([...new Set(lines.map((line) => line.source))], ["path-operator"]);
});

test("extractContentStreamRulingLines preserves marked-content alt text", () => {
  const lines = extractContentStreamRulingLines(
    [
      "/Figure << /MCID 4 >> BDC",
      "10 20 70 40 re S",
      "EMC"
    ].join("\n"),
    {
      pageIndex: 3,
      streamIndex: 2,
      structureByMcid: new Map([
        [
          4,
          {
            mcid: 4,
            role: "Figure",
            path: ["Document", "Figure"],
            altText: "Tagged vector figure"
          }
        ]
      ])
    }
  );

  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map(({ markedContentId, structureRole, structurePath, altText }) => ({
      markedContentId,
      structureRole,
      structurePath,
      altText
    })),
    Array.from({ length: 4 }, () => ({
      markedContentId: 4,
      structureRole: "Figure",
      structurePath: ["Document", "Figure"],
      altText: "Tagged vector figure"
    }))
  );
});

test("extractContentStreamImageDraws detects transformed image XObjects", () => {
  const images = extractContentStreamImageDraws(
    [
      "q 200 0 0 100 10 20 cm /ImScan Do Q",
      "q 0 50 -25 0 80 90 cm /ImRot Do Q",
      "/Form1 Do"
    ].join("\n"),
    { resources, pageIndex: 3, streamIndex: 2 }
  );

  assert.deepEqual(images, [
    {
      type: "image-draw",
      name: "ImScan",
      objectNumber: 8,
      x: 10,
      y: 20,
      width: 200,
      height: 100,
      area: 20000,
      imageWidth: 20,
      imageHeight: 10,
      imagePixels: 200,
      pageIndex: 3,
      streamIndex: 2,
      source: "xobject-do"
    },
    {
      type: "image-draw",
      name: "ImRot",
      objectNumber: 9,
      x: 55,
      y: 90,
      width: 25,
      height: 50,
      area: 1250,
      imageWidth: 4,
      imageHeight: 8,
      imagePixels: 32,
      pageIndex: 3,
      streamIndex: 2,
      source: "xobject-do"
    }
  ]);
});

test("extractContentStreamImageDraws preserves marked-content alt text", () => {
  const images = extractContentStreamImageDraws(
    [
      "/Figure << /MCID 7 >> BDC",
      "q 200 0 0 100 10 20 cm /ImScan Do Q",
      "EMC"
    ].join("\n"),
    {
      resources,
      pageIndex: 3,
      streamIndex: 2,
      structureByMcid: new Map([
        [
          7,
          {
            mcid: 7,
            role: "Figure",
            path: ["Document", "Figure"],
            altText: "Tagged image figure"
          }
        ]
      ])
    }
  );

  assert.equal(images.length, 1);
  assert.equal(images[0].markedContentId, 7);
  assert.equal(images[0].structureRole, "Figure");
  assert.deepEqual(images[0].structurePath, ["Document", "Figure"]);
  assert.equal(images[0].altText, "Tagged image figure");
});

test("content stream extractors execute nested Form XObjects with composed matrices", () => {
  const inner = {
    objectNumber: 12,
    generationNumber: 0,
    subtype: "Form",
    matrix: [2, 0, 0, 2, 5, 7],
    stream: {
      text: [
        "BT /F1 10 Tf 0 0 Td (Nested) Tj ET",
        "0 0 10 5 re S",
        "q 4 0 0 3 1 2 cm /ImScan Do Q"
      ].join("\n")
    },
    resources: {
      fonts: resources.fonts,
      xobjects: { ImScan: resources.xobjects.ImScan }
    }
  };
  const outer = {
    objectNumber: 11,
    generationNumber: 0,
    subtype: "Form",
    matrix: [1, 0, 0, 1, 100, 200],
    stream: { text: "/Inner Do" },
    resources: {
      fonts: {},
      xobjects: { Inner: inner }
    }
  };
  const formResources = {
    fonts: {},
    xobjects: { Outer: outer }
  };
  const stream = "q 3 0 0 3 10 20 cm /Outer Do Q";
  const [line] = extractContentStreamTextLines(stream, {
    resources: formResources,
    pageIndex: 2,
    streamIndex: 4
  });
  const rulings = extractContentStreamRulingLines(stream, {
    resources: formResources,
    pageIndex: 2,
    streamIndex: 4
  });
  const [image] = extractContentStreamImageDraws(stream, {
    resources: formResources,
    pageIndex: 2,
    streamIndex: 4
  });

  assert.deepEqual(
    [line.text, line.x, line.y, line.width, line.height, line.fontSize],
    ["Nested", 325, 641, 180, 60, 60]
  );
  assert.deepEqual(
    rulings.map((item) => [item.orientation, item.x1, item.y1, item.x2, item.y2]),
    [
      ["horizontal", 325, 641, 385, 641],
      ["vertical", 385, 641, 385, 671],
      ["horizontal", 325, 671, 385, 671],
      ["vertical", 325, 641, 325, 671]
    ]
  );
  assert.deepEqual(
    [image.name, image.objectNumber, image.x, image.y, image.width, image.height],
    ["ImScan", 8, 331, 653, 24, 18]
  );
  assert.throws(
    () =>
      extractContentStreamTextLines(stream, {
        resources: formResources,
        contentStreamLimits: { maxDepth: 1 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.depth_limit_exceeded" &&
      error.details.stackType === "form-xobject" &&
      error.details.actual === 2
  );
});

test("content stream Form XObject cycles fail with a stable error", () => {
  const cyclic = {
    objectNumber: 20,
    generationNumber: 0,
    subtype: "Form",
    matrix: [1, 0, 0, 1, 0, 0],
    stream: { text: "/Self Do" },
    resources: null
  };
  cyclic.resources = { fonts: {}, xobjects: { Self: cyclic } };

  assert.throws(
    () =>
      extractContentStreamTextLines("/Cycle Do", {
        resources: { fonts: {}, xobjects: { Cycle: cyclic } },
        contentStreamLimits: { maxDepth: 10 }
      }),
    (error) =>
      error instanceof PdfContentStreamLimitError &&
      error.code === "pdf.content_stream.form_cycle_detected" &&
      error.details.stackType === "form-xobject" &&
      error.details.actual === 2 &&
      error.details.extractor === "text"
  );
});

test("extractContentStreamRulingLines merges near-collinear path fragments", () => {
  const lines = extractContentStreamRulingLines(
    [
      "0 10 m 20 10 l S",
      "20.4 10.2 m 40 10.2 l S",
      "45 10 m 50 10 l S",
      "5 0 m 5 10 l S",
      "5.2 10.4 m 5.2 20 l S",
      "8 0 m 8 10 l S"
    ].join("\n"),
    { pageIndex: 0, streamIndex: 0 }
  );

  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((line) => [line.orientation, line.x1, line.y1, line.x2, line.y2, line.segmentCount]),
    [
      ["horizontal", 0, 10.1, 40, 10.1, 2],
      ["horizontal", 45, 10, 50, 10, 1],
      ["vertical", 5.1, 0, 5.1, 20, 2],
      ["vertical", 8, 0, 8, 10, 1]
    ]
  );
});

test("mergeRulingLines merges parsed page streams without crossing unknown pages", () => {
  const parsedPageLines = mergeRulingLines([
    {
      type: "ruling-line",
      orientation: "horizontal",
      x1: 0,
      y1: 10,
      x2: 20,
      y2: 10,
      width: 1,
      segmentCount: 1,
      pageIndex: 0,
      streamIndex: 0,
      source: "path-operator"
    },
    {
      type: "ruling-line",
      orientation: "horizontal",
      x1: 20.2,
      y1: 10,
      x2: 40,
      y2: 10,
      width: 2,
      segmentCount: 1,
      pageIndex: 0,
      streamIndex: 1,
      source: "path-operator"
    }
  ]);

  assert.equal(parsedPageLines.length, 1);
  assert.deepEqual(parsedPageLines[0], {
    type: "ruling-line",
    orientation: "horizontal",
    x1: 0,
    y1: 10,
    x2: 40,
    y2: 10,
    width: 2,
    segmentCount: 2,
    pageIndex: 0,
    streamIndex: null,
    source: "path-operator"
  });

  const unknownPageLines = mergeRulingLines([
    {
      type: "ruling-line",
      orientation: "horizontal",
      x1: 0,
      y1: 10,
      x2: 20,
      y2: 10,
      width: 1,
      segmentCount: 1,
      pageIndex: null,
      streamIndex: 0,
      source: "path-operator"
    },
    {
      type: "ruling-line",
      orientation: "horizontal",
      x1: 20.2,
      y1: 10,
      x2: 40,
      y2: 10,
      width: 1,
      segmentCount: 1,
      pageIndex: null,
      streamIndex: 1,
      source: "path-operator"
    }
  ]);

  assert.equal(unknownPageLines.length, 2);
});

test("mergeRulingLines preserves adjacent buckets and late transitive merges", () => {
  const boundary = mergeRulingLines([
    testRulingLine({ orientation: "horizontal", start: 0, end: 10, coordinate: 0.49 }),
    testRulingLine({ orientation: "horizontal", start: 9.5, end: 20, coordinate: 0.51 })
  ]);
  assert.deepEqual(
    boundary.map((line) => [line.x1, line.y1, line.x2, line.y2, line.segmentCount]),
    [[0, 0.5, 20, 0.5, 2]]
  );

  const transitive = mergeRulingLines([
    testRulingLine({ orientation: "vertical", start: 23.12, end: 24.1, coordinate: 3.621 }),
    testRulingLine({ orientation: "vertical", start: 27.25, end: 28.36, coordinate: 3.859 }),
    testRulingLine({ orientation: "vertical", start: 25.87, end: 30.88, coordinate: 4.069 }),
    testRulingLine({ orientation: "vertical", start: 21.24, end: 25.72, coordinate: 4.2 })
  ]);
  assert.deepEqual(
    transitive.map((line) => [line.x1, line.y1, line.x2, line.y2, line.segmentCount]),
    [[3.93725, 21.24, 3.93725, 30.88, 4]]
  );
});

test("mergeRulingLines indexes large disjoint ruling sets", () => {
  const lines = Array.from({ length: 10_000 }, (_, index) =>
    testRulingLine({
      orientation: "horizontal",
      start: index * 3,
      end: index * 3 + 1,
      coordinate: 10
    })
  );

  const merged = mergeRulingLines(lines);
  assert.equal(merged.length, lines.length);
  assert.deepEqual(merged[0], lines[0]);
  assert.deepEqual(merged.at(-1), lines.at(-1));
});

function testRulingLine({ coordinate, end, orientation, start }) {
  return {
    type: "ruling-line",
    orientation,
    x1: orientation === "horizontal" ? start : coordinate,
    y1: orientation === "horizontal" ? coordinate : start,
    x2: orientation === "horizontal" ? end : coordinate,
    y2: orientation === "horizontal" ? coordinate : end,
    width: 1,
    segmentCount: 1,
    pageIndex: 0,
    streamIndex: 0,
    source: "path-operator"
  };
}

test("extractContentStreamTextLines applies ToUnicode font maps to string bytes", () => {
  const lines = extractContentStreamTextLines("BT /F2 12 Tf 10 20 Td <0102> Tj ET", {
    resources
  });

  assert.equal(lines[0].text, "AB");
  assert.equal(lines[0].confidence, 0.95);
});

test("extractContentStreamTextLines measures remapped text from source character codes", () => {
  const [line] = extractContentStreamTextLines(
    "BT /FRemap 12 Tf 10 20 Td <0103> Tj ET",
    { resources }
  );

  assert.equal(line.text, "Wffi");
  assert.equal(line.width, 12);
  assert.deepEqual(
    line.glyphs.map((glyph) => [glyph.text, glyph.x, glyph.width]),
    [
      ["W", 10, 3],
      ["ffi", 13, 9]
    ]
  );
});

test("extractContentStreamTextLines marks decoded RTL script text", () => {
  const rtlResources = {
    ...resources,
    fonts: {
      ...resources.fonts,
      F3: {
        subtype: "Type1",
        baseFont: "CustomHebrew",
        encoding: "CustomEncoding",
        hasToUnicode: true,
        toUnicode: {
          entries: 2,
          codespaces: [{ start: "00", end: "FF", length: 1 }],
          map: new Map([
            ["01", "\u05d0"],
            ["02", "\u05d1"]
          ])
        }
      }
    }
  };
  const lines = extractContentStreamTextLines("BT /F3 12 Tf 10 20 Td <0102> Tj ET", {
    resources: rtlResources
  });

  assert.equal(lines[0].text, "\u05d0\u05d1");
  assert.equal(lines[0].direction, "rtl");
  assert.equal(lines[0].spans[0].direction, "rtl");
});

test("extractContentStreamTextLines records invisible text rendering mode", () => {
  const lines = extractContentStreamTextLines(
    [
      "BT /F1 12 Tf 3 Tr 10 20 Td (Hidden) Tj ET",
      "BT /F1 12 Tf 0 Tr 10 40 Td (Visible) Tj ET"
    ].join("\n"),
    { resources }
  );

  assert.equal(lines[0].textRenderMode, 3);
  assert.deepEqual(lines[0].textRenderModes, [3]);
  assert.equal(lines[0].hidden, true);
  assert.equal(lines[0].hasHiddenText, true);
  assert.equal(lines[0].spans[0].hidden, true);
  assert.equal(lines[0].spans[0].textRenderMode, 3);
  assert.equal(lines[1].textRenderMode, 0);
  assert.equal(lines[1].hidden, false);
  assert.equal(lines[1].hasHiddenText, false);
});

test("extractContentStreamTextLines attaches tagged structure from marked content", () => {
  const lines = extractContentStreamTextLines(
    [
      "/H2 << /MCID 0 >> BDC",
      "BT /F1 12 Tf 10 20 Td (Tagged heading) Tj ET",
      "EMC"
    ].join("\n"),
    {
      resources,
      structureByMcid: new Map([
        [
          0,
          {
            mcid: 0,
            role: "H2",
            rawRole: "HeadingTwo",
            path: ["Document", "H2"]
          }
        ]
      ])
    }
  );

  assert.equal(lines[0].markedContentId, 0);
  assert.equal(lines[0].markedContentTag, "H2");
  assert.equal(lines[0].structureRole, "H2");
  assert.deepEqual(lines[0].structurePath, ["Document", "H2"]);
  assert.equal(lines[0].spans[0].source, "tagged-pdf");
});

test("extractContentStreamTextLines keeps marked content across graphics state restore", () => {
  const lines = extractContentStreamTextLines(
    [
      "/H2 << /MCID 0 >> BDC",
      "q",
      "BT /F1 12 Tf 10 20 Td (Tagged heading) Tj ET",
      "Q",
      "BT /F1 12 Tf 10 5 Td (Still tagged) Tj ET",
      "EMC"
    ].join("\n"),
    {
      resources,
      structureByMcid: new Map([[0, { mcid: 0, role: "H2", path: ["Document", "H2"] }]])
    }
  );

  assert.deepEqual(
    lines.map((line) => line.structureRole),
    ["H2", "H2"]
  );
});

test("extractContentStreamTextLines tracks text matrices and CTM graphics state", () => {
  const lines = extractContentStreamTextLines(
    [
      "q",
      "1 0 0 1 50 60 cm",
      "BT /F1 18 Tf 1 0 0 1 10 20 Tm (translated) Tj ET",
      "Q",
      "BT /F1 18 Tf 1 0 0 1 10 20 Tm (restored) Tj ET"
    ].join("\n"),
    { resources }
  );

  assert.deepEqual(
    lines.map((line) => [line.text, line.x, line.y]),
    [
      ["translated", 60, 80],
      ["restored", 10, 20]
    ]
  );
});

test("extractContentStreamTextLines stores effective font metrics under scaled CTM", () => {
  const lines = extractContentStreamTextLines(
    [
      "q",
      "18 0 0 18 200 668 cm",
      "BT",
      "/F1 1 Tf",
      "0 0 Td",
      "(Enabling) Tj",
      "4.1291 0 Td",
      "(interpretable) Tj",
      "ET",
      "Q"
    ].join("\n"),
    { resources }
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Enabling interpretable");
  assert.equal(lines[0].fontSize, 18);
  assert.equal(lines[0].height, 18);
  assert.equal(lines[0].x, 200);
  assert.equal(lines[0].y, 668);
  assert.equal(lines[0].width, 191.3238);
  assert.deepEqual(
    lines[0].glyphs.slice(0, 3).map((glyph) => [glyph.text, glyph.x, glyph.width, glyph.fontSize]),
    [
      ["E", 200, 9, 18],
      ["n", 209, 9, 18],
      ["a", 218, 9, 18]
    ]
  );
});

test("extractContentStreamTextLines joins adjacent fragments across text objects", () => {
  const lines = extractContentStreamTextLines(
    [
      "BT /FWidth 10 Tf 200 300 Td (Syste) Tj ET",
      "BT /FWidth 10 Tf 225.1 300 Td (ms Technology) Tj ET",
      "BT /FWidth 10 Tf 400 300 Td (Separate) Tj ET"
    ].join("\n"),
    { resources }
  );

  assert.deepEqual(
    lines.map((line) => line.text),
    ["Systems Technology", "Separate"]
  );
});

test("extractContentStreamTextLines spaces positioned one-letter words without splitting fragments", () => {
  const spaced = extractContentStreamTextLines(
    [
      "BT",
      "/FWidth 10 Tf",
      "200 300 Td",
      "(showed) Tj",
      "32.2 0 Td",
      "(a) Tj",
      "7.1 0 Td",
      "(result) Tj",
      "ET"
    ].join("\n"),
    { resources }
  );
  const glued = extractContentStreamTextLines(
    ["BT", "/FWidth 10 Tf", "200 300 Td", "(exampl) Tj", "30.4 0 Td", "(e) Tj", "ET"].join(
      "\n"
    ),
    { resources }
  );
  const possessive = extractContentStreamTextLines(
    ["BT", "/FWidth 10 Tf", "200 300 Td", "(brain's) Tj", "34.4 0 Td", "(inductive) Tj", "ET"].join(
      "\n"
    ),
    { resources }
  );
  const overlappingFragments = extractContentStreamTextLines(
    ["BT", "/F1 10 Tf", "200 300 Td", "(Digit) Tj", "24.9 0 Td", "(al) Tj", "ET"].join(
      "\n"
    ),
    { resources }
  );
  const overlappingHyphenatedFragments = extractContentStreamTextLines(
    ["BT", "/F1 10 Tf", "200 300 Td", "(multi-) Tj", "29.9 0 Td", "(factor) Tj", "ET"].join(
      "\n"
    ),
    { resources }
  );

  assert.equal(spaced.length, 1);
  assert.equal(spaced[0].text, "showed a result");
  assert.equal(glued.length, 1);
  assert.equal(glued[0].text, "example");
  assert.equal(possessive.length, 1);
  assert.equal(possessive[0].text, "brain's inductive");
  assert.equal(overlappingFragments[0].text, "Digital");
  assert.equal(overlappingHyphenatedFragments[0].text, "multi-factor");
});
