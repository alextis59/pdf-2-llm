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

test("validate-acceptance range-checks minTextCoverage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-acceptance-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
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
  assert.match(result.stderr, /metrics\.minTextCoverage must be a number from 0 to 1/);
});

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
