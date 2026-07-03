import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const required = args.includes("--required");
const targetDir = resolve("target/wasm32-threaded");
const buildOutputPath = resolve(targetDir, "wasm32-unknown-unknown/release/pdf2md_core.wasm");
const artifactPath = resolve("packages/pdf2md/src/wasm/pdf2md_core.threaded.wasm");
const reportPath = resolve(".temp/qa/threaded-wasm-build.json");
const rustflags = [
  "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
  "-C link-arg=--shared-memory",
  "-C link-arg=--max-memory=67108864"
].join(" ");

const result = spawnSync(
  "cargo",
  [
    "build",
    "-p",
    "pdf2md-core",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--target-dir",
    targetDir
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      RUSTFLAGS: rustflags
    }
  }
);

let report;
if (result.status === 0) {
  const stats = await stat(buildOutputPath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await copyFile(buildOutputPath, artifactPath);
  report = {
    status: "available",
    artifactPath,
    bytes: stats.size,
    rustflags,
    requirements: ["SharedArrayBuffer", "cross-origin isolation", "WebAssembly shared memory"]
  };
} else {
  report = {
    status: "unavailable",
    required,
    rustflags,
    exitCode: result.status,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stderr: trimOutput(result.stderr)
  };
}

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(`${reportPath}`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (required && report.status !== "available") {
  process.exit(result.status || 1);
}

function trimOutput(output) {
  return String(output ?? "")
    .trim()
    .split("\n")
    .slice(-20)
    .join("\n");
}
