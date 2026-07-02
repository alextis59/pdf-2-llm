import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const args = process.argv.slice(2);

export function compareTaggedStructure(extraction, acceptance) {
  const structure = extraction?.structure ?? {};
  const markedContent = Number.isFinite(structure.markedContent) ? structure.markedContent : 0;
  const taggedStructureConflicts = Number.isFinite(extraction?.taggedStructureConflicts)
    ? extraction.taggedStructureConflicts
    : 0;
  const minTaggedMarkedContent = acceptance.minTaggedMarkedContent;
  const maxTaggedStructureConflicts = acceptance.maxTaggedStructureConflicts;
  const requiresTagged = Number.isFinite(minTaggedMarkedContent);
  const passedTagged = !requiresTagged || structure.tagged === true;
  const passedMarkedContent =
    !Number.isFinite(minTaggedMarkedContent) || markedContent >= minTaggedMarkedContent;
  const passedConflicts =
    !Number.isFinite(maxTaggedStructureConflicts) ||
    taggedStructureConflicts <= maxTaggedStructureConflicts;

  return {
    tagged: structure.tagged === true,
    markedContent,
    minTaggedMarkedContent,
    taggedStructureConflicts,
    maxTaggedStructureConflicts,
    roles: structure.roles ?? {},
    passedTagged,
    passedMarkedContent,
    passedConflicts,
    passed: passedTagged && passedMarkedContent && passedConflicts
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
  node scripts/qa/compare-tagged-structure.mjs --all [--dry-run] [--report <path>]
  node scripts/qa/compare-tagged-structure.mjs --gate <gate> [--dry-run] [--report <path>]
  node scripts/qa/compare-tagged-structure.mjs --id <manifest-id> [--dry-run] [--report <path>]
  node scripts/qa/compare-tagged-structure.mjs --tagged-structure-gated [--dry-run] [--report <path>]

Options:
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
  --root <path>              Repository root. Defaults to cwd.
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
    minTaggedMarkedContent: readNumber(metrics.get("minTaggedMarkedContent"), null),
    maxTaggedStructureConflicts: readNumber(metrics.get("maxTaggedStructureConflicts"), null)
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

function selectCases(cases, { selectedIds, selectedGate, taggedStructureGated = false }) {
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
    if (!reason && taggedStructureGated && !hasTaggedStructureMetrics(corpusCase.acceptance)) {
      reason = "tagged-structure-filter: no tagged structure thresholds";
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

function hasTaggedStructureMetrics(acceptance) {
  return (
    Number.isFinite(acceptance.minTaggedMarkedContent) ||
    Number.isFinite(acceptance.maxTaggedStructureConflicts)
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

async function compareCase(repoRoot, corpusCase) {
  const result = await convertPdfToMarkdown(path.join(repoRoot, corpusCase.entry.path), {
    ocr: { enabled: false }
  });
  return {
    id: corpusCase.entry.id,
    gate: corpusCase.acceptance.gate,
    ...compareTaggedStructure(result.diagnostics.extraction, corpusCase.acceptance)
  };
}

function printCase(prefix, corpusCase) {
  const { entry, acceptance } = corpusCase;
  console.log(`${prefix} ${entry.id} gate=${acceptance.gate} path=${entry.path}`);
}

function printResult(result) {
  const prefix = result.passed ? "PASS" : "FAIL";
  console.log(
    `${prefix} ${result.id} tagged=${result.tagged} markedContent=${result.markedContent} minTaggedMarkedContent=${formatNumber(
      result.minTaggedMarkedContent
    )} taggedStructureConflicts=${result.taggedStructureConflicts} maxTaggedStructureConflicts=${formatNumber(
      result.maxTaggedStructureConflicts
    )}`
  );
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "none";
  }
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const selectAll = hasFlag("--all");
  const taggedStructureGated = hasFlag("--tagged-structure-gated");
  const selectedIds = readOptions("--id");
  const selectedGate = readOption("--gate");
  if (!selectAll && !selectedGate && selectedIds.length === 0 && !taggedStructureGated) {
    console.error(usage());
    process.exit(1);
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const manifestPath = path.resolve(
    readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
  );

  const cases = await loadCases(repoRoot, manifestPath);
  const { selected, skipped } = selectCases(cases, {
    selectedIds,
    selectedGate,
    taggedStructureGated
  });

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
    const result = await compareCase(repoRoot, corpusCase);
    results.push(result);
    printResult(result);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    results
  };
  const reportPath = readOption("--report");
  if (reportPath) {
    await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    process.exit(1);
  }

  console.log(`Tagged-structure comparison passed: ${results.length}; skipped ${skipped.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
