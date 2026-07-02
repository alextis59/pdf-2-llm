import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const manifestPath = path.resolve(
  readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
);

const allowedKinds = new Set([
  "synthetic",
  "born-digital",
  "tagged",
  "font-edge-case",
  "pdf-feature",
  "linearized",
  "incremental-update",
  "encrypted",
  "damaged",
  "scanned",
  "searchable-scan",
  "bad-ocr-overlay",
  "long-document",
  "scientific-paper",
  "visible-table",
  "borderless-table",
  "complex-table",
  "form",
  "invoice-receipt",
  "slide-brochure",
  "vector-heavy",
  "equation",
  "rtl",
  "cjk",
  "vertical-writing",
  "rotated-cropped",
  "stress",
  "annotation-link",
  "attachment",
  "signature",
  "xfa"
]);

const allowedSourceTypes = new Set(["url", "generated", "mutated", "manual-import", "local-only"]);
const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const errors = [];

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function addError(location, message) {
  errors.push(`${location}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowedKeys, location) {
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addError(location, `unknown key "${key}"`);
    }
  }
}

function expectString(entry, key, location, { pattern } = {}) {
  const value = entry[key];
  if (typeof value !== "string" || value.length === 0) {
    addError(location, `${key} must be a non-empty string`);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    addError(location, `${key} has an invalid format`);
  }
  return value;
}

function expectNonNegativeInteger(entry, key, location) {
  const value = entry[key];
  if (!Number.isInteger(value) || value < 0) {
    addError(location, `${key} must be a non-negative integer`);
    return undefined;
  }
  return value;
}

function expectBoolean(entry, key, location) {
  const value = entry[key];
  if (typeof value !== "boolean") {
    addError(location, `${key} must be a boolean`);
    return undefined;
  }
  return value;
}

function validateFeatureList(entry, location) {
  if (!Array.isArray(entry.features)) {
    addError(location, "features must be an array");
    return;
  }
  const seen = new Set();
  for (const [index, feature] of entry.features.entries()) {
    if (typeof feature !== "string" || feature.length === 0) {
      addError(`${location}.features[${index}]`, "feature must be a non-empty string");
      continue;
    }
    if (seen.has(feature)) {
      addError(`${location}.features[${index}]`, `duplicate feature "${feature}"`);
    }
    seen.add(feature);
  }
}

function validateSource(entry, location) {
  if (!isPlainObject(entry.source)) {
    addError(location, "source must be an object");
    return;
  }

  rejectUnknownKeys(
    entry.source,
    new Set(["type", "url", "description", "command"]),
    `${location}.source`
  );

  const type = expectString(entry.source, "type", `${location}.source`);
  expectString(entry.source, "description", `${location}.source`);

  if (type && !allowedSourceTypes.has(type)) {
    addError(`${location}.source`, `unsupported source type "${type}"`);
  }

  if (type === "url") {
    expectString(entry.source, "url", `${location}.source`);
  }

  if ((type === "generated" || type === "mutated") && !entry.source.command) {
    addError(`${location}.source`, "generated and mutated entries must include command");
  }
}

function validateLicense(entry, location) {
  if (!isPlainObject(entry.license)) {
    addError(location, "license must be an object");
    return;
  }

  rejectUnknownKeys(entry.license, new Set(["name", "url", "notes"]), `${location}.license`);

  expectString(entry.license, "name", `${location}.license`);
  expectString(entry.license, "notes", `${location}.license`);
}

function validatePathSafety(relativePath, location) {
  if (!relativePath) {
    return;
  }

  if (path.isAbsolute(relativePath)) {
    addError(location, "path must be relative to the repository root");
    return;
  }

  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) {
    addError(location, "path must not leave the repository root");
  }
}

async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function validateEntry(entry, index, ids) {
  const location = `entries[${index}]`;
  if (!isPlainObject(entry)) {
    addError(location, "entry must be an object");
    return;
  }

  rejectUnknownKeys(
    entry,
    new Set([
      "id",
      "kind",
      "path",
      "source",
      "retrievedAt",
      "license",
      "redistributable",
      "sha256",
      "bytes",
      "pages",
      "pdfVersion",
      "features",
      "acceptanceFile",
      "notes"
    ]),
    location
  );

  const id = expectString(entry, "id", location, { pattern: idPattern });
  if (id) {
    if (ids.has(id)) {
      addError(location, `duplicate id "${id}"`);
    }
    ids.add(id);
  }

  const kind = expectString(entry, "kind", location);
  if (kind && !allowedKinds.has(kind)) {
    addError(location, `unsupported kind "${kind}"`);
  }

  const relativePath = expectString(entry, "path", location);
  validatePathSafety(relativePath, `${location}.path`);

  validateSource(entry, location);
  expectString(entry, "retrievedAt", location, { pattern: datePattern });
  validateLicense(entry, location);
  const redistributable = expectBoolean(entry, "redistributable", location);
  const expectedHash = expectString(entry, "sha256", location, { pattern: sha256Pattern });
  const expectedBytes = expectNonNegativeInteger(entry, "bytes", location);
  expectNonNegativeInteger(entry, "pages", location);
  expectString(entry, "pdfVersion", location);
  validateFeatureList(entry, location);

  const acceptanceFile = expectString(entry, "acceptanceFile", location);
  validatePathSafety(acceptanceFile, `${location}.acceptanceFile`);
  expectString(entry, "notes", location);

  if (redistributable === false && relativePath && !relativePath.startsWith("corpus/raw/local-only/")) {
    addError(location, "non-redistributable PDFs must live under corpus/raw/local-only/");
  }

  if (relativePath) {
    const absolutePath = path.join(repoRoot, relativePath);
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        addError(`${location}.path`, "path does not point to a file");
      } else {
        if (expectedBytes !== undefined && fileStat.size !== expectedBytes) {
          addError(`${location}.bytes`, `expected ${expectedBytes}, found ${fileStat.size}`);
        }
        if (expectedHash) {
          const actualHash = await hashFile(absolutePath);
          if (actualHash !== expectedHash) {
            addError(`${location}.sha256`, `expected ${expectedHash}, found ${actualHash}`);
          }
        }
      }
    } catch (error) {
      addError(`${location}.path`, `file is not readable: ${error.message}`);
    }
  }

  if (acceptanceFile) {
    try {
      const acceptanceStat = await stat(path.join(repoRoot, acceptanceFile));
      if (!acceptanceStat.isFile()) {
        addError(`${location}.acceptanceFile`, "acceptanceFile does not point to a file");
      }
    } catch (error) {
      addError(`${location}.acceptanceFile`, `file is not readable: ${error.message}`);
    }
  }
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    addError("manifest", `failed to read or parse ${manifestPath}: ${error.message}`);
  }

  if (!isPlainObject(manifest)) {
    addError("manifest", "manifest must be an object");
  } else {
    rejectUnknownKeys(manifest, new Set(["schemaVersion", "entries"]), "manifest");

    if (manifest.schemaVersion !== 1) {
      addError("schemaVersion", "schemaVersion must be 1");
    }

    if (!Array.isArray(manifest.entries)) {
      addError("entries", "entries must be an array");
    } else {
      const ids = new Set();
      for (const [index, entry] of manifest.entries.entries()) {
        await validateEntry(entry, index, ids);
      }
    }
  }

  if (errors.length > 0) {
    console.error("Corpus manifest validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Corpus manifest valid: ${manifest.entries.length} entries`);
}

await main();
