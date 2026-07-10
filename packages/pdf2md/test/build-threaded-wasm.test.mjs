import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const buildScriptPath = fileURLToPath(
  new URL("../../../scripts/build/build-threaded-wasm.mjs", import.meta.url)
);

test("optional threaded WASM failures remove stale packaged artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf2md-threaded-wasm-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const binDir = path.join(root, "bin");
  const cargoPath = path.join(binDir, "cargo");
  const artifactPath = path.join(
    root,
    "packages",
    "pdf2md",
    "src",
    "wasm",
    "pdf2md_core.threaded.wasm"
  );
  const reportPath = path.join(root, ".temp", "qa", "threaded-wasm-build.json");
  await mkdir(binDir, { recursive: true });
  await writeFile(cargoPath, "#!/bin/sh\necho simulated threaded build failure >&2\nexit 23\n");
  await chmod(cargoPath, 0o755);

  for (const required of [false, true]) {
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "stale threaded wasm");

    const result = await runBuild(root, binDir, required);
    assert.equal(result.code, required ? 23 : 0, result.stderr);
    await assert.rejects(() => stat(artifactPath), { code: "ENOENT" });

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "unavailable");
    assert.equal(report.required, required);
    assert.equal(report.exitCode, 23);
    assert.match(report.stderr, /simulated threaded build failure/);
  }
});

function runBuild(root, binDir, required) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [buildScriptPath, ...(required ? ["--required"] : [])],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
        }
      },
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
