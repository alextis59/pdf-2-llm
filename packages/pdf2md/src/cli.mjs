#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { convertPdfToMarkdown } from "./index.mjs";

const args = process.argv.slice(2);

function usage() {
  return `Usage:
  pdf-2-llm <input.pdf> [--output <path>] [--json]
`;
}

function parseArgs(argv) {
  const parsed = {
    inputPath: undefined,
    outputPath: undefined,
    json: false,
    error: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        parsed.error = "--output requires a path.";
        return parsed;
      }
      parsed.outputPath = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith("--") && !parsed.inputPath) {
      parsed.inputPath = arg;
    }
  }

  return parsed;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const { inputPath, outputPath, json, error } = parseArgs(args);

if (error) {
  console.error(error);
  console.log(usage());
  process.exit(1);
}

if (!inputPath) {
  console.log(usage());
  process.exit(1);
}

const result = await convertPdfToMarkdown(inputPath);
const body = json ? `${JSON.stringify(result, null, 2)}\n` : result.markdown;

if (outputPath) {
  await writeFile(outputPath, body);
} else {
  process.stdout.write(body);
}
