import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validateAcceptancePath = fileURLToPath(
  new URL("../../../scripts/corpus/validate-acceptance.mjs", import.meta.url)
);

test("validate-acceptance requires minTextCoverage for gating files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeManifest(root);
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    [
      "id: sample",
      "gate: text-mvp",
      "sourceType: digital",
      "expectedMode: pdf-text",
      "gating: true",
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - invent_missing_values",
      "metrics:",
      "  maxCharacterErrorRate: 0",
      "snippets:",
      "  - page: 1",
      "    contains: \"Sample\"",
      "structure:",
      "  expected:",
      "    - paragraph",
      "warnings:",
      "  allowed: []",
      "assets:",
      "  required: []",
      "review:",
      "  humanReviewedBy: \"codex\"",
      "  reviewedAt: \"2026-07-04\"",
      "  notes: \"Exact fixture coverage should be declared explicitly.\""
    ].join("\n")
  );

  const result = await runValidateAcceptance(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /gating files require metrics\.minTextCoverage/);
});

test("validate-acceptance range-checks acceptance metrics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeManifest(root);
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    [
      "id: sample",
      "gate: text-mvp",
      "sourceType: digital",
      "expectedMode: pdf-text",
      "gating: true",
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - invent_missing_values",
      "metrics:",
      "  minTextCoverage: 1.2",
      "  maxUnexpectedWarnings: -1",
      "snippets:",
      "  - page: 1",
      "    contains: \"Sample\"",
      "structure:",
      "  expected:",
      "    - paragraph",
      "warnings:",
      "  allowed: []",
      "assets:",
      "  required: []",
      "review:",
      "  humanReviewedBy: \"codex\"",
      "  reviewedAt: \"2026-07-04\"",
      "  notes: \"Exact fixture coverage should be declared explicitly.\""
    ].join("\n")
  );

  const result = await runValidateAcceptance(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /"metrics\.minTextCoverage" must be at most 1/);
  assert.match(result.stderr, /"metrics\.maxUnexpectedWarnings" must be at least 0/);
});

test("validate-acceptance rejects warning allowlist entries outside the public registry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeManifest(root);
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    [
      "id: sample",
      "gate: text-mvp",
      "sourceType: digital",
      "expectedMode: pdf-text",
      "gating: true",
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - invent_missing_values",
      "metrics:",
      "  minTextCoverage: 1",
      "  maxUnexpectedWarnings: 0",
      "snippets:",
      "  - page: 1",
      "    contains: \"Sample\"",
      "structure:",
      "  expected:",
      "    - paragraph",
      "warnings:",
      "  allowed:",
      "    - figure.low_semantic_content",
      "    - legacy_warning_name",
      "assets:",
      "  required: []",
      "review:",
      "  humanReviewedBy: \"codex\"",
      "  reviewedAt: \"2026-07-10\"",
      "  notes: \"Only public warning codes may be allowlisted.\""
    ].join("\n")
  );

  const result = await runValidateAcceptance(root);
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /warnings\.allowed contains unknown public code "legacy_warning_name"/
  );
  assert.doesNotMatch(result.stderr, /figure\.low_semantic_content/);
});

test("validate-acceptance rejects unknown top-level and nested keys", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeManifest(root);
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    validAcceptanceText()
      .replace("metrics:\n", "metrics:\n  minTextCoverag: 1\n")
      .replace("warnings:\n", "warnings:\n  allowd: []\n")
      .concat("\nunexpectedTopLevel: true\n")
  );

  const result = await runValidateAcceptance(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown key "metrics\.minTextCoverag"/);
  assert.match(result.stderr, /unknown key "warnings\.allowd"/);
  assert.match(result.stderr, /unknown key "unexpectedTopLevel"/);
});

test("validate-acceptance rejects structurally invalid YAML", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeManifest(root);
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    validAcceptanceText().replace("id: sample", "id: sample\nid: duplicate")
  );

  const result = await runValidateAcceptance(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /invalid YAML: Map keys must be unique/);
});

test("validate-acceptance requires exactly one manifest entry per file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    validAcceptanceText()
  );

  await writeManifest(root, []);
  const orphan = await runValidateAcceptance(root);
  assert.notEqual(orphan.code, 0);
  assert.match(orphan.stderr, /expected exactly one manifest entry, found 0/);

  await writeManifest(root, [manifestEntry(), manifestEntry()]);
  const duplicate = await runValidateAcceptance(root);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /expected exactly one manifest entry, found 2/);
});

test("validate-acceptance accepts a closed-schema file with one manifest entry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await writeManifest(root);
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    validAcceptanceText()
  );

  const result = await runValidateAcceptance(root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Acceptance criteria valid: 1 file/);
});

function validAcceptanceText() {
  return [
    "id: sample",
    "gate: text-mvp",
    "sourceType: digital",
    "expectedMode: pdf-text",
    "gating: true",
    "must:",
    "  - extract_main_text",
    "mustNot:",
    "  - invent_missing_values",
    "metrics:",
    "  minTextCoverage: 1",
    "  maxUnexpectedWarnings: 0",
    "snippets:",
    "  - page: 1",
    "    contains: \"Sample\"",
    "structure:",
    "  expected:",
    "    - paragraph",
    "warnings:",
    "  allowed:",
    "    - figure.low_semantic_content",
    "assets:",
    "  required: []",
    "review:",
    "  humanReviewedBy: \"reviewer\"",
    "  reviewedAt: \"2026-07-10\"",
    "  notes: \"Closed-schema validation fixture.\""
  ].join("\n");
}

function manifestEntry() {
  return {
    id: "sample",
    acceptanceFile: "corpus/accepted/sample.yaml"
  };
}

function writeManifest(root, entries = [manifestEntry()]) {
  return writeFile(
    path.join(root, "corpus", "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`
  );
}

function runValidateAcceptance(root) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        validateAcceptancePath,
        "--root",
        root,
        "--file",
        "corpus/accepted/sample.yaml"
      ],
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: error?.code ?? 0,
          stdout,
          stderr
        });
      }
    );
  });
}
