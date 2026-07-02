import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

export function tokenizeComparableText(value) {
  return Array.from(value.normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu), (match) =>
    match[0]
  );
}

export function markdownToComparableText(markdown) {
  return markdown
    .replace(/^<a id="page-\d+"><\/a>\s*$/gm, " ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/^\s*[-*]\s+/gm, " ")
    .replace(/^\s*\d+[.)]\s+/gm, " ")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1")
    .replace(/[|`*_#>\-[\]]/g, " ")
    .replace(/\f/g, " ");
}

export function compareTextCoverage(oracleText, actualMarkdown) {
  const oracleTokens = tokenizeComparableText(oracleText);
  const actualTokens = tokenizeComparableText(markdownToComparableText(actualMarkdown));
  const actualCounts = new Map();
  for (const token of actualTokens) {
    actualCounts.set(token, (actualCounts.get(token) ?? 0) + 1);
  }

  let matchedTokens = 0;
  for (const token of oracleTokens) {
    const remaining = actualCounts.get(token) ?? 0;
    if (remaining > 0) {
      matchedTokens += 1;
      actualCounts.set(token, remaining - 1);
    }
  }

  return {
    coverage: oracleTokens.length === 0 ? 1 : matchedTokens / oracleTokens.length,
    matchedTokens,
    oracleTokens: oracleTokens.length,
    actualTokens: actualTokens.length
  };
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
  node scripts/qa/compare-oracles.mjs --all [--dry-run] [--report <path>]
  node scripts/qa/compare-oracles.mjs --gate <gate> [--dry-run] [--report <path>]
  node scripts/qa/compare-oracles.mjs --id <manifest-id> [--dry-run] [--report <path>]

Options:
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
  --root <path>              Repository root. Defaults to cwd.
  --min-coverage <number>    Override acceptance metrics.minTextCoverage.
`;
}

function readTopLevelScalars(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s/.test(line)) {
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], normalizeScalar(match[2] ?? ""));
    }
  }
  return values;
}

function readNamedBlockScalars(text, blockName) {
  const values = new Map();
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      inBlock = line.trim() === `${blockName}:`;
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], normalizeScalar(match[2] ?? ""));
    }
  }
  return values;
}

function normalizeScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadAcceptance(repoRoot, entry) {
  const text = await readFile(path.join(repoRoot, entry.acceptanceFile), "utf8");
  const scalars = readTopLevelScalars(text);
  const metrics = readNamedBlockScalars(text, "metrics");
  return {
    id: scalars.get("id"),
    gate: scalars.get("gate"),
    expectedMode: scalars.get("expectedMode"),
    gating: scalars.get("gating") === "true",
    skipReason: scalars.get("skipReason") ?? "",
    minTextCoverage: readNumber(metrics.get("minTextCoverage"), 1)
  };
}

async function loadCases(repoRoot, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const cases = [];
  for (const entry of manifest.entries) {
    cases.push({
      entry,
      acceptance: await loadAcceptance(repoRoot, entry)
    });
  }
  return cases;
}

function selectCases(cases, { selectedIds, selectedGate }) {
  const idSet = new Set(selectedIds);
  const selected = [];
  const skipped = [];

  for (const corpusCase of cases) {
    let reason = null;
    if (idSet.size > 0 && !idSet.has(corpusCase.entry.id)) {
      reason = "id-filter: not requested by --id";
    }
    if (!reason && isLocalOnlyEntry(corpusCase.entry)) {
      reason = formatAcceptanceSkip(corpusCase, "local-only");
    }
    if (!reason && !corpusCase.acceptance.gating) {
      reason = formatAcceptanceSkip(corpusCase, "non-gating");
    }
    if (!reason && corpusCase.acceptance.expectedMode === "unsupported") {
      reason = formatAcceptanceSkip(corpusCase, "unsupported");
    }
    if (!reason && selectedGate && corpusCase.acceptance.gate !== selectedGate) {
      reason =
        `gate-filter: acceptance gate ${corpusCase.acceptance.gate} does not match selected gate ${selectedGate}`;
    }

    if (reason) {
      skipped.push({ ...corpusCase, reason });
    } else {
      selected.push(corpusCase);
    }
  }

  for (const id of idSet) {
    if (!cases.some((corpusCase) => corpusCase.entry.id === id)) {
      throw new Error(`unknown manifest id "${id}"`);
    }
  }

  return { selected, skipped };
}

function isLocalOnlyEntry(entry) {
  return (
    entry.redistributable === false ||
    entry.source?.type === "local-only" ||
    /(^|\/)local-only(\/|$)/.test(entry.path)
  );
}

function formatAcceptanceSkip(corpusCase, code) {
  const detail = corpusCase.acceptance.skipReason || "missing acceptance skipReason";
  return `${code}: ${detail}`;
}

async function compareCase(repoRoot, corpusCase, thresholdOverride) {
  const { entry, acceptance } = corpusCase;
  const oraclePath = path.join(repoRoot, "corpus", "baselines", entry.id, "oracles", "pdftotext.txt");
  const oracleText = await readFile(oraclePath, "utf8");
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: { enabled: false }
  });
  const comparison = compareTextCoverage(oracleText, result.markdown);
  const minTextCoverage = thresholdOverride ?? acceptance.minTextCoverage;
  return {
    id: entry.id,
    gate: acceptance.gate,
    oraclePath: path.relative(repoRoot, oraclePath),
    minTextCoverage,
    ...comparison,
    passed: comparison.coverage + Number.EPSILON >= minTextCoverage
  };
}

function printCase(prefix, corpusCase) {
  const { entry, acceptance } = corpusCase;
  console.log(
    `${prefix} ${entry.id} gate=${acceptance.gate} minTextCoverage=${formatNumber(
      acceptance.minTextCoverage
    )} path=${entry.path}`
  );
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} textCoverage=${formatNumber(result.coverage)} min=${formatNumber(
      result.minTextCoverage
    )} matched=${result.matchedTokens}/${result.oracleTokens} actualTokens=${result.actualTokens}`
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

  const selectAll = hasFlag("--all");
  const selectedIds = readOptions("--id");
  const selectedGate = readOption("--gate");
  if (!selectAll && !selectedGate && selectedIds.length === 0) {
    console.error(usage());
    process.exit(1);
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const manifestPath = path.resolve(
    readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
  );
  const thresholdOverride = readOption("--min-coverage")
    ? readNumber(readOption("--min-coverage"), Number.NaN)
    : undefined;
  if (thresholdOverride !== undefined && !Number.isFinite(thresholdOverride)) {
    throw new Error("--min-coverage must be a number");
  }

  const cases = await loadCases(repoRoot, manifestPath);
  const { selected, skipped } = selectCases(cases, { selectedIds, selectedGate });

  if (hasFlag("--dry-run")) {
    for (const corpusCase of selected) {
      printCase("SELECT", corpusCase);
    }
    for (const corpusCase of skipped) {
      console.log(`SKIP ${corpusCase.entry.id} reason=${corpusCase.reason}`);
    }
    console.log(`Selected ${selected.length}; skipped ${skipped.length}.`);
    return;
  }

  const results = [];
  for (const corpusCase of selected) {
    const result = await compareCase(repoRoot, corpusCase, thresholdOverride);
    results.push(result);
    printResult(result);
  }

  const reportPath = readOption("--report");
  if (reportPath) {
    await writeFile(path.resolve(reportPath), `${JSON.stringify({ results }, null, 2)}\n`);
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    throw new Error(`Oracle comparison failed for ${failed.length} case(s).`);
  }

  console.log(`Oracle comparison passed: ${results.length}; skipped ${skipped.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
