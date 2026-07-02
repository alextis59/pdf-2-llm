import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeStreamBytes, PdfStreamDecodeError } from "../src/stream-filters.mjs";
import { parsePdfValue } from "../src/pdf-parser.mjs";

test("ASCIIHexDecode decodes even and odd nibble inputs", () => {
  assert.equal(text(decode("48656c6c6f>", "/ASCIIHexDecode")), "Hello");
  assert.deepEqual([...decode("6>", "/ASCIIHexDecode")], [0x60]);
});

test("ASCII85Decode decodes full and partial groups", () => {
  assert.equal(text(decode("<~87cURD_*#TDfTZ)+T~>", "/ASCII85Decode")), "Hello, world!");
  assert.equal(text(decode("z~>", "/ASCII85Decode")), "\0\0\0\0");
});

test("RunLengthDecode decodes literal and repeat runs", () => {
  const encoded = new Uint8Array([2, 97, 98, 99, 254, 122, 128]);
  assert.equal(text(decode(encoded, "/RunLengthDecode")), "abczzz");
});

test("FlateDecode decodes compressed bytes", () => {
  const encoded = deflateSync(Buffer.from("Flate text", "latin1"));
  assert.equal(text(decode(encoded, "/FlateDecode")), "Flate text");
});

test("filter chains decode in declared order", () => {
  const compressed = deflateSync(Buffer.from("Chained text", "latin1"));
  const hex = Buffer.from(compressed).toString("hex") + ">";
  assert.equal(text(decode(hex, "[/ASCIIHexDecode /FlateDecode]")), "Chained text");
});

test("FlateDecode applies PNG predictors", () => {
  const predictedRows = new Uint8Array([
    0, 1, 2, 3,
    2, 3, 3, 3
  ]);
  const encoded = deflateSync(predictedRows);
  const dictionary = parsePdfValue(
    "<< /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 3 /Colors 1 /BitsPerComponent 8 >> >>"
  ).value;
  const decoded = decodeStreamBytes(encoded, dictionary).bytes;
  assert.deepEqual([...decoded], [1, 2, 3, 4, 5, 6]);
});

test("raster image filters are metadata-only pass-through filters", () => {
  const encoded = Buffer.from("ffd8ff", "hex").toString("hex") + ">";
  const dictionary = parsePdfValue("<< /Filter [/ASCIIHexDecode /DCTDecode] >>").value;
  const decoded = decodeStreamBytes(Buffer.from(encoded, "latin1"), dictionary);

  assert.deepEqual([...decoded.bytes], [0xff, 0xd8, 0xff]);
  assert.deepEqual(decoded.filters, ["ASCIIHexDecode", "DCTDecode"]);
  assert.deepEqual(decoded.skippedFilters, [
    {
      filter: "DCTDecode",
      reason: "metadata-only",
      mediaType: "image/jpeg",
      family: "raster-image"
    }
  ]);
});

test("decoder enforces limits and reports corrupt streams", () => {
  assert.throws(
    () => decode("48656c6c6f>", "/ASCIIHexDecode", { maxBytes: 2 }),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.decoded_too_large"
  );

  assert.throws(
    () => decode("not flate", "/FlateDecode"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.flate_failed"
  );

  assert.throws(
    () => decode(new Uint8Array([2, 97]), "/RunLengthDecode"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.runlength_truncated"
  );

  assert.throws(
    () => decode("not lzw", "/LZWDecode"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.filter_unsupported"
  );
});

function decode(input, filter, options = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "latin1") : input;
  const dictionary = parsePdfValue(`<< /Filter ${filter} >>`).value;
  return decodeStreamBytes(bytes, dictionary, options).bytes;
}

function text(bytes) {
  return Buffer.from(bytes).toString("latin1");
}
