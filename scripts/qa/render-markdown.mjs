import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

export function renderMarkdownToHtml(markdown) {
  const blocks = markdown.trimEnd().split(/\n{2,}/);
  const html = blocks
    .filter((block) => block.trim().length > 0)
    .map(renderBlock)
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Rendered Markdown</title>
</head>
<body>
<main class="markdown-body">
${html}
</main>
</body>
</html>
`;
}

function renderBlock(block) {
  const lines = block.split(/\n/);
  const firstLine = lines[0] ?? "";

  if (/^<a id="page-\d+"><\/a>$/.test(firstLine.trim())) {
    return firstLine.trim();
  }

  if (isRawHtmlTableBlock(block)) {
    return block.trim();
  }

  const heading = firstLine.match(/^(#{1,6})\s+(.+)$/);
  if (heading && lines.length === 1) {
    const level = heading[1].length;
    return `<h${level}>${escapeHtml(heading[2])}</h${level}>`;
  }

  if (lines.every((line) => /^-\s+/.test(line))) {
    return `<ul>\n${lines.map((line) => `  <li>${escapeHtml(line.replace(/^-\s+/, ""))}</li>`).join("\n")}\n</ul>`;
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return `<ol>\n${lines.map((line) => `  <li>${escapeHtml(line.replace(/^\d+\.\s+/, ""))}</li>`).join("\n")}\n</ol>`;
  }

  if (isTableBlock(lines)) {
    return renderTable(lines);
  }

  return `<p>${escapeHtml(lines.join(" "))}</p>`;
}

function isRawHtmlTableBlock(block) {
  return /^<table(?:\s[^>]*)?>[\s\S]*<\/table>$/.test(block.trim());
}

function isTableBlock(lines) {
  return (
    lines.length >= 2 &&
    lines.every((line) => line.trim().startsWith("|") && line.trim().endsWith("|")) &&
    /^\|\s*:?-{3,}:?/.test(lines[1])
  );
}

function renderTable(lines) {
  const header = splitTableRow(lines[0]);
  const body = lines.slice(2).map(splitTableRow);
  return [
    "<table>",
    "  <thead>",
    `    <tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>`,
    "  </thead>",
    "  <tbody>",
    ...body.map((row) => `    <tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`),
    "  </tbody>",
    "</table>"
  ].join("\n");
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function usage() {
  return `Usage:
  node scripts/qa/render-markdown.mjs <input.md> [--out <output.html>]
`;
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const inputPath = args.find((arg) => !arg.startsWith("--"));
  if (!inputPath) {
    console.error(usage());
    process.exit(1);
  }

  const markdown = await readFile(path.resolve(inputPath), "utf8");
  const html = renderMarkdownToHtml(markdown);
  const outputPath = readOption("--out");
  if (outputPath) {
    await writeFile(path.resolve(outputPath), html);
  } else {
    process.stdout.write(html);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
