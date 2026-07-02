import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { renderMarkdownToHtml } from "./render-markdown.mjs";

const args = process.argv.slice(2);

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function positionalArgs() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function usage() {
  return `Usage:
  node scripts/qa/diff-html.mjs <expected.md> <actual.md> [--report <report.html>]
`;
}

function firstDifferentLine(left, right) {
  const leftLines = left.split(/\n/);
  const rightLines = right.split(/\n/);
  const length = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < length; index += 1) {
    if ((leftLines[index] ?? "") !== (rightLines[index] ?? "")) {
      return {
        line: index + 1,
        expected: leftLines[index] ?? "",
        actual: rightLines[index] ?? ""
      };
    }
  }
  return null;
}

async function renderFile(filePath) {
  return renderMarkdownToHtml(await readFile(path.resolve(filePath), "utf8"));
}

async function writeReport(reportPath, expectedHtml, actualHtml) {
  const report = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Rendered HTML Diff</title>
  <style>
    body { font-family: sans-serif; margin: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    iframe { width: 100%; min-height: 70vh; border: 1px solid #999; }
  </style>
</head>
<body>
  <h1>Rendered HTML Diff</h1>
  <div class="grid">
    <section>
      <h2>Expected</h2>
      <iframe srcdoc="${escapeAttribute(expectedHtml)}"></iframe>
    </section>
    <section>
      <h2>Actual</h2>
      <iframe srcdoc="${escapeAttribute(actualHtml)}"></iframe>
    </section>
  </div>
</body>
</html>
`;
  await writeFile(path.resolve(reportPath), report);
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }

  const [expectedPath, actualPath] = positionalArgs();
  if (!expectedPath || !actualPath) {
    console.error(usage());
    process.exit(1);
  }

  const expectedHtml = await renderFile(expectedPath);
  const actualHtml = await renderFile(actualPath);
  const reportPath = readOption("--report");
  if (reportPath) {
    await writeReport(reportPath, expectedHtml, actualHtml);
  }

  if (expectedHtml !== actualHtml) {
    const difference = firstDifferentLine(expectedHtml, actualHtml);
    console.error("Rendered HTML differs.");
    if (difference) {
      console.error(`First difference at rendered HTML line ${difference.line}.`);
      console.error(`Expected: ${difference.expected}`);
      console.error(`Actual:   ${difference.actual}`);
    }
    process.exit(1);
  }

  console.log("Rendered HTML matches.");
}

await main();
