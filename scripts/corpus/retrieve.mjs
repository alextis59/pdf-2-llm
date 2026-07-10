import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const candidateFile = path.resolve(
  readOption("--candidate-file") ?? path.join(repoRoot, "corpus", "candidates.json")
);
const dryRun = hasFlag("--dry-run");
const update = hasFlag("--update");
const selectAll = hasFlag("--all");
const selectedIds = readOptions("--id");
const selectedGroups = readOptions("--group");
const defaultMaxDownloadBytes = 100 * 1024 * 1024;

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

const idPattern = /^[a-z0-9][a-z0-9-]*$/;
const sourceTypes = new Set(["url", "local-file"]);
const dispositions = new Set(["commit-ok", "local-only", "do-not-use", "needs-review"]);
const acceptedPdfContentTypes = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/acrobat",
  "applications/vnd.pdf",
  "text/pdf",
  "text/x-pdf",
  "application/octet-stream",
  "binary/octet-stream"
]);

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
  node scripts/corpus/retrieve.mjs --all [--dry-run] [--update]
  node scripts/corpus/retrieve.mjs --group <group-id> [--dry-run] [--update]
  node scripts/corpus/retrieve.mjs --id <candidate-id> [--dry-run] [--update]

Options:
  --candidate-file <path>  Candidate registry path.
  --root <path>            Repository root. Defaults to cwd.
  --max-download-bytes <n> Maximum bytes per remote or local candidate. Defaults to 104857600.
  --dry-run                Validate and print selected candidates only.
  --update                 Allow replacing an existing target file.
`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateString(value, location, errors, { pattern } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${location} must be a non-empty string`);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${location} has an invalid format`);
  }
  return value;
}

function validateNonNegativeInteger(value, location, errors) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${location} must be a non-negative integer`);
  }
}

function validateBoolean(value, location, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${location} must be a boolean`);
  }
}

function validateRelativePath(relativePath, location, errors) {
  if (!relativePath) {
    return;
  }
  if (path.isAbsolute(relativePath)) {
    errors.push(`${location} must be relative to the repository root`);
    return;
  }
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes(`${path.sep}..${path.sep}`)) {
    errors.push(`${location} must not leave the repository root`);
  }
}

function validateRegistry(registry) {
  const errors = [];
  if (!isPlainObject(registry)) {
    return ["candidate registry must be an object"];
  }

  if (registry.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  if (!Array.isArray(registry.groups)) {
    errors.push("groups must be an array");
    return errors;
  }

  const groupIds = new Set();
  const candidateIds = new Set();

  for (const [groupIndex, group] of registry.groups.entries()) {
    const location = `groups[${groupIndex}]`;
    if (!isPlainObject(group)) {
      errors.push(`${location} must be an object`);
      continue;
    }

    const groupId = validateString(group.id, `${location}.id`, errors, { pattern: idPattern });
    if (groupId) {
      if (groupIds.has(groupId)) {
        errors.push(`${location}.id duplicates "${groupId}"`);
      }
      groupIds.add(groupId);
    }

    const kind = validateString(group.kind, `${location}.kind`, errors);
    if (kind && !allowedKinds.has(kind)) {
      errors.push(`${location}.kind is unsupported: ${kind}`);
    }

    validateNonNegativeInteger(group.minimumCount, `${location}.minimumCount`, errors);
    validateString(group.strategy, `${location}.strategy`, errors);
    validateString(group.why, `${location}.why`, errors);

    if (!Array.isArray(group.candidates)) {
      errors.push(`${location}.candidates must be an array`);
      continue;
    }

    for (const [candidateIndex, candidate] of group.candidates.entries()) {
      validateCandidate(candidate, `${location}.candidates[${candidateIndex}]`, errors, {
        groupId,
        groupKind: kind,
        candidateIds
      });
    }
  }

  return errors;
}

function validateCandidate(candidate, location, errors, { groupId, groupKind, candidateIds }) {
  if (!isPlainObject(candidate)) {
    errors.push(`${location} must be an object`);
    return;
  }

  const id = validateString(candidate.id, `${location}.id`, errors, { pattern: idPattern });
  if (id) {
    if (candidateIds.has(id)) {
      errors.push(`${location}.id duplicates "${id}"`);
    }
    candidateIds.add(id);
  }

  const sourceType = validateString(candidate.sourceType, `${location}.sourceType`, errors);
  if (sourceType && !sourceTypes.has(sourceType)) {
    errors.push(`${location}.sourceType is unsupported: ${sourceType}`);
  }

  if (sourceType === "url") {
    validateString(candidate.url, `${location}.url`, errors);
  }

  if (sourceType === "local-file") {
    validateString(candidate.localPath, `${location}.localPath`, errors);
  }

  const targetPath = validateString(candidate.targetPath, `${location}.targetPath`, errors);
  validateRelativePath(targetPath, `${location}.targetPath`, errors);

  validateString(candidate.licenseName, `${location}.licenseName`, errors);
  validateString(candidate.licenseNotes, `${location}.licenseNotes`, errors);
  validateBoolean(candidate.redistributable, `${location}.redistributable`, errors);
  const disposition = validateString(candidate.disposition, `${location}.disposition`, errors);
  if (disposition && !dispositions.has(disposition)) {
    errors.push(`${location}.disposition is unsupported: ${disposition}`);
  }
  validateString(candidate.retrievalCommand, `${location}.retrievalCommand`, errors);
  validateString(candidate.notes, `${location}.notes`, errors);

  if (candidate.expectedSha256 && !/^[a-f0-9]{64}$/.test(candidate.expectedSha256)) {
    errors.push(`${location}.expectedSha256 must be a lowercase SHA-256 digest`);
  }

  if (candidate.kind && candidate.kind !== groupKind) {
    errors.push(`${location}.kind must match parent group kind "${groupKind}"`);
  }

  if (candidate.group && candidate.group !== groupId) {
    errors.push(`${location}.group must match parent group id "${groupId}"`);
  }

  if (candidate.redistributable === false && targetPath && !targetPath.startsWith("corpus/raw/local-only/")) {
    errors.push(`${location}.targetPath must be under corpus/raw/local-only/ when redistributable is false`);
  }

  if (candidate.disposition === "local-only" && candidate.redistributable !== false) {
    errors.push(`${location}.disposition local-only requires redistributable false`);
  }

  if (candidate.disposition === "commit-ok" && candidate.redistributable !== true) {
    errors.push(`${location}.disposition commit-ok requires redistributable true`);
  }

  if (candidate.redistributable === true && sourceType === "url" && targetPath && !targetPath.startsWith("corpus/raw/_incoming/")) {
    errors.push(`${location}.targetPath must be under corpus/raw/_incoming/ until accepted`);
  }
}

function flattenCandidates(registry) {
  return registry.groups.flatMap((group) =>
    group.candidates.map((candidate) => ({
      ...candidate,
      group: group.id,
      kind: candidate.kind ?? group.kind
    }))
  );
}

function selectCandidates(registry) {
  const allCandidates = flattenCandidates(registry);
  if (selectAll) {
    return allCandidates;
  }

  const idSet = new Set(selectedIds);
  const groupSet = new Set(selectedGroups);
  const selected = allCandidates.filter(
    (candidate) => idSet.has(candidate.id) || groupSet.has(candidate.group)
  );

  const knownIds = new Set(allCandidates.map((candidate) => candidate.id));
  const knownGroups = new Set(registry.groups.map((group) => group.id));
  for (const id of idSet) {
    if (!knownIds.has(id)) {
      throw new Error(`unknown candidate id "${id}"`);
    }
  }
  for (const group of groupSet) {
    if (!knownGroups.has(group)) {
      throw new Error(`unknown group id "${group}"`);
    }
  }

  return selected;
}

function readMaxDownloadBytes() {
  const value = readOption("--max-download-bytes");
  if (value === undefined) {
    return defaultMaxDownloadBytes;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--max-download-bytes must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("--max-download-bytes must be a safe positive integer");
  }
  return parsed;
}

function ensurePdfMagic(bytes, candidate) {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`${candidate.id}: downloaded file does not start with %PDF-`);
  }
}

function ensureContentType(contentType, candidate) {
  if (!contentType) {
    throw new Error(`${candidate.id}: response did not include Content-Type`);
  }

  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (!acceptedPdfContentTypes.has(normalized)) {
    throw new Error(`${candidate.id}: unexpected Content-Type "${contentType}"`);
  }
}

function readContentLength(value, candidate) {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${candidate.id}: invalid Content-Length "${value}"`);
  }
  const contentLength = Number(normalized);
  if (!Number.isSafeInteger(contentLength)) {
    throw new Error(`${candidate.id}: Content-Length exceeds the safe integer range`);
  }
  return contentLength;
}

function enforceCandidateByteLimit(byteLength, maxDownloadBytes, candidate, source) {
  if (byteLength > maxDownloadBytes) {
    throw new Error(
      `${candidate.id}: ${source} ${byteLength} exceeds max download size ${maxDownloadBytes}`
    );
  }
}

async function stageCandidate(candidate, tempPath, maxDownloadBytes) {
  if (candidate.sourceType === "local-file") {
    const absoluteSource = path.resolve(repoRoot, candidate.localPath);
    const sourceStats = await stat(absoluteSource);
    if (!sourceStats.isFile()) {
      throw new Error(`${candidate.id}: local source is not a file`);
    }
    enforceCandidateByteLimit(sourceStats.size, maxDownloadBytes, candidate, "local file size");
    const measured = await streamCandidateToFile(
      createReadStream(absoluteSource),
      tempPath,
      candidate,
      maxDownloadBytes
    );
    return {
      ...measured,
      source: {
        type: "local-file",
        finalUrl: null,
        status: null,
        contentType: null
      }
    };
  }

  const response = await fetch(candidate.url, {
    headers: {
      "User-Agent": "pdf-2-llm-corpus-retriever/0.0.0"
    },
    redirect: "follow"
  });

  let contentType;
  try {
    contentType = response.headers.get("content-type");
    ensureContentType(contentType, candidate);
    if (!response.ok) {
      throw new Error(`${candidate.id}: HTTP ${response.status} for ${candidate.url}`);
    }
    const contentLength = readContentLength(response.headers.get("content-length"), candidate);
    if (contentLength !== null) {
      enforceCandidateByteLimit(
        contentLength,
        maxDownloadBytes,
        candidate,
        "Content-Length"
      );
    }
    if (!response.body) {
      throw new Error(`${candidate.id}: response did not include a body`);
    }
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }

  const measured = await streamCandidateToFile(
    Readable.fromWeb(response.body),
    tempPath,
    candidate,
    maxDownloadBytes
  );
  return {
    ...measured,
    source: {
      type: "url",
      finalUrl: response.url,
      status: response.status,
      contentType
    }
  };
}

async function streamCandidateToFile(sourceStream, tempPath, candidate, maxDownloadBytes) {
  let byteLength = 0;
  let header = Buffer.alloc(0);
  const hash = createHash("sha256");
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextByteLength = byteLength + bytes.length;
      if (!Number.isSafeInteger(nextByteLength) || nextByteLength > maxDownloadBytes) {
        callback(
          new Error(
            `${candidate.id}: streamed body exceeds max download size ${maxDownloadBytes}`
          )
        );
        return;
      }

      byteLength = nextByteLength;
      hash.update(bytes);
      if (header.length < 5) {
        const required = 5 - header.length;
        header = Buffer.concat([header, bytes.subarray(0, required)]);
        if (header.length === 5) {
          try {
            ensurePdfMagic(header, candidate);
          } catch (error) {
            callback(error);
            return;
          }
        }
      }
      callback(null, bytes);
    }
  });

  try {
    await pipeline(sourceStream, meter, createWriteStream(tempPath, { flags: "wx" }));
    ensurePdfMagic(header, candidate);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  return {
    actualHash: hash.digest("hex"),
    byteLength
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function finalizeRetrievedCandidate(
  candidate,
  { tempPath, source, actualHash, byteLength }
) {
  if (candidate.expectedSha256 && candidate.expectedSha256 !== actualHash) {
    throw new Error(`${candidate.id}: expected SHA-256 ${candidate.expectedSha256}, found ${actualHash}`);
  }

  const targetPath = path.join(repoRoot, candidate.targetPath);

  try {
    const existingHash = await sha256File(targetPath);
    if (existingHash === actualHash) {
      await unlink(tempPath);
      console.log(`${candidate.id}: unchanged at ${candidate.targetPath}`);
      return writeRetrievalRecord(candidate, source, actualHash, byteLength);
    }
    if (!update) {
      throw new Error(`${candidate.id}: target exists with different hash; pass --update to replace it`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  console.log(`${candidate.id}: wrote ${candidate.targetPath} (${byteLength} bytes, ${actualHash})`);
  return writeRetrievalRecord(candidate, source, actualHash, byteLength);
}

async function writeRetrievalRecord(candidate, source, actualHash, byteLength) {
  const retrievedAt = new Date().toISOString();
  const manifestSourceType =
    candidate.sourceType === "url" ? "url" : candidate.redistributable ? "manual-import" : "local-only";
  const record = {
    id: candidate.id,
    group: candidate.group,
    kind: candidate.kind,
    targetPath: candidate.targetPath,
    retrievedAt,
    source,
    license: {
      name: candidate.licenseName,
      url: candidate.licenseUrl ?? null,
      notes: candidate.licenseNotes
    },
    redistributable: candidate.redistributable,
    disposition: candidate.disposition,
    sha256: actualHash,
    bytes: byteLength,
    notes: candidate.notes,
    manifestDraft: {
      id: candidate.id,
      kind: candidate.kind,
      path: candidate.targetPath,
      source: {
        type: manifestSourceType,
        url: candidate.url ?? undefined,
        description: candidate.notes
      },
      retrievedAt: retrievedAt.slice(0, 10),
      license: {
        name: candidate.licenseName,
        url: candidate.licenseUrl,
        notes: candidate.licenseNotes
      },
      redistributable: candidate.redistributable,
      sha256: actualHash,
      bytes: byteLength,
      pages: 0,
      pdfVersion: "unknown",
      features: [],
      acceptanceFile: `corpus/accepted/${candidate.id}.yaml`,
      notes: candidate.notes
    }
  };

  const recordPath = path.join(repoRoot, `${candidate.targetPath}.retrieval.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${candidate.id}: wrote retrieval record ${path.relative(repoRoot, recordPath)}`);
}

async function retrieveCandidate(candidate, maxDownloadBytes) {
  console.log(
    `${candidate.id}: ${candidate.sourceType}, redistributable=${candidate.redistributable}, license=${candidate.licenseName}`
  );
  const targetPath = path.join(repoRoot, candidate.targetPath);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    const staged = await stageCandidate(candidate, tempPath, maxDownloadBytes);
    await finalizeRetrievedCandidate(candidate, { tempPath, ...staged });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  if (!selectAll && selectedIds.length === 0 && selectedGroups.length === 0) {
    console.error(usage());
    process.exit(1);
  }

  const maxDownloadBytes = readMaxDownloadBytes();

  const registry = JSON.parse(await readFile(candidateFile, "utf8"));
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    console.error("Candidate registry validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const selected = selectCandidates(registry);
  if (selected.length === 0) {
    console.log("No candidates selected.");
    return;
  }

  if (dryRun) {
    for (const candidate of selected) {
      console.log(
        `${candidate.id}: group=${candidate.group}, source=${candidate.sourceType}, target=${candidate.targetPath}, disposition=${candidate.disposition}, redistributable=${candidate.redistributable}, license=${candidate.licenseName}`
      );
    }
    console.log(
      `Dry run selected ${selected.length} candidate(s), maxDownloadBytes=${maxDownloadBytes}.`
    );
    return;
  }

  for (const candidate of selected) {
    await retrieveCandidate(candidate, maxDownloadBytes);
  }
}

await main();
