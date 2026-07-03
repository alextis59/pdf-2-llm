import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultCaseIds = Object.freeze([
  "synthetic-simple-text",
  "synthetic-headings-lists",
  "synthetic-visible-table",
  "synthetic-complex-spanned-table",
  "synthetic-vector-figure",
  "synthetic-scientific-two-column",
  "synthetic-rtl-text",
  "synthetic-cjk-text",
  "synthetic-vertical-writing"
]);

export function parseMarkdownAst(markdown) {
  const text = normalizeNewlines(markdown).trimEnd();
  if (text.length === 0) {
    return { type: "document", children: [] };
  }
  return {
    type: "document",
    children: splitMarkdownBlocks(text).map(parseBlock)
  };
}

export function compareMarkdownAst(expectedMarkdown, actualMarkdown) {
  const expectedAst = parseMarkdownAst(expectedMarkdown);
  const actualAst = parseMarkdownAst(actualMarkdown);
  const differences = findAstDifferences(expectedAst, actualAst);
  return {
    expectedBlocks: expectedAst.children.length,
    actualBlocks: actualAst.children.length,
    differences,
    passed: differences.length === 0
  };
}

export function createMarkdownAstDiffReport(results) {
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed: results.every((result) => result.passed),
    results
  };
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function splitMarkdownBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let current = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|\$\$)/.test(line)) {
      fenced = !fenced;
      current.push(line);
      continue;
    }
    if (!fenced && line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function parseBlock(block) {
  const trimmed = block.trim();
  const lines = trimmed.split("\n");
  const firstLine = lines[0] ?? "";

  if (/^<a id="page-\d+"><\/a>$/.test(trimmed)) {
    return { type: "page_anchor", id: trimmed.match(/id="([^"]+)"/)?.[1] ?? "" };
  }

  const heading = firstLine.match(/^(#{1,6})\s+(.+)$/);
  if (heading && lines.length === 1) {
    return {
      type: "heading",
      depth: heading[1].length,
      text: normalizeInlineText(heading[2])
    };
  }

  const image = firstLine.match(/^!\[([^\]\n]*)\]\(([^)\n]+)\)$/);
  if (image && lines.length === 1) {
    return {
      type: "image",
      alt: normalizeInlineText(image[1]),
      target: normalizeMarkdownTarget(image[2])
    };
  }

  if (isGfmTable(lines)) {
    return parseGfmTable(lines);
  }

  if (isRawHtmlTableBlock(trimmed)) {
    return {
      type: "table",
      format: "html",
      html: normalizeHtmlTable(trimmed)
    };
  }

  if (lines.every((line) => /^-\s+/.test(line))) {
    return {
      type: "list",
      ordered: false,
      items: lines.map((line) => normalizeInlineText(line.replace(/^-\s+/, "")))
    };
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return {
      type: "list",
      ordered: true,
      items: lines.map((line) => normalizeInlineText(line.replace(/^\d+\.\s+/, "")))
    };
  }

  if (/^```[\s\S]*```$/.test(trimmed)) {
    const codeLines = lines.slice(1, -1);
    return {
      type: "code",
      fence: "```",
      info: firstLine.replace(/^```/, "").trim(),
      text: codeLines.join("\n")
    };
  }

  if (/^\$\$[\s\S]*\$\$$/.test(trimmed)) {
    return {
      type: "equation",
      text: lines.slice(1, -1).join("\n").trim()
    };
  }

  if (/^<[^>]+>[\s\S]*<\/[^>]+>$/.test(trimmed)) {
    return {
      type: "html",
      html: trimmed.replace(/\s+/g, " ")
    };
  }

  return {
    type: "paragraph",
    text: normalizeInlineText(lines.join(" "))
  };
}

function isGfmTable(lines) {
  return (
    lines.length >= 2 &&
    lines.every((line) => line.trim().startsWith("|") && line.trim().endsWith("|")) &&
    /^\|\s*:?-{3,}:?/.test(lines[1])
  );
}

function parseGfmTable(lines) {
  return {
    type: "table",
    format: "gfm",
    header: splitTableRow(lines[0]),
    alignments: splitTableRow(lines[1]).map(parseTableAlignment),
    rows: lines.slice(2).map(splitTableRow)
  };
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => normalizeInlineText(cell.replace(/\\\|/g, "|")));
}

function parseTableAlignment(cell) {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) {
    return "center";
  }
  if (trimmed.endsWith(":")) {
    return "right";
  }
  if (trimmed.startsWith(":")) {
    return "left";
  }
  return "default";
}

function isRawHtmlTableBlock(block) {
  return /^<table(?:\s[^>]*)?>[\s\S]*<\/table>$/.test(block);
}

function normalizeHtmlTable(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeInlineText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMarkdownTarget(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

function findAstDifferences(expected, actual, astPath = "$", differences = []) {
  if (differences.length >= 20) {
    return differences;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      differences.push({ path: astPath, expected, actual });
      return differences;
    }
    if (expected.length !== actual.length) {
      differences.push({ path: `${astPath}.length`, expected: expected.length, actual: actual.length });
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      findAstDifferences(expected[index], actual[index], `${astPath}[${index}]`, differences);
    }
    return differences;
  }

  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      differences.push({ path: astPath, expected, actual });
      return differences;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (!(key in expected) || !(key in actual)) {
        differences.push({
          path: `${astPath}.${key}`,
          expected: expected[key],
          actual: actual[key]
        });
        continue;
      }
      findAstDifferences(expected[key], actual[key], `${astPath}.${key}`, differences);
    }
    return differences;
  }

  if (expected !== actual) {
    differences.push({ path: astPath, expected, actual });
  }
  return differences;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function readOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function usage() {
  return `Usage:
  node scripts/qa/check-markdown-ast.mjs [--id <manifest-id>] [--report <path>]

Options:
  --root <path>              Repository root. Defaults to cwd.
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
`;
}

async function loadOcrResults(repoRoot, entry) {
  if (!entry.ocrResultsFile) {
    return null;
  }
  const payload = JSON.parse(await readFile(path.join(repoRoot, entry.ocrResultsFile), "utf8"));
  return Array.isArray(payload) ? payload : payload.results;
}

async function runCase(repoRoot, manifestEntries, id) {
  const entry = manifestEntries.get(id);
  if (!entry) {
    throw new Error(`unknown manifest id "${id}"`);
  }
  const expectedPath = path.join(repoRoot, "corpus", "expected", `${id}.md`);
  const expectedMarkdown = await readFile(expectedPath, "utf8");
  const ocrResults = await loadOcrResults(repoRoot, entry);
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: ocrResults ? { results: ocrResults } : { enabled: false }
  });
  return {
    id,
    path: entry.path,
    expectedPath: path.relative(repoRoot, expectedPath),
    ...compareMarkdownAst(expectedMarkdown, result.markdown)
  };
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  const firstDifference = result.differences[0];
  const suffix = firstDifference ? ` firstDifference=${firstDifference.path}` : "";
  console.log(
    `${prefix} ${result.id} expectedBlocks=${result.expectedBlocks} actualBlocks=${result.actualBlocks}${suffix}`
  );
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const manifestPath = path.resolve(
    readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
  );
  const selectedIds = readOptions("--id");
  const caseIds = selectedIds.length > 0 ? selectedIds : defaultCaseIds;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestEntries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const results = [];
  for (const id of caseIds) {
    const result = await runCase(repoRoot, manifestEntries, id);
    results.push(result);
    printResult(result);
  }

  const report = createMarkdownAstDiffReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Markdown AST diff check failed.");
  }
  console.log(`Markdown AST diff passed: ${results.length} case(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
