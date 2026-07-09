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

test("LZWDecode decodes literal and dictionary-reference codes", () => {
  assert.equal(text(decode(packLzwCodes([256, 65, 66, 67, 257]), "/LZWDecode")), "ABC");
  assert.equal(text(decode(packLzwCodes([256, 65, 66, 258, 260, 257]), "/LZWDecode")), "ABABABA");
});

test("FlateDecode decodes compressed bytes", () => {
  const encoded = deflateSync(Buffer.from("Flate text", "latin1"));
  assert.equal(text(decode(encoded, "/FlateDecode")), "Flate text");
});

test("FlateDecode rejects high-ratio output through the bounded inflater", () => {
  const expanded = Buffer.alloc(1024 * 1024, 0x41);
  const encoded = deflateSync(expanded, { level: 9 });

  assert.ok(encoded.byteLength < 2048, "fixture should retain a high compression ratio");
  assert.throws(
    () => decode(encoded, "/FlateDecode", { maxBytes: 1024 }),
    (error) =>
      error instanceof PdfStreamDecodeError &&
      error.code === "pdf.stream.decoded_too_large" &&
      error.message === "FlateDecode decoded output exceeds byte limit."
  );
});

test("filter chains decode in declared order", () => {
  const compressed = deflateSync(Buffer.from("Chained text", "latin1"));
  const hex = Buffer.from(compressed).toString("hex") + ">";
  assert.equal(text(decode(hex, "[/ASCIIHexDecode /FlateDecode]")), "Chained text");
});

test("corrupt filter chains report the failing stage", () => {
  const corruptFlateHex = Buffer.from("not flate", "latin1").toString("hex") + ">";
  assert.throws(
    () => decode(corruptFlateHex, "[/ASCIIHexDecode /FlateDecode]"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.flate_failed"
  );

  const corruptRunLengthHex = Buffer.from([2, 97]).toString("hex") + ">";
  assert.throws(
    () => decode(corruptRunLengthHex, "[/ASCIIHexDecode /RunLengthDecode]"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.runlength_truncated"
  );

  assert.throws(
    () =>
      decode(
        deflateSync(new Uint8Array([0, 1])),
        "/FlateDecode /DecodeParms << /Predictor 15 /Columns 3 >>"
      ),
    (error) =>
      error instanceof PdfStreamDecodeError && error.code === "pdf.stream.predictor_row_mismatch"
  );

  assert.throws(
    () => decode("00>", "[/ASCIIHexDecode /Crypt /FlateDecode]"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.filter_unsupported"
  );
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

test("FlateDecode applies TIFF horizontal differencing predictor", () => {
  const predictedRows = new Uint8Array([
    10, 20, 30, 3, 5, 7,
    4, 6, 8, 2, 3, 4
  ]);
  const encoded = deflateSync(predictedRows);
  const dictionary = parsePdfValue(
    "<< /Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 2 /Colors 3 /BitsPerComponent 8 >> >>"
  ).value;
  const decoded = decodeStreamBytes(encoded, dictionary).bytes;

  assert.deepEqual([...decoded], [
    10, 20, 30, 13, 25, 37,
    4, 6, 8, 6, 9, 12
  ]);
});

test("LZWDecode applies TIFF horizontal differencing predictor", () => {
  const encoded = packLzwCodes([256, 10, 20, 30, 3, 5, 7, 257]);
  const dictionary = parsePdfValue(
    "<< /Filter /LZWDecode /DecodeParms << /Predictor 2 /Columns 2 /Colors 3 /BitsPerComponent 8 >> >>"
  ).value;
  const decoded = decodeStreamBytes(encoded, dictionary).bytes;

  assert.deepEqual([...decoded], [10, 20, 30, 13, 25, 37]);
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
    () => decodeStreamBytes(Buffer.from("abc", "latin1"), parsePdfValue("<< >>").value, { maxBytes: 2 }),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.decoded_too_large"
  );

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
    () =>
      decode(
        deflateSync(new Uint8Array([0])),
        "/FlateDecode /DecodeParms << /Predictor 2 /Columns 1 /BitsPerComponent 1 >>"
      ),
    (error) =>
      error instanceof PdfStreamDecodeError && error.code === "pdf.stream.predictor_unsupported"
  );

  assert.throws(
    () => decode(new Uint8Array([0]), "/LZWDecode"),
    (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.lzw_eod_missing"
  );
});

test("decoder enforces maxBytes across every supported filter path", () => {
  const tooLargeCases = [
    ["FlateDecode", () => decode(deflateSync(Buffer.from("abc", "latin1")), "/FlateDecode", { maxBytes: 2 })],
    ["ASCIIHexDecode", () => decode("616263>", "/ASCIIHexDecode", { maxBytes: 2 })],
    ["ASCII85Decode", () => decode("z~>", "/ASCII85Decode", { maxBytes: 3 })],
    ["RunLengthDecode", () => decode(new Uint8Array([254, 97, 128]), "/RunLengthDecode", { maxBytes: 2 })],
    ["LZWDecode", () => decode(packLzwCodes([256, 65, 66, 67, 257]), "/LZWDecode", { maxBytes: 2 })],
    [
      "Predictor",
      () =>
        decode(
          deflateSync(new Uint8Array([0, 1, 2, 3])),
          "/FlateDecode /DecodeParms << /Predictor 15 /Columns 3 >>",
          { maxBytes: 2 }
        )
    ],
    ["DCTDecode", () => decode(new Uint8Array([1, 2, 3]), "/DCTDecode", { maxBytes: 2 })],
    ["JPXDecode", () => decode(new Uint8Array([1, 2, 3]), "/JPXDecode", { maxBytes: 2 })],
    ["CCITTFaxDecode", () => decode(new Uint8Array([1, 2, 3]), "/CCITTFaxDecode", { maxBytes: 2 })],
    ["JBIG2Decode", () => decode(new Uint8Array([1, 2, 3]), "/JBIG2Decode", { maxBytes: 2 })]
  ];

  for (const [filter, run] of tooLargeCases) {
    assert.throws(
      run,
      (error) => error instanceof PdfStreamDecodeError && error.code === "pdf.stream.decoded_too_large",
      filter
    );
  }
});

function decode(input, filter, options = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "latin1") : input;
  const dictionary = parsePdfValue(`<< /Filter ${filter} >>`).value;
  return decodeStreamBytes(bytes, dictionary, options).bytes;
}

function packLzwCodes(codes, codeSize = 9) {
  const bits = [];
  for (const code of codes) {
    for (let shift = codeSize - 1; shift >= 0; shift -= 1) {
      bits.push((code >> shift) & 1);
    }
  }
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const bytes = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bits.length; index += 1) {
    bytes[index >> 3] |= bits[index] << (7 - (index & 7));
  }
  return bytes;
}

function text(bytes) {
  return Buffer.from(bytes).toString("latin1");
}
