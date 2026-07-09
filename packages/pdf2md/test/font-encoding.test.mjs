import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePdfStringWithFont,
  PdfCMapParseError,
  parseToUnicodeCMap
} from "../src/font-encoding.mjs";

test("decodePdfStringWithFont renders unmapped control bytes as visible control pictures", () => {
  const token = { type: "string", bytes: [0x41, 0x15, 0x01, 0x7f, 0x42] };

  assert.equal(decodePdfStringWithFont(token, null), "A\u2415\u2401\u2421B");
  assert.equal(
    decodePdfStringWithFont(token, {
      toUnicode: {
        codespaces: [{ start: "00", end: "FF", length: 1 }],
        map: new Map([["41", "A"]])
      }
    }),
    "A\u2415\u2401\u2421B"
  );
});

test("parseToUnicodeCMap accepts a sequential range at the mapping limit", () => {
  const cmap = parseToUnicodeCMap(cmapWithBody("<00> <03> <0041>"), {
    maxMappings: 4
  });

  assert.equal(cmap.entries, 4);
  assert.deepEqual([...cmap.map.entries()], [
    ["00", "A"],
    ["01", "B"],
    ["02", "C"],
    ["03", "D"]
  ]);
});

test("parseToUnicodeCMap rejects one sequential range beyond the mapping limit", () => {
  assert.throws(
    () => parseToUnicodeCMap(cmapWithBody("<00000000> <FFFFFFFF> <0041>"), { maxMappings: 4 }),
    (error) =>
      error instanceof PdfCMapParseError && error.code === "pdf.cmap_mapping_limit_exceeded"
  );
});

test("parseToUnicodeCMap enforces the aggregate mapping limit across blocks", () => {
  const cmap = [
    "2 beginbfchar",
    "<00> <0041>",
    "<01> <0042>",
    "endbfchar",
    "1 beginbfrange",
    "<02> <04> <0043>",
    "endbfrange"
  ].join("\n");

  assert.throws(
    () => parseToUnicodeCMap(cmap, { maxMappings: 4 }),
    (error) =>
      error instanceof PdfCMapParseError && error.code === "pdf.cmap_mapping_limit_exceeded"
  );
});

function cmapWithBody(body) {
  return ["1 beginbfrange", body, "endbfrange"].join("\n");
}
