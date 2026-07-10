import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseDocument } from "yaml";
import { warningCodes } from "../../packages/pdf2md/src/index.mjs";

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
const allowedWarningCodes = new Set(Object.values(warningCodes));
const nonEmptyStringSchema = { type: "string", minLength: 1 };
const stringListSchema = {
  type: "array",
  items: nonEmptyStringSchema
};
const ratioSchema = { type: "number", minimum: 0, maximum: 1 };
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 };
const acceptanceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
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
  ],
  properties: {
    id: { ...nonEmptyStringSchema, pattern: idPattern },
    gate: { type: "string", enum: [...allowedGates] },
    sourceType: { type: "string", enum: [...allowedSourceTypes] },
    expectedMode: { type: "string", enum: [...allowedExpectedModes] },
    gating: { type: "boolean" },
    skipReason: nonEmptyStringSchema,
    must: { ...stringListSchema, minItems: 1 },
    mustNot: { ...stringListSchema, minItems: 1 },
    metrics: {
      type: "object",
      additionalProperties: false,
      properties: {
        minTextCoverage: ratioSchema,
        maxReadingOrderDistance: ratioSchema,
        maxCharacterErrorRate: ratioSchema,
        maxOcrCharacterErrorRate: ratioSchema,
        maxOcrWordErrorRate: ratioSchema,
        minRunningContentPrecision: ratioSchema,
        minRunningContentRecall: ratioSchema,
        minTableCellAdjacency: ratioSchema,
        minTableCsvCellTextAccuracy: ratioSchema,
        minTableSpanAccuracy: ratioSchema,
        maxUnexpectedWarnings: nonNegativeIntegerSchema,
        maxRssDeltaBytes: nonNegativeIntegerSchema,
        maxHeapUsedDeltaBytes: nonNegativeIntegerSchema,
        minTaggedMarkedContent: nonNegativeIntegerSchema,
        maxTaggedStructureConflicts: nonNegativeIntegerSchema,
        minRenderedHtmlTextChars: nonNegativeIntegerSchema,
        minRenderedHtmlHeadings: nonNegativeIntegerSchema,
        minRenderedHtmlParagraphs: nonNegativeIntegerSchema,
        maxRenderedHtmlParagraphChars: nonNegativeIntegerSchema
      }
    },
    snippets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "contains"],
        properties: {
          page: { type: "integer", minimum: 1 },
          contains: nonEmptyStringSchema
        }
      }
    },
    runningContent: {
      type: "object",
      additionalProperties: false,
      properties: {
        expectedRemoved: stringListSchema,
        expectedRetained: stringListSchema
      }
    },
    structure: {
      type: "object",
      additionalProperties: false,
      properties: {
        expected: stringListSchema,
        headings: stringListSchema,
        tables: stringListSchema,
        forms: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "fieldType"],
            properties: {
              name: nonEmptyStringSchema,
              label: nonEmptyStringSchema,
              fieldType: nonEmptyStringSchema,
              buttonType: nonEmptyStringSchema,
              value: { type: ["string", "number", "boolean", "null"] },
              checked: { type: "boolean" },
              selectedValue: nonEmptyStringSchema
            }
          }
        }
      }
    },
    warnings: {
      type: "object",
      additionalProperties: false,
      required: ["allowed"],
      properties: {
        allowed: stringListSchema
      }
    },
    assets: {
      type: "object",
      additionalProperties: false,
      required: ["required"],
      properties: {
        required: stringListSchema
      }
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["humanReviewedBy", "reviewedAt", "notes"],
      properties: {
        humanReviewedBy: { type: "string" },
        reviewedAt: { type: "string" },
        notes: nonEmptyStringSchema
      }
    }
  }
};

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

function parseAcceptanceYaml(text, relativePath) {
  const document = parseDocument(text, {
    prettyErrors: false,
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${relativePath}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`
    );
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${relativePath}: invalid YAML: ${error.message}`, { cause: error });
  }
}

function validateClosedSchema(value, schema, location, relativePath, errors) {
  if (!matchesType(value, schema.type)) {
    errors.push(`${relativePath}: ${displayLocation(location)} must be ${describeType(schema.type)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `${relativePath}: ${displayLocation(location)} must be one of ${schema.enum.join(", ")}`
    );
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${relativePath}: ${displayLocation(location)} must not be empty`);
    }
    if (schema.pattern && !schema.pattern.test(value)) {
      errors.push(`${relativePath}: ${displayLocation(location)} must match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${relativePath}: ${displayLocation(location)} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${relativePath}: ${displayLocation(location)} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        `${relativePath}: ${displayLocation(location)} must contain at least ${schema.minItems} item(s)`
      );
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateClosedSchema(item, schema.items, `${location}[${index}]`, relativePath, errors);
      });
    }
    return;
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${relativePath}: missing key "${joinLocation(location, key)}"`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push(`${relativePath}: unknown key "${joinLocation(location, key)}"`);
        }
        continue;
      }
      validateClosedSchema(
        child,
        childSchema,
        joinLocation(location, key),
        relativePath,
        errors
      );
    }
  }
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "array") {
      return Array.isArray(value);
    }
    if (type === "object") {
      return isPlainObject(value);
    }
    if (type === "integer") {
      return Number.isInteger(value);
    }
    if (type === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (type === "null") {
      return value === null;
    }
    return typeof value === type;
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(type) {
  return (Array.isArray(type) ? type : [type]).join(" or ");
}

function displayLocation(location) {
  return location ? `"${location}"` : "document";
}

function joinLocation(parent, child) {
  return parent ? `${parent}.${child}` : child;
}

async function loadManifestEntriesByAcceptancePath() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      entries: new Map(),
      errors: [
        `${path.relative(repoRoot, manifestPath)}: unable to read manifest: ${error.message}`
      ]
    };
  }

  if (!Array.isArray(manifest.entries)) {
    return {
      entries: new Map(),
      errors: [`${path.relative(repoRoot, manifestPath)}: entries must be an array`]
    };
  }

  const entries = new Map();
  for (const entry of manifest.entries) {
    if (typeof entry.acceptanceFile !== "string") {
      continue;
    }
    const acceptancePath = path.resolve(repoRoot, entry.acceptanceFile);
    const candidates = entries.get(acceptancePath) ?? [];
    candidates.push(entry);
    entries.set(acceptancePath, candidates);
  }
  return { entries, errors: [] };
}

function isLocalOnlyEntry(entry) {
  return (
    entry?.redistributable === false ||
    entry?.source?.type === "local-only" ||
    /(^|\/)local-only(\/|$)/.test(entry?.path ?? "")
  );
}

function validateAcceptanceData(data, filePath, manifestEntry) {
  const errors = [];
  const relativePath = path.relative(repoRoot, filePath);
  validateClosedSchema(data, acceptanceSchema, "", relativePath, errors);
  if (!isPlainObject(data)) {
    return errors;
  }

  const id = typeof data.id === "string" ? data.id : "";

  const expectedStem = path.basename(filePath).replace(/\.ya?ml$/, "");
  if (expectedStem !== "template" && id && expectedStem !== id) {
    errors.push(`${relativePath}: file name must match id "${id}"`);
  }
  if (manifestEntry && id && manifestEntry.id !== id) {
    errors.push(
      `${relativePath}: manifest entry id "${manifestEntry.id}" does not match acceptance id "${id}"`
    );
  }

  const skipReason = typeof data.skipReason === "string" ? data.skipReason.trim() : "";
  const requiresSkipReason =
    data.gating === false || data.expectedMode === "unsupported" || isLocalOnlyEntry(manifestEntry);
  if (requiresSkipReason && !skipReason) {
    errors.push(
      `${relativePath}: non-gating, unsupported, and local-only entries require skipReason`
    );
  }

  if (data.gating === true) {
    const reviewer = data.review?.humanReviewedBy;
    const reviewedAt = data.review?.reviewedAt;
    if (!Object.hasOwn(data.metrics ?? {}, "minTextCoverage")) {
      errors.push(`${relativePath}: gating files require metrics.minTextCoverage`);
    }
    if (typeof reviewer !== "string" || reviewer.trim().length === 0) {
      errors.push(`${relativePath}: gating files require review.humanReviewedBy`);
    }
    if (typeof reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) {
      errors.push(`${relativePath}: gating files require review.reviewedAt as YYYY-MM-DD`);
    }
  }

  if (isPlainObject(data.runningContent)) {
    const expectedRemoved = Array.isArray(data.runningContent.expectedRemoved)
      ? data.runningContent.expectedRemoved
      : [];
    const expectedRetained = Array.isArray(data.runningContent.expectedRetained)
      ? data.runningContent.expectedRetained
      : [];
    const labels = [...expectedRemoved, ...expectedRetained];
    if (labels.length === 0) {
      errors.push(`${relativePath}: runningContent must define at least one label`);
    }

    for (const metricName of [
      "minRunningContentPrecision",
      "minRunningContentRecall"
    ]) {
      if (!Object.hasOwn(data.metrics ?? {}, metricName)) {
        errors.push(`${relativePath}: runningContent requires metrics.${metricName}`);
      }
    }
  }

  for (const code of Array.isArray(data.warnings?.allowed) ? data.warnings.allowed : []) {
    if (!allowedWarningCodes.has(code)) {
      errors.push(`${relativePath}: warnings.allowed contains unknown public code "${code}"`);
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
  const relativePath = path.relative(repoRoot, filePath);
  let data;
  try {
    data = parseAcceptanceYaml(text, relativePath);
  } catch (error) {
    return [error.message];
  }

  const manifestCandidates = manifestEntriesByAcceptancePath.get(path.resolve(filePath)) ?? [];
  const mappingErrors = [];
  const isTemplate = path.basename(filePath) === "template.yaml";
  if (!isTemplate && manifestCandidates.length !== 1) {
    mappingErrors.push(
      `${relativePath}: expected exactly one manifest entry, found ${manifestCandidates.length}`
    );
  }
  const manifestEntry = manifestCandidates.length === 1 ? manifestCandidates[0] : null;
  return [...mappingErrors, ...validateAcceptanceData(data, filePath, manifestEntry)];
}

const manifestLookup = await loadManifestEntriesByAcceptancePath();
const manifestEntriesByAcceptancePath = manifestLookup.entries;

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

  const errors = [...manifestLookup.errors];
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
