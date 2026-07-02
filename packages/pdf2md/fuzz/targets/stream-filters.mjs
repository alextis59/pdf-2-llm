import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parsePdfValue } from "../../src/pdf-parser.mjs";
import { PdfStreamDecodeError, decodeStreamBytes } from "../../src/stream-filters.mjs";
import { createRng, randomBytes, randomInt } from "../utils.mjs";

export function runStreamFiltersFuzz({ iterations = 200, seed = 0x51 } = {}) {
  const rng = createRng(seed);
  const filters = ["FlateDecode", "ASCIIHexDecode", "ASCII85Decode", "RunLengthDecode", "UnknownFilter"];
  let decoded = 0;
  let rejected = 0;

  for (let index = 0; index < iterations; index += 1) {
    const mode = randomInt(rng, 0, 5);
    const filter = filters[randomInt(rng, 0, filters.length - 1)];
    const dictionary =
      mode === 0
        ? parsePdfValue("<< >>").value
        : parsePdfValue(`<< /Filter /${mode === 1 ? "ASCIIHexDecode" : filter} >>`).value;
    const bytes =
      mode === 1 ? Buffer.from("48656c6c6f>", "ascii") : randomBytes(rng, randomInt(rng, 0, 64));
    try {
      decodeStreamBytes(bytes, dictionary, { maxBytes: 256 });
      decoded += 1;
    } catch (error) {
      assert.ok(error instanceof PdfStreamDecodeError, `${error.name}: /${filter}`);
      rejected += 1;
    }
  }

  return {
    target: "stream-filters",
    seed,
    iterations,
    decoded,
    rejected
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runStreamFiltersFuzz({
    iterations: Number.parseInt(readOption("--iterations") ?? "200", 10),
    seed: Number.parseInt(readOption("--seed") ?? "81", 10)
  });
  console.log(JSON.stringify(result));
}
