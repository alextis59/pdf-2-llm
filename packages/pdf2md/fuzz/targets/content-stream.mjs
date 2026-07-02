import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  extractContentStreamTextLines,
  tokenizeContentStream
} from "../../src/content-stream.mjs";
import { createRng, randomContentStream } from "../utils.mjs";

const resources = {
  fonts: {
    F1: {
      subtype: "Type1",
      baseFont: "Helvetica",
      encoding: "WinAnsiEncoding",
      hasToUnicode: false,
      toUnicode: null
    }
  }
};

export function runContentStreamFuzz({ iterations = 200, seed = 0xc0ffee } = {}) {
  const rng = createRng(seed);
  let tokenized = 0;
  let interpreted = 0;
  let emittedLines = 0;

  for (let index = 0; index < iterations; index += 1) {
    const stream = randomContentStream(rng);
    tokenized += tokenizeContentStream(stream).length;
    const lines = extractContentStreamTextLines(stream, { resources });
    emittedLines += lines.length;
    interpreted += 1;
  }

  return {
    target: "content-stream",
    seed,
    iterations,
    tokenized,
    interpreted,
    emittedLines
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runContentStreamFuzz({
    iterations: Number.parseInt(readOption("--iterations") ?? "200", 10),
    seed: Number.parseInt(readOption("--seed") ?? "12648430", 10)
  });
  console.log(JSON.stringify(result));
}
