import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

export function countPhraseOccurrences(text, phrase) {
  if (!phrase) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(phrase, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + phrase.length;
  }
  return count;
}

export function compareRunningContent(oracleText, actualMarkdown, labels) {
  const expectedRemoved = labels.expectedRemoved ?? [];
  const expectedRetained = labels.expectedRetained ?? [];
  const removed = expectedRemoved.map((phrase) => {
    const oracleOccurrences = countPhraseOccurrences(oracleText, phrase);
    const actualOccurrences = countPhraseOccurrences(actualMarkdown, phrase);
    return {
      phrase,
      oracleOccurrences,
      actualOccurrences,
      passed: oracleOccurrences > 0 && actualOccurrences < oracleOccurrences
    };
  });
  const retained = expectedRetained.map((phrase) => {
    const oracleOccurrences = countPhraseOccurrences(oracleText, phrase);
    const actualOccurrences = countPhraseOccurrences(actualMarkdown, phrase);
    return {
      phrase,
      oracleOccurrences,
      actualOccurrences,
      passed: oracleOccurrences > 0 && actualOccurrences > 0
    };
  });

  const truePositives = removed.filter((label) => label.passed).length;
  const falseNegatives = removed.length - truePositives;
  const trueNegatives = retained.filter((label) => label.passed).length;
  const falsePositives = retained.length - trueNegatives;
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;

  return {
    precision: precisionDenominator === 0 ? 1 : truePositives / precisionDenominator,
    recall: recallDenominator === 0 ? 1 : truePositives / recallDenominator,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    removed,
    retained
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
  node scripts/qa/compare-running-content.mjs --all [--dry-run] [--report <path>]
  node scripts/qa/compare-running-content.mjs --gate <gate> [--dry-run] [--report <path>]
  node scripts/qa/compare-running-content.mjs --id <manifest-id> [--dry-run] [--report <path>]

Options:
  --manifest <path>      Manifest path. Defaults to corpus/manifest.json.
  --root <path>          Repository root. Defaults to cwd.
  --min-precision <n>    Override metrics.minRunningContentPrecision.
  --min-recall <n>       Override metrics.minRunningContentRecall.
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

function readNamedStringLists(text, blockName) {
  const values = new Map();
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let currentList = null;

  for (const line of lines) {
    if (!inBlock) {
      inBlock = line.trim() === `${blockName}:`;
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }

    const listMatch = line.match(/^\s{2}([A-Za-z][A-Za-z0-9]*):(?:\s*(\[\])\s*)?$/);
    if (listMatch) {
      currentList = listMatch[1];
      values.set(currentList, []);
      if (listMatch[2]) {
        currentList = null;
      }
      continue;
    }

    const itemMatch = line.match(/^\s{4}-\s+(.*)$/);
    if (itemMatch && currentList) {
      values.get(currentList).push(normalizeScalar(itemMatch[1]));
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
  const runningContent = readNamedStringLists(text, "runningContent");
  return {
    id: scalars.get("id"),
    gate: scalars.get("gate"),
    expectedMode: scalars.get("expectedMode"),
    gating: scalars.get("gating") === "true",
    skipReason: scalars.get("skipReason") ?? "",
    minRunningContentPrecision: readNumber(metrics.get("minRunningContentPrecision"), 1),
    minRunningContentRecall: readNumber(metrics.get("minRunningContentRecall"), 1),
    runningContent: {
      expectedRemoved: runningContent.get("expectedRemoved") ?? [],
      expectedRetained: runningContent.get("expectedRetained") ?? []
    }
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
    if (!reason && !hasRunningContentLabels(corpusCase.acceptance)) {
      reason = "running-content-filter: acceptance file has no runningContent labels";
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

function hasRunningContentLabels(acceptance) {
  return (
    acceptance.runningContent.expectedRemoved.length > 0 ||
    acceptance.runningContent.expectedRetained.length > 0
  );
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

async function compareCase(repoRoot, corpusCase, overrides) {
  const { entry, acceptance } = corpusCase;
  const oraclePath = path.join(repoRoot, "corpus", "baselines", entry.id, "oracles", "pdftotext.txt");
  const oracleText = await readFile(oraclePath, "utf8");
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: { enabled: false }
  });
  const comparison = compareRunningContent(
    oracleText,
    result.markdown,
    acceptance.runningContent
  );
  const minPrecision = overrides.minPrecision ?? acceptance.minRunningContentPrecision;
  const minRecall = overrides.minRecall ?? acceptance.minRunningContentRecall;
  return {
    id: entry.id,
    gate: acceptance.gate,
    oraclePath: path.relative(repoRoot, oraclePath),
    minPrecision,
    minRecall,
    ...comparison,
    passed:
      comparison.precision + Number.EPSILON >= minPrecision &&
      comparison.recall + Number.EPSILON >= minRecall
  };
}

function printCase(prefix, corpusCase) {
  const { entry, acceptance } = corpusCase;
  console.log(
    `${prefix} ${entry.id} gate=${acceptance.gate} minPrecision=${formatNumber(
      acceptance.minRunningContentPrecision
    )} minRecall=${formatNumber(acceptance.minRunningContentRecall)} labels=${
      acceptance.runningContent.expectedRemoved.length
    }/${acceptance.runningContent.expectedRetained.length} path=${entry.path}`
  );
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  const removedPassed = result.removed.filter((label) => label.passed).length;
  const retainedPassed = result.retained.filter((label) => label.passed).length;
  console.log(
    `${prefix} ${result.id} runningContentPrecision=${formatNumber(
      result.precision
    )} min=${formatNumber(result.minPrecision)} runningContentRecall=${formatNumber(
      result.recall
    )} min=${formatNumber(result.minRecall)} removed=${removedPassed}/${
      result.removed.length
    } retained=${retainedPassed}/${result.retained.length}`
  );
}

function formatNumber(value) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
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
  const minPrecision = readOption("--min-precision")
    ? readNumber(readOption("--min-precision"), Number.NaN)
    : undefined;
  const minRecall = readOption("--min-recall")
    ? readNumber(readOption("--min-recall"), Number.NaN)
    : undefined;
  if (minPrecision !== undefined && !Number.isFinite(minPrecision)) {
    throw new Error("--min-precision must be a number");
  }
  if (minRecall !== undefined && !Number.isFinite(minRecall)) {
    throw new Error("--min-recall must be a number");
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

  if (selected.length === 0) {
    throw new Error("No running-content-labelled corpus cases selected.");
  }

  const results = [];
  for (const corpusCase of selected) {
    const result = await compareCase(repoRoot, corpusCase, { minPrecision, minRecall });
    results.push(result);
    printResult(result);
  }

  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify({ results }, null, 2)}\n`);
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    throw new Error(`Running-content comparison failed for ${failed.length} case(s).`);
  }

  console.log(
    `Running-content comparison passed: ${results.length}; skipped ${skipped.length}.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
