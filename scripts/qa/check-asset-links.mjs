import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

const defaultCaseIds = Object.freeze([
  "synthetic-vector-figure",
  "synthetic-visible-table",
  "synthetic-complex-spanned-table",
  "synthetic-scanned-text"
]);

export function extractMarkdownAssetLinks(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return [];
  }

  const links = [];
  const inlineLinkPattern = /(!)?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of markdown.matchAll(inlineLinkPattern)) {
    const target = normalizeMarkdownLinkTarget(match[2]);
    if (target.startsWith("assets/")) {
      links.push({
        type: match[1] ? "image" : "link",
        target,
        raw: match[0]
      });
    }
  }
  return links;
}

export function normalizeMarkdownLinkTarget(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

export function validateAssetPath(value) {
  const failures = [];
  if (typeof value !== "string" || value.length === 0) {
    return ["missing-path"];
  }
  if (!value.startsWith("assets/")) {
    failures.push("outside-assets-root");
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    failures.push("absolute-path");
  }
  if (value.includes("\\")) {
    failures.push("backslash");
  }
  if (/[\0-\x1F\x7F]/.test(value)) {
    failures.push("control-character");
  }
  if (/[?#]/.test(value)) {
    failures.push("query-or-fragment");
  }

  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    failures.push("unsafe-segment");
  }
  return failures;
}

export function evaluateAssetLinkValidity(markdown, assets) {
  const normalizedAssets = Array.isArray(assets) ? assets : [];
  const links = extractMarkdownAssetLinks(markdown);
  const assetPaths = normalizedAssets.map((asset) => asset?.path).filter((value) => typeof value === "string");
  const assetPathSet = new Set(assetPaths);
  const duplicateAssetIds = findDuplicates(
    normalizedAssets.map((asset) => asset?.id).filter((value) => typeof value === "string" && value.length > 0)
  );
  const duplicateAssetPaths = findDuplicates(assetPaths);
  const invalidAssets = normalizedAssets.flatMap((asset, index) => {
    const failures = [];
    if (typeof asset?.id !== "string" || asset.id.length === 0) {
      failures.push("missing-id");
    }
    if (typeof asset?.mediaType !== "string" || asset.mediaType.length === 0) {
      failures.push("missing-media-type");
    }
    failures.push(...validateAssetPath(asset?.path));
    return failures.length === 0
      ? []
      : [
          {
            index,
            id: typeof asset?.id === "string" ? asset.id : null,
            path: typeof asset?.path === "string" ? asset.path : null,
            failures
          }
        ];
  });
  const invalidMarkdownTargets = links.flatMap((link) => {
    const failures = validateAssetPath(link.target);
    return failures.length === 0 ? [] : [{ ...link, failures }];
  });
  const missingLinkedAssets = links.filter((link) => !assetPathSet.has(link.target));
  const resolvedLinkedAssets = links.length - missingLinkedAssets.length;

  return {
    assets: normalizedAssets.length,
    links: links.length,
    validAssetPaths: normalizedAssets.length - invalidAssets.length,
    resolvedLinkedAssets,
    assetPathValidity:
      normalizedAssets.length === 0
        ? 1
        : (normalizedAssets.length - invalidAssets.length) / normalizedAssets.length,
    linkResolution: links.length === 0 ? 1 : resolvedLinkedAssets / links.length,
    duplicateAssetIds,
    duplicateAssetPaths,
    invalidAssets,
    invalidMarkdownTargets,
    missingLinkedAssets,
    passed:
      invalidAssets.length === 0 &&
      invalidMarkdownTargets.length === 0 &&
      missingLinkedAssets.length === 0 &&
      duplicateAssetIds.length === 0 &&
      duplicateAssetPaths.length === 0
  };
}

export function createAssetLinkValidityReport(results) {
  const assetCount = results.reduce((sum, result) => sum + result.assets, 0);
  const linkCount = results.reduce((sum, result) => sum + result.links, 0);
  const validAssetPaths = results.reduce((sum, result) => sum + result.validAssetPaths, 0);
  const resolvedLinkedAssets = results.reduce((sum, result) => sum + result.resolvedLinkedAssets, 0);
  return {
    generatedAt: new Date().toISOString(),
    caseCount: results.length,
    passed: results.every((result) => result.passed),
    assetPathValidity: assetCount === 0 ? 1 : validAssetPaths / assetCount,
    linkResolution: linkCount === 0 ? 1 : resolvedLinkedAssets / linkCount,
    results
  };
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates].sort();
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
  node scripts/qa/check-asset-links.mjs [--id <manifest-id>] [--report <path>]

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
  const ocrResults = await loadOcrResults(repoRoot, entry);
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: ocrResults ? { results: ocrResults } : { enabled: false }
  });
  return {
    id,
    path: entry.path,
    ...evaluateAssetLinkValidity(result.markdown, result.assets)
  };
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} assets=${result.assets} links=${result.links} ` +
      `assetPathValidity=${formatNumber(result.assetPathValidity)} ` +
      `linkResolution=${formatNumber(result.linkResolution)}`
  );
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
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

  const report = createAssetLinkValidityReport(results);
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (!report.passed) {
    throw new Error("Asset link validity check failed.");
  }
  console.log(
    `Asset link validity passed: ${results.length} case(s), ` +
      `assetPathValidity=${formatNumber(report.assetPathValidity)}, ` +
      `linkResolution=${formatNumber(report.linkResolution)}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
