import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectLintTargets, createLintReport } from "../../../scripts/qa/lint.mjs";

test("collectLintTargets discovers module files and skips generated directories", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pdf2md-lint-"));
  t.after(() => rm(repoRoot, { force: true, recursive: true }));

  await mkdir(path.join(repoRoot, "scripts", "qa"), { recursive: true });
  await mkdir(path.join(repoRoot, "packages", "pdf2md", "node_modules"), { recursive: true });
  await writeFile(path.join(repoRoot, "scripts", "qa", "one.mjs"), "export {};\n");
  await writeFile(path.join(repoRoot, "packages", "pdf2md", "two.mjs"), "export {};\n");
  await writeFile(path.join(repoRoot, "packages", "pdf2md", "node_modules", "skip.mjs"), "export {};\n");
  await writeFile(path.join(repoRoot, "packages", "pdf2md", "ignored.txt"), "not JavaScript\n");

  assert.deepEqual(await collectLintTargets({ repoRoot }), [
    "packages/pdf2md/two.mjs",
    "scripts/qa/one.mjs"
  ]);
});

test("createLintReport summarizes failures", () => {
  assert.deepEqual(
    createLintReport({
      checked: 2,
      failures: [{ path: "scripts/broken.mjs", status: 1, stdout: "", stderr: "SyntaxError" }]
    }),
    {
      checked: 2,
      failed: 1,
      passed: false,
      failures: [{ path: "scripts/broken.mjs", status: 1, stdout: "", stderr: "SyntaxError" }]
    }
  );
});
