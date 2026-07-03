import assert from "node:assert/strict";
import test from "node:test";
import {
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
  assert.equal(lines[0].width, 72);
  assert.equal(lines[0].height, 12);
  assert.equal(lines[0].spans.length, 2);
  assert.equal(lines[0].spans[0].text, "Hello");
  assert.equal(lines[0].spans[1].text, ", world");
  assert.equal(lines[0].glyphs.length, 12);
  assert.deepEqual(
    lines[0].glyphs.slice(0, 2).map((glyph) => [glyph.text, glyph.x, glyph.width]),
    [
      ["H", 10, 6],
      ["e", 16, 6]
    ]
  );
  assert.equal(lines[0].pageIndex, 2);
  assert.equal(lines[0].streamIndex, 1);
  assert.equal(lines[1].text, "next");
  assert.equal(lines[1].y, 6);
  assert.equal(lines[2].text, "quoted");
  assert.equal(lines[2].y, -8);
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

test("extractContentStreamTextLines applies ToUnicode font maps to string bytes", () => {
  const lines = extractContentStreamTextLines("BT /F2 12 Tf 10 20 Td <0102> Tj ET", {
    resources
  });

  assert.equal(lines[0].text, "AB");
  assert.equal(lines[0].confidence, 0.95);
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
