import process from "node:process";
import { runContentStreamFuzz } from "./targets/content-stream.mjs";
import { runFontEncodingFuzz } from "./targets/font-encoding.mjs";
import { runPdfValueParserFuzz } from "./targets/pdf-value-parser.mjs";
import { runStreamFiltersFuzz } from "./targets/stream-filters.mjs";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const iterations = Number.parseInt(readOption("--iterations") ?? "200", 10);
if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error("--iterations must be a positive integer");
}

const results = [
  runPdfValueParserFuzz({ iterations }),
  runStreamFiltersFuzz({ iterations }),
  runFontEncodingFuzz({ iterations }),
  runContentStreamFuzz({ iterations })
];

for (const result of results) {
  console.log(
    `FUZZ ${result.target} seed=${result.seed} iterations=${result.iterations} ${JSON.stringify(result)}`
  );
}
console.log(`Fuzz smoke passed: ${results.length} target(s).`);
