import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const generateScriptPath = fileURLToPath(
  new URL("../../../scripts/corpus/generate-fixtures.mjs", import.meta.url)
);
const generatedSkipReason = "Generated fixture requires explicit human review before gating.";

test("fixture generation requires explicit review and never overwrites approved criteria", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-generate-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "corpus"), { recursive: true });
  await writeFile(
    path.join(root, "corpus", "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`
  );

  const firstRun = await runGenerator(root);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const acceptanceDir = path.join(root, "corpus", "accepted");
  const acceptanceFiles = (await readdir(acceptanceDir)).filter((file) => file.endsWith(".yaml"));
  assert.ok(acceptanceFiles.length > 0);
  for (const file of acceptanceFiles) {
    const acceptance = parse(await readFile(path.join(acceptanceDir, file), "utf8"));
    assert.equal(acceptance.gating, false, file);
    assert.equal(acceptance.skipReason, generatedSkipReason, file);
    assert.equal(acceptance.review.humanReviewedBy, "", file);
    assert.equal(acceptance.review.reviewedAt, "", file);
  }

  const samplePath = path.join(acceptanceDir, "synthetic-simple-text.yaml");
  const unreviewedText = await readFile(samplePath, "utf8");
  const approvedText = unreviewedText
    .replace(`gating: false\nskipReason: "${generatedSkipReason}"\n`, "gating: true\n")
    .replace('humanReviewedBy: ""', 'humanReviewedBy: "reviewer"')
    .replace('reviewedAt: ""', 'reviewedAt: "2026-07-10"')
    .replace("Exact-output generated fixture", "Human-reviewed exact-output fixture");
  await writeFile(samplePath, approvedText);

  const secondRun = await runGenerator(root);
  assert.equal(secondRun.code, 0, secondRun.stderr);
  const preservedText = await readFile(samplePath, "utf8");
  assert.equal(preservedText, approvedText);
  const preserved = parse(preservedText);
  assert.equal(preserved.gating, true);
  assert.equal(preserved.review.humanReviewedBy, "reviewer");
  assert.equal(preserved.review.reviewedAt, "2026-07-10");
  assert.match(preserved.review.notes, /Human-reviewed exact-output fixture/);

  await writeFile(
    samplePath,
    (await readFile(samplePath, "utf8")).replace("minTextCoverage: 1", "minTextCoverage: 0.9")
  );
  const changedContractRun = await runGenerator(root);
  assert.equal(changedContractRun.code, 0, changedContractRun.stderr);
  const stillPreserved = parse(await readFile(samplePath, "utf8"));
  assert.equal(stillPreserved.metrics.minTextCoverage, 0.9);
  assert.equal(stillPreserved.gating, true);
  assert.equal(stillPreserved.review.humanReviewedBy, "reviewer");
  assert.equal(stillPreserved.review.reviewedAt, "2026-07-10");
});

function runGenerator(root) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [generateScriptPath],
      { cwd: root, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    );
  });
}
