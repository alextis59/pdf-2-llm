import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { PdfSyntaxError, parsePdfValue } from "../../src/pdf-parser.mjs";
import { createRng, randomAscii, randomInt, randomPdfValue } from "../utils.mjs";

export function runPdfValueParserFuzz({ iterations = 200, seed = 0x5eed } = {}) {
  const rng = createRng(seed);
  let parsedValid = 0;
  let rejectedMalformed = 0;
  const alphabet = "[]<>()/%#0123456789+- .\n\r\tABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  for (let index = 0; index < iterations; index += 1) {
    const value = randomPdfValue(rng);
    const parsed = parsePdfValue(value);
    assert.ok(parsed.offset > 0, value);
    parsedValid += 1;
  }

  for (let index = 0; index < iterations; index += 1) {
    const value = randomAscii(rng, randomInt(rng, 1, 80), alphabet);
    try {
      parsePdfValue(value);
    } catch (error) {
      assert.ok(error instanceof PdfSyntaxError, `${error.name}: ${value}`);
      rejectedMalformed += 1;
    }
  }

  return {
    target: "pdf-value-parser",
    seed,
    iterations,
    parsedValid,
    rejectedMalformed
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPdfValueParserFuzz({
    iterations: Number.parseInt(readOption("--iterations") ?? "200", 10),
    seed: Number.parseInt(readOption("--seed") ?? "24301", 10)
  });
  console.log(JSON.stringify(result));
}
