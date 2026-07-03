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

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const inputPath = args.find((arg) => !arg.startsWith("--"));
const outputPath = readOption("--output");
const json = args.includes("--json");

if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
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
