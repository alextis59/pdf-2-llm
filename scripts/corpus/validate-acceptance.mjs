import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const acceptanceDir = path.resolve(
  readOption("--dir") ?? path.join(repoRoot, "corpus", "accepted")
);
const manifestPath = path.resolve(
  readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
);
const selectedFiles = readOptions("--file");
const validateAll = hasFlag("--all");
const allowEmpty = hasFlag("--allow-empty");

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const allowedGates = new Set([
  "text-mvp",
  "robust-parser",
  "layout-v1",
  "tables-v1",
  "ocr-v1",
  "webgpu-v1",
  "advanced-v1",
  "forms-v1",
  "hardening-v1"
]);
const allowedSourceTypes = new Set(["digital", "scanned", "hybrid", "unknown"]);
const allowedExpectedModes = new Set([
  "pdf-text",
  "ocr",
  "hybrid",
  "asset-only",
  "metadata-only",
  "unsupported"
]);
const requiredTopLevelKeys = [
  "id",
  "gate",
  "sourceType",
  "expectedMode",
  "gating",
  "must",
  "mustNot",
  "metrics",
  "snippets",
  "structure",
  "warnings",
  "assets",
  "review"
];

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
  node scripts/corpus/validate-acceptance.mjs --all [--allow-empty]
  node scripts/corpus/validate-acceptance.mjs --file <path>

Options:
  --root <path>        Repository root. Defaults to cwd.
  --dir <path>         Acceptance directory. Defaults to corpus/accepted.
  --manifest <path>    Manifest path. Defaults to corpus/manifest.json.
  --allow-empty        Do not fail when --all finds no acceptance files.
`;
}

async function listYamlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listYamlFiles(entryPath)));
    } else if (/\.ya?ml$/.test(entry.name) && entry.name !== "template.yaml") {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function readTopLevelScalars(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s/.test(line)) {
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], match[2] ?? "");
    }
  }
  return values;
}

function readTopLevelKeys(text) {
  return new Set(readTopLevelScalars(text).keys());
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

function readNestedScalar(text, section, key) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith(`${section}:`)) {
      inSection = true;
      continue;
    }
    if (inSection && /^[A-Za-z][A-Za-z0-9]*:/.test(line)) {
      return null;
    }
    if (inSection) {
      const match = line.match(new RegExp(`^  ${key}:\\s*(.*)$`));
      if (match) {
        return normalizeScalar(match[1]);
      }
    }
  }
  return null;
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

function readNumber(value) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sectionHasListItem(text, section) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith(`${section}:`)) {
      inSection = true;
      continue;
    }
    if (inSection && /^[A-Za-z][A-Za-z0-9]*:/.test(line)) {
      return false;
    }
    if (inSection && /^\s+-\s+\S/.test(line)) {
      return true;
    }
  }
  return false;
}

async function loadManifestEntriesByAcceptancePath() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return new Map();
  }

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  return new Map(
    entries
      .filter((entry) => typeof entry.acceptanceFile === "string")
      .map((entry) => [path.resolve(repoRoot, entry.acceptanceFile), entry])
  );
}

function isLocalOnlyEntry(entry) {
  return (
    entry?.redistributable === false ||
    entry?.source?.type === "local-only" ||
    /(^|\/)local-only(\/|$)/.test(entry?.path ?? "")
  );
}

function validateAcceptanceText(text, filePath, manifestEntry) {
  const errors = [];
  const topLevelKeys = readTopLevelKeys(text);
  const scalars = readTopLevelScalars(text);
  const metrics = readNamedBlockScalars(text, "metrics");
  const relativePath = path.relative(repoRoot, filePath);

  for (const key of requiredTopLevelKeys) {
    if (!topLevelKeys.has(key)) {
      errors.push(`${relativePath}: missing top-level key "${key}"`);
    }
  }

  const id = normalizeScalar(scalars.get("id") ?? "");
  if (!idPattern.test(id)) {
    errors.push(`${relativePath}: id must match ${idPattern}`);
  }

  const expectedStem = path.basename(filePath).replace(/\.ya?ml$/, "");
  if (expectedStem !== "template" && id && expectedStem !== id) {
    errors.push(`${relativePath}: file name must match id "${id}"`);
  }

  const gate = normalizeScalar(scalars.get("gate") ?? "");
  if (!allowedGates.has(gate)) {
    errors.push(`${relativePath}: unsupported gate "${gate}"`);
  }

  const sourceType = normalizeScalar(scalars.get("sourceType") ?? "");
  if (!allowedSourceTypes.has(sourceType)) {
    errors.push(`${relativePath}: unsupported sourceType "${sourceType}"`);
  }

  const expectedMode = normalizeScalar(scalars.get("expectedMode") ?? "");
  if (!allowedExpectedModes.has(expectedMode)) {
    errors.push(`${relativePath}: unsupported expectedMode "${expectedMode}"`);
  }

  const gatingValue = normalizeScalar(scalars.get("gating") ?? "");
  if (!["true", "false"].includes(gatingValue)) {
    errors.push(`${relativePath}: gating must be true or false`);
  }

  const skipReason = normalizeScalar(scalars.get("skipReason") ?? "");
  const requiresSkipReason =
    gatingValue === "false" || expectedMode === "unsupported" || isLocalOnlyEntry(manifestEntry);
  if (requiresSkipReason && !skipReason) {
    errors.push(
      `${relativePath}: non-gating, unsupported, and local-only entries require skipReason`
    );
  }

  if (!sectionHasListItem(text, "must")) {
    errors.push(`${relativePath}: must must contain at least one list item`);
  }

  if (!sectionHasListItem(text, "mustNot")) {
    errors.push(`${relativePath}: mustNot must contain at least one list item`);
  }

  if (gatingValue === "true") {
    const reviewer = readNestedScalar(text, "review", "humanReviewedBy");
    const reviewedAt = readNestedScalar(text, "review", "reviewedAt");
    if (!reviewer) {
      errors.push(`${relativePath}: gating files require review.humanReviewedBy`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt ?? "")) {
      errors.push(`${relativePath}: gating files require review.reviewedAt as YYYY-MM-DD`);
    }
  }

  if (topLevelKeys.has("runningContent")) {
    const runningContent = readNamedStringLists(text, "runningContent");
    const expectedRemoved = runningContent.get("expectedRemoved") ?? [];
    const expectedRetained = runningContent.get("expectedRetained") ?? [];
    const labels = [...expectedRemoved, ...expectedRetained];
    if (labels.length === 0) {
      errors.push(`${relativePath}: runningContent must define at least one label`);
    }
    if (labels.some((label) => label.length === 0)) {
      errors.push(`${relativePath}: runningContent labels must not be empty`);
    }

    for (const metricName of [
      "minRunningContentPrecision",
      "minRunningContentRecall"
    ]) {
      const value = readNumber(metrics.get(metricName));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        errors.push(`${relativePath}: metrics.${metricName} must be a number from 0 to 1`);
      }
    }
  }

  for (const metricName of [
    "maxReadingOrderDistance",
    "minTableCellAdjacency",
    "minTableSpanAccuracy"
  ]) {
    if (!metrics.has(metricName)) {
      continue;
    }
    const value = readNumber(metrics.get(metricName));
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${relativePath}: metrics.${metricName} must be a number from 0 to 1`);
    }
  }

  for (const metricName of ["maxRssDeltaBytes", "maxHeapUsedDeltaBytes"]) {
    if (metrics.has(metricName)) {
      const value = readNumber(metrics.get(metricName));
      if (!Number.isInteger(value) || value < 0) {
        errors.push(`${relativePath}: metrics.${metricName} must be a non-negative integer`);
      }
    }
  }

  for (const metricName of ["minTaggedMarkedContent", "maxTaggedStructureConflicts"]) {
    if (metrics.has(metricName)) {
      const value = readNumber(metrics.get(metricName));
      if (!Number.isInteger(value) || value < 0) {
        errors.push(`${relativePath}: metrics.${metricName} must be a non-negative integer`);
      }
    }
  }

  for (const metricName of [
    "minRenderedHtmlTextChars",
    "minRenderedHtmlHeadings",
    "minRenderedHtmlParagraphs",
    "maxRenderedHtmlParagraphChars"
  ]) {
    if (metrics.has(metricName)) {
      const value = readNumber(metrics.get(metricName));
      if (!Number.isInteger(value) || value < 0) {
        errors.push(`${relativePath}: metrics.${metricName} must be a non-negative integer`);
      }
    }
  }

  return errors;
}

async function validateFile(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    return [`${filePath}: not a file`];
  }
  const text = await readFile(filePath, "utf8");
  const manifestEntry = manifestEntriesByAcceptancePath.get(path.resolve(filePath));
  return validateAcceptanceText(text, filePath, manifestEntry);
}

const manifestEntriesByAcceptancePath = await loadManifestEntriesByAcceptancePath();

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  let files;
  if (validateAll) {
    files = await listYamlFiles(acceptanceDir);
  } else if (selectedFiles.length > 0) {
    files = selectedFiles.map((filePath) => path.resolve(repoRoot, filePath));
  } else {
    console.error(usage());
    process.exit(1);
  }

  if (files.length === 0) {
    if (allowEmpty) {
      console.log("Acceptance criteria valid: 0 files");
      return;
    }
    console.error("No acceptance files found.");
    process.exit(1);
  }

  const errors = [];
  for (const file of files) {
    errors.push(...(await validateFile(file)));
  }

  if (errors.length > 0) {
    console.error("Acceptance validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Acceptance criteria valid: ${files.length} file(s)`);
}

await main();
