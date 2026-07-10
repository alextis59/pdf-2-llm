import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export async function collectExecutionEnvironment({ repoRoot = process.cwd() } = {}) {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const cpuModel = os.cpus().find((cpu) => cpu.model.trim() !== "")?.model.trim() ?? null;

  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    gitRevision: readGitValue(repoRoot, ["rev-parse", "HEAD"]),
    gitDirty: readGitValue(repoRoot, ["status", "--porcelain"]) !== "",
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuModel
  };
}

function readGitValue(repoRoot, gitArgs) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
