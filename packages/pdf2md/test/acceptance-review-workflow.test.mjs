import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditAcceptanceReviewWorkflow } from "../../../scripts/corpus/audit-review-workflow.mjs";

test("auditAcceptanceReviewWorkflow passes complete gating evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-review-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await mkdir(path.join(root, "corpus", "baselines", "sample", "oracles"), { recursive: true });
  await mkdir(path.join(root, "corpus", "baselines", "sample", "previews"), { recursive: true });
  await writeFile(path.join(root, "corpus", "baselines", "sample", "oracles", "pdftotext.txt"), "Sample\n");
  await writeFile(path.join(root, "corpus", "baselines", "sample", "oracles", "pypdf.txt"), "Sample\n");
  await writeFile(path.join(root, "corpus", "baselines", "sample", "previews", "page-0001.png"), "");
  await writeFile(path.join(root, "corpus", "baselines", "sample", "previews", "index.json"), "{}\n");
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    [
      "id: sample",
      "gating: true",
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
      "  reviewedAt: \"2026-07-03\"",
      "  notes: \"Metric thresholds are exact because this reviewed fixture is deterministic.\""
    ].join("\n")
  );

  const summary = await auditAcceptanceReviewWorkflow({ root });
  assert.equal(summary.passed, true);
  assert.equal(summary.gatingCaseCount, 1);
});

test("auditAcceptanceReviewWorkflow fails missing second oracle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-review-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await mkdir(path.join(root, "corpus", "baselines", "sample", "oracles"), { recursive: true });
  await mkdir(path.join(root, "corpus", "baselines", "sample", "previews"), { recursive: true });
  await writeFile(path.join(root, "corpus", "baselines", "sample", "oracles", "pdftotext.txt"), "Sample\n");
  await writeFile(path.join(root, "corpus", "baselines", "sample", "previews", "page-0001.png"), "");
  await writeFile(path.join(root, "corpus", "baselines", "sample", "previews", "index.json"), "{}\n");
  await writeFile(
    path.join(root, "corpus", "accepted", "sample.yaml"),
    [
      "id: sample",
      "gating: true",
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
      "  reviewedAt: \"2026-07-03\"",
      "  notes: \"No metrics.\""
    ].join("\n")
  );

  const summary = await auditAcceptanceReviewWorkflow({ root });
  assert.equal(summary.passed, false);
  assert.equal(
    summary.cases[0].checks.find((check) => check.id === "two-text-oracles").passed,
    false
  );
});
