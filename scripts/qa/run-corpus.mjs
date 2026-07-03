import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";
import { compareOcrAccuracy } from "./ocr-accuracy.mjs";
import { compareTableCellAdjacency } from "./table-adjacency.mjs";
import { compareTableCsvCellTextAccuracy } from "./table-csv-accuracy.mjs";
import { compareTableSpanAccuracy } from "./table-span-accuracy.mjs";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const manifestPath = path.resolve(
  readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
);
const listOnly = hasFlag("--list");
const dryRun = hasFlag("--dry-run");
const updateSnapshots = hasFlag("--update-snapshots");
const assertMarkdown = hasFlag("--assert-markdown");
const selectedGate = readOption("--gate");
const selectedIds = readOptions("--id");

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
  node scripts/qa/run-corpus.mjs --list [--gate <gate>]
  node scripts/qa/run-corpus.mjs --id <manifest-id> [--dry-run]
  node scripts/qa/run-corpus.mjs --gate <gate> [--dry-run]
  node scripts/qa/run-corpus.mjs --all [--dry-run]

Options:
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
  --root <path>              Repository root. Defaults to cwd.
  --assert-markdown          Compare output with corpus/expected/<id>.md.
  --update-snapshots         Reserved for future Markdown/IR snapshot updates.
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

function readStructureForms(text) {
  const forms = [];
  let inStructure = false;
  let inForms = false;
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (!inStructure) {
      inStructure = line.trim() === "structure:";
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    if (!inForms) {
      const formsMatch = line.match(/^  forms:(?:\s*(\[\])\s*)?$/);
      if (formsMatch) {
        inForms = !formsMatch[1];
      }
      continue;
    }

    const itemMatch = line.match(/^    -\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (itemMatch) {
      current = {
        [itemMatch[1]]: readAcceptanceValue(itemMatch[2])
      };
      forms.push(current);
      continue;
    }

    const propertyMatch = line.match(/^      ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (propertyMatch && current) {
      current[propertyMatch[1]] = readAcceptanceValue(propertyMatch[2]);
    }
  }

  return forms;
}

function readAcceptanceValue(value) {
  const normalized = normalizeScalar(value ?? "");
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return normalized;
}

function readNumber(value, fallback = null) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadAcceptance(entry) {
  const text = await readFile(path.join(repoRoot, entry.acceptanceFile), "utf8");
  const scalars = readTopLevelScalars(text);
  const metrics = readNamedBlockScalars(text, "metrics");
  return {
    id: scalars.get("id"),
    gate: scalars.get("gate"),
    sourceType: scalars.get("sourceType"),
    expectedMode: scalars.get("expectedMode"),
    gating: scalars.get("gating") === "true",
    maxOcrCharacterErrorRate: readNumber(metrics.get("maxOcrCharacterErrorRate")),
    maxOcrWordErrorRate: readNumber(metrics.get("maxOcrWordErrorRate")),
    minTableCellAdjacency: readNumber(metrics.get("minTableCellAdjacency")),
    minTableCsvCellTextAccuracy: readNumber(metrics.get("minTableCsvCellTextAccuracy")),
    minTableSpanAccuracy: readNumber(metrics.get("minTableSpanAccuracy")),
    forms: readStructureForms(text),
    skipReason: scalars.get("skipReason") ?? ""
  };
}

async function loadCases() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const cases = [];
  for (const entry of manifest.entries) {
    cases.push({
      entry,
      acceptance: await loadAcceptance(entry)
    });
  }
  return cases;
}

function selectCases(cases) {
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

function printCase(prefix, corpusCase) {
  const { entry, acceptance } = corpusCase;
  console.log(
    `${prefix} ${entry.id} gate=${acceptance.gate} gating=${acceptance.gating} kind=${entry.kind} path=${entry.path}`
  );
}

async function runCase(corpusCase) {
  const { entry, acceptance } = corpusCase;
  const ocrResults = entry.ocrResultsFile ? await readOcrResults(entry) : null;
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: ocrResults ? { results: ocrResults } : { enabled: false }
  });
  const errors = [];
  const details = [];
  let expected = null;

  if (result.diagnostics.input.sha256 !== entry.sha256) {
    errors.push(`sha256 mismatch: expected ${entry.sha256}, got ${result.diagnostics.input.sha256}`);
  }

  if (result.diagnostics.input.bytes !== entry.bytes) {
    errors.push(`byte mismatch: expected ${entry.bytes}, got ${result.diagnostics.input.bytes}`);
  }

  if (result.diagnostics.input.pdfVersion !== entry.pdfVersion) {
    errors.push(
      `PDF version mismatch: expected ${entry.pdfVersion}, got ${result.diagnostics.input.pdfVersion}`
    );
  }

  if (
    assertMarkdown ||
    acceptance.maxOcrCharacterErrorRate !== null ||
    acceptance.maxOcrWordErrorRate !== null ||
    acceptance.minTableCellAdjacency !== null ||
    acceptance.minTableCsvCellTextAccuracy !== null ||
    acceptance.minTableSpanAccuracy !== null
  ) {
    expected = await readExpectedMarkdown(entry);
  }

  if (assertMarkdown) {
    if (result.markdown !== expected) {
      errors.push(`Markdown snapshot mismatch against corpus/expected/${entry.id}.md`);
    } else {
      details.push("markdown=match");
    }
  }

  if (acceptance.maxOcrCharacterErrorRate !== null || acceptance.maxOcrWordErrorRate !== null) {
    const ocrAccuracy = compareOcrAccuracy(expected, result.markdown);
    if (
      acceptance.maxOcrCharacterErrorRate !== null &&
      ocrAccuracy.characterErrorRate - Number.EPSILON > acceptance.maxOcrCharacterErrorRate
    ) {
      errors.push(
        `OCR character error rate ${formatNumber(ocrAccuracy.characterErrorRate)} above ${formatNumber(
          acceptance.maxOcrCharacterErrorRate
        )} (${ocrAccuracy.characterEdits}/${ocrAccuracy.expectedCharacters} expected characters edited)`
      );
    }
    if (
      acceptance.maxOcrWordErrorRate !== null &&
      ocrAccuracy.wordErrorRate - Number.EPSILON > acceptance.maxOcrWordErrorRate
    ) {
      errors.push(
        `OCR word error rate ${formatNumber(ocrAccuracy.wordErrorRate)} above ${formatNumber(
          acceptance.maxOcrWordErrorRate
        )} (${ocrAccuracy.wordEdits}/${ocrAccuracy.expectedWords} expected words edited)`
      );
    }
    details.push(
      `ocrCER=${formatNumber(ocrAccuracy.characterErrorRate)} max=${formatNumber(
        acceptance.maxOcrCharacterErrorRate
      )} edits=${ocrAccuracy.characterEdits}/${ocrAccuracy.expectedCharacters}`
    );
    details.push(
      `ocrWER=${formatNumber(ocrAccuracy.wordErrorRate)} max=${formatNumber(
        acceptance.maxOcrWordErrorRate
      )} edits=${ocrAccuracy.wordEdits}/${ocrAccuracy.expectedWords}`
    );
  }

  if (acceptance.minTableCellAdjacency !== null) {
    const adjacency = compareTableCellAdjacency(expected, result.markdown);
    if (adjacency.score + Number.EPSILON < acceptance.minTableCellAdjacency) {
      errors.push(
        `table cell adjacency ${formatNumber(adjacency.score)} below ${formatNumber(
          acceptance.minTableCellAdjacency
        )} (${adjacency.matchedPairs}/${adjacency.expectedPairs} expected pairs matched)`
      );
    }
    details.push(
      `tableCellAdjacency=${formatNumber(adjacency.score)} min=${formatNumber(
        acceptance.minTableCellAdjacency
      )} matched=${adjacency.matchedPairs}/${adjacency.expectedPairs}`
    );
  }

  if (acceptance.minTableSpanAccuracy !== null) {
    const spanAccuracy = compareTableSpanAccuracy(expected, result.markdown);
    if (spanAccuracy.score + Number.EPSILON < acceptance.minTableSpanAccuracy) {
      errors.push(
        `table span accuracy ${formatNumber(spanAccuracy.score)} below ${formatNumber(
          acceptance.minTableSpanAccuracy
        )} (${spanAccuracy.matchedCells}/${spanAccuracy.expectedCells} expected cells matched)`
      );
    }
    details.push(
      `tableSpanAccuracy=${formatNumber(spanAccuracy.score)} min=${formatNumber(
        acceptance.minTableSpanAccuracy
      )} matched=${spanAccuracy.matchedCells}/${spanAccuracy.expectedCells}`
    );
  }

  if (acceptance.minTableCsvCellTextAccuracy !== null) {
    const csvAccuracy = compareTableCsvCellTextAccuracy(expected, result.assets);
    if (csvAccuracy.score + Number.EPSILON < acceptance.minTableCsvCellTextAccuracy) {
      errors.push(
        `table CSV cell text accuracy ${formatNumber(csvAccuracy.score)} below ${formatNumber(
          acceptance.minTableCsvCellTextAccuracy
        )} (${csvAccuracy.matchedCells}/${csvAccuracy.expectedCells} expected cells matched)`
      );
    }
    details.push(
      `tableCsvCellTextAccuracy=${formatNumber(csvAccuracy.score)} min=${formatNumber(
        acceptance.minTableCsvCellTextAccuracy
      )} matched=${csvAccuracy.matchedCells}/${csvAccuracy.expectedCells}`
    );
  }

  if (acceptance.forms.length > 0) {
    const fieldsByName = new Map(
      result.diagnostics.extraction.forms.fields.map((field) => [field.name, field])
    );
    let matchedForms = 0;
    for (const expectedForm of acceptance.forms) {
      const actual = fieldsByName.get(expectedForm.name);
      if (!actual) {
        errors.push(`missing form field ${expectedForm.name}`);
        continue;
      }
      let matched = true;
      for (const [key, expectedValue] of Object.entries(expectedForm)) {
        if (actual[key] !== expectedValue) {
          errors.push(
            `form field ${expectedForm.name}.${key} expected ${JSON.stringify(
              expectedValue
            )}, got ${JSON.stringify(actual[key])}`
          );
          matched = false;
        }
      }
      if (matched) {
        matchedForms += 1;
      }
    }
    details.push(`forms=${matchedForms}/${acceptance.forms.length}`);
  }

  if (errors.length > 0) {
    throw new Error(`${entry.id}: ${errors.join("; ")}`);
  }

  console.log(
    `PASS ${entry.id} bytes=${entry.bytes} pdfVersion=${entry.pdfVersion}${
      details.length > 0 ? ` ${details.join(" ")}` : ""
    }`
  );
}

async function readExpectedMarkdown(entry) {
  const expectedPath = path.join(repoRoot, "corpus", "expected", `${entry.id}.md`);
  try {
    return await readFile(expectedPath, "utf8");
  } catch (error) {
    throw new Error(`${entry.id}: expected Markdown is not readable at ${expectedPath}: ${error.message}`);
  }
}

async function readOcrResults(entry) {
  const ocrPath = path.join(repoRoot, entry.ocrResultsFile);
  try {
    const payload = JSON.parse(await readFile(ocrPath, "utf8"));
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload.results)) {
      return payload.results;
    }
    throw new Error("expected a JSON array or an object with a results array");
  } catch (error) {
    throw new Error(`${entry.id}: OCR results are not readable at ${ocrPath}: ${error.message}`);
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "n/a";
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  if (!listOnly && !hasFlag("--all") && !selectedGate && selectedIds.length === 0) {
    console.error(usage());
    process.exit(1);
  }

  const cases = await loadCases();
  const { selected, skipped } = selectCases(cases);

  if (listOnly || dryRun) {
    for (const corpusCase of selected) {
      printCase("SELECT", corpusCase);
    }
    for (const corpusCase of skipped) {
      console.log(`SKIP ${corpusCase.entry.id} reason=${corpusCase.reason}`);
    }
    console.log(`Selected ${selected.length}; skipped ${skipped.length}.`);
    return;
  }

  if (updateSnapshots) {
    console.log("Snapshot updates are not implemented in the scaffold runner yet.");
  }

  for (const corpusCase of selected) {
    await runCase(corpusCase);
  }
  console.log(`Corpus run passed: ${selected.length}; skipped ${skipped.length}.`);
}

await main();
