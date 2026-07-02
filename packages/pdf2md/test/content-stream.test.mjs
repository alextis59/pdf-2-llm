import assert from "node:assert/strict";
import test from "node:test";
import {
  extractContentStreamTextLines,
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

test("extractContentStreamTextLines applies ToUnicode font maps to string bytes", () => {
  const lines = extractContentStreamTextLines("BT /F2 12 Tf 10 20 Td <0102> Tj ET", {
    resources
  });

  assert.equal(lines[0].text, "AB");
  assert.equal(lines[0].confidence, 0.95);
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
