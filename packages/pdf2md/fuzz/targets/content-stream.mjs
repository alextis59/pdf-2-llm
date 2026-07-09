import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  PdfContentStreamLimitError,
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
  const limitBoundaries = exerciseLimitBoundaries();

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
    emittedLines,
    limitBoundaries
  };
}

function exerciseLimitBoundaries() {
  extractContentStreamTextLines("q q Q Q", {
    contentStreamLimits: { maxOperations: 4, maxDepth: 2 }
  });
  expectContentStreamLimit("pdf.content_stream.operation_limit_exceeded", () =>
    extractContentStreamTextLines("q q Q Q q", {
      contentStreamLimits: { maxOperations: 4, maxDepth: 2 }
    })
  );
  expectContentStreamLimit("pdf.content_stream.depth_limit_exceeded", () =>
    extractContentStreamTextLines("q q q", {
      contentStreamLimits: { maxDepth: 2 }
    })
  );
  expectContentStreamLimit("pdf.content_stream.output_limit_exceeded", () =>
    extractContentStreamTextLines("BT (ABC) Tj ET", {
      resources,
      contentStreamLimits: { maxOutputs: 2 }
    })
  );
  return 3;
}

function expectContentStreamLimit(code, callback) {
  try {
    callback();
  } catch (error) {
    if (error instanceof PdfContentStreamLimitError && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected content stream fuzz boundary to reject with ${code}`);
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
