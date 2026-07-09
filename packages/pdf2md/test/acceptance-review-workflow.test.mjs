import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditAcceptanceReviewWorkflow } from "../../../scripts/corpus/audit-review-workflow.mjs";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

test("auditAcceptanceReviewWorkflow passes complete gating evidence", async (t) => {
  const root = await createReviewFixture(t);
  const summary = await auditAcceptanceReviewWorkflow({ root });
  assert.equal(summary.passed, true);
  assert.equal(summary.gatingCaseCount, 1);
  assert.deepEqual(
    summary.cases[0].checks.find((check) => check.id === "rendered-previews").details,
    {
      declaredPreviews: 1,
      validPreviews: 1,
      failures: []
    }
  );
});

test("auditAcceptanceReviewWorkflow fails missing second oracle", async (t) => {
  const root = await createReviewFixture(t, { includeSecondOracle: false });

  const summary = await auditAcceptanceReviewWorkflow({ root });
  assert.equal(summary.passed, false);
  assert.equal(
    summary.cases[0].checks.find((check) => check.id === "two-text-oracles").passed,
    false
  );
});

test("auditAcceptanceReviewWorkflow rejects an empty declared preview", async (t) => {
  const root = await createReviewFixture(t, { previewBytes: Buffer.alloc(0) });

  const summary = await auditAcceptanceReviewWorkflow({ root });
  const previewCheck = summary.cases[0].checks.find(
    (check) => check.id === "rendered-previews"
  );
  assert.equal(summary.passed, false);
  assert.equal(previewCheck.passed, false);
  assert.deepEqual(previewCheck.details, {
    declaredPreviews: 1,
    validPreviews: 0,
    failures: ["preview-1: invalid-file-size-0"]
  });
});

async function createReviewFixture(
  t,
  { includeSecondOracle = true, previewBytes = onePixelPng } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-review-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus", "accepted"), { recursive: true });
  await mkdir(path.join(root, "corpus", "baselines", "sample", "oracles"), { recursive: true });
  await mkdir(path.join(root, "corpus", "baselines", "sample", "previews"), { recursive: true });
  await writeFile(path.join(root, "corpus", "baselines", "sample", "oracles", "pdftotext.txt"), "Sample\n");
  if (includeSecondOracle) {
    await writeFile(path.join(root, "corpus", "baselines", "sample", "oracles", "pypdf.txt"), "Sample\n");
  }
  await writeFile(
    path.join(root, "corpus", "baselines", "sample", "previews", "page-0001.png"),
    previewBytes
  );
  await writeFile(
    path.join(root, "corpus", "baselines", "sample", "previews", "index.json"),
    `${JSON.stringify(
      {
        previews: [
          {
            page: 1,
            path: "corpus/baselines/sample/previews/page-0001.png"
          }
        ]
      },
      null,
      2
    )}\n`
  );
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
      "  notes: \"Metric thresholds are exact because this reviewed fixture is deterministic.\""
    ].join("\n")
  );

  return root;
}
