import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultRoots = Object.freeze(["scripts", "packages"]);
const skippedDirectories = new Set([
  ".git",
  ".temp",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);

export function shouldSkipDirectory(name) {
  return skippedDirectories.has(name);
}

export function isLintTarget(filePath) {
  return filePath.endsWith(".mjs");
}

export async function collectLintTargets({ repoRoot = defaultRepoRoot, roots = defaultRoots } = {}) {
  const targets = [];
  for (const root of roots) {
    await collectFromDirectory(path.join(repoRoot, root), repoRoot, targets);
  }
  return targets.sort();
}

export function runSyntaxLint(targets, { repoRoot = defaultRepoRoot } = {}) {
  const failures = [];
  for (const target of targets) {
    const absolutePath = path.join(repoRoot, target);
    const result = spawnSync(process.execPath, ["--check", absolutePath], {
      encoding: "utf8"
    });
    if (result.status !== 0) {
      failures.push({
        path: target,
        status: result.status,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      });
    }
  }

  return createLintReport({ checked: targets.length, failures });
}

export function createLintReport({ checked, failures }) {
  return {
    checked,
    failed: failures.length,
    passed: failures.length === 0,
    failures
  };
}

async function collectFromDirectory(directoryPath, repoRoot, targets) {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) {
        await collectFromDirectory(path.join(directoryPath, entry.name), repoRoot, targets);
      }
      continue;
    }

    if (entry.isFile() && isLintTarget(entry.name)) {
      targets.push(toPortablePath(path.relative(repoRoot, path.join(directoryPath, entry.name))));
    }
  }
}

function toPortablePath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function main() {
  const targets = await collectLintTargets();
  if (targets.length === 0) {
    console.error("No JavaScript module files found to lint.");
    process.exit(1);
  }

  const report = runSyntaxLint(targets);
  if (!report.passed) {
    for (const failure of report.failures) {
      console.error(`Syntax check failed: ${failure.path}`);
      if (failure.stdout) {
        console.error(failure.stdout);
      }
      if (failure.stderr) {
        console.error(failure.stderr);
      }
    }
    process.exit(1);
  }

  console.log(`Syntax lint passed for ${report.checked} JavaScript module files.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
