import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  decodePdfStringWithFont,
  isTrustedSimpleEncoding,
  PdfCMapParseError,
  parseToUnicodeCMap
} from "../../src/font-encoding.mjs";
import { createRng, randomAscii, randomBytes, randomInt } from "../utils.mjs";

const unicodeDestinations = ["0020", "0041", "0061", "00E9", "03A9", "05D0", "30A2", "4E2D"];
const simpleEncodings = ["WinAnsiEncoding", "StandardEncoding", "MacRomanEncoding", "Identity-H", null];

export function runFontEncodingFuzz({ iterations = 200, seed = 0xf07a } = {}) {
  const rng = createRng(seed);
  let parsedCMaps = 0;
  let decodedStrings = 0;
  let malformedCMaps = 0;
  let mappingLimitChecks = 0;
  let trustedSimpleEncodings = 0;

  for (let index = 0; index < iterations; index += 1) {
    const cmap = parseToUnicodeCMap(randomToUnicodeCMap(rng));
    assert.ok(Array.isArray(cmap.codespaces));
    assert.equal(cmap.entries, cmap.map.size);
    parsedCMaps += 1;

    const decoded = decodePdfStringWithFont(
      {
        type: "string",
        value: "",
        bytes: randomBytes(rng, randomInt(rng, 0, 16))
      },
      { toUnicode: cmap }
    );
    assert.equal(typeof decoded, "string");
    decodedStrings += 1;

    const fallback = decodePdfStringWithFont(
      {
        type: "string",
        value: "fallback",
        bytes: null
      },
      null
    );
    assert.equal(fallback, "fallback");

    const encoding = simpleEncodings[randomInt(rng, 0, simpleEncodings.length - 1)];
    if (isTrustedSimpleEncoding({ encoding })) {
      trustedSimpleEncodings += 1;
    }
  }

  for (let index = 0; index < iterations; index += 1) {
    const cmap = parseToUnicodeCMap(randomMalformedCMap(rng));
    assert.ok(Array.isArray(cmap.codespaces));
    assert.equal(cmap.entries, cmap.map.size);
    malformedCMaps += 1;
  }

  for (let index = 0; index < iterations; index += 1) {
    const maxMappings = randomInt(rng, 1, 16);
    const withinLimit = rangeCMap(0, maxMappings - 1);
    const overLimit = rangeCMap(0, maxMappings);

    assert.equal(parseToUnicodeCMap(withinLimit, { maxMappings }).entries, maxMappings);
    assert.throws(
      () => parseToUnicodeCMap(overLimit, { maxMappings }),
      (error) =>
        error instanceof PdfCMapParseError && error.code === "pdf.cmap_mapping_limit_exceeded"
    );
    mappingLimitChecks += 1;
  }

  return {
    target: "font-encoding",
    seed,
    iterations,
    parsedCMaps,
    decodedStrings,
    malformedCMaps,
    mappingLimitChecks,
    trustedSimpleEncodings
  };
}

function randomToUnicodeCMap(rng) {
  const codespaceStart = randomByteHex(rng, 0, 16);
  const codespaceEnd = randomByteHex(rng, 224, 255);
  const charMappings = Array.from({ length: randomInt(rng, 1, 5) }, () => {
    return `<${randomByteHex(rng)}> <${randomUnicodeDestination(rng)}>`;
  });
  const rangeStart = randomInt(rng, 0, 240);
  const rangeEnd = rangeStart + randomInt(rng, 0, 4);

  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    `<${codespaceStart}> <${codespaceEnd}>`,
    "endcodespacerange",
    `${charMappings.length} beginbfchar`,
    ...charMappings,
    "endbfchar",
    "1 beginbfrange",
    `<${byteToHex(rangeStart)}> <${byteToHex(rangeEnd)}> <${randomUnicodeDestination(rng)}>`,
    "endbfrange",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end"
  ].join("\n");
}

function randomMalformedCMap(rng) {
  const boundedRangeStart = randomInt(rng, 0, 8);
  const boundedRangeEnd = boundedRangeStart + randomInt(rng, 0, 3);
  return [
    randomAscii(rng, randomInt(rng, 0, 40), "0123456789ABCDEF<>[] \n"),
    "beginbfchar",
    `<${randomByteHex(rng)}>`,
    `<${randomByteHex(rng)}> <${randomUnicodeDestination(rng)}`,
    "endbfchar",
    "beginbfrange",
    `<${byteToHex(boundedRangeStart)}> <${byteToHex(boundedRangeEnd)}> [<0041> <0042>]`,
    "endbfrange"
  ].join("\n");
}

function randomUnicodeDestination(rng) {
  return unicodeDestinations[randomInt(rng, 0, unicodeDestinations.length - 1)];
}

function rangeCMap(start, end) {
  return [
    "1 beginbfrange",
    `<${byteToHex(start)}> <${byteToHex(end)}> <0041>`,
    "endbfrange"
  ].join("\n");
}

function randomByteHex(rng, min = 0, max = 255) {
  return byteToHex(randomInt(rng, min, max));
}

function byteToHex(value) {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runFontEncodingFuzz({
    iterations: Number.parseInt(readOption("--iterations") ?? "200", 10),
    seed: Number.parseInt(readOption("--seed") ?? "61562", 10)
  });
  console.log(JSON.stringify(result));
}
