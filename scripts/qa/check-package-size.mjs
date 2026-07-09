import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

const defaultBudget = Object.freeze({
  maxPackedBytes: 512 * 1024,
  maxUnpackedBytes: 1024 * 1024,
  maxEntryCount: 48
});
const defaultForbiddenPathPrefixes = Object.freeze(["docs/", ".symphony/"]);

export function evaluatePackageSizeBudget(packageInfo, budget = defaultBudget) {
  return [
    {
      metric: "maxPackedBytes",
      actualMetric: "packedBytes",
      actual: packageInfo.size,
      limit: budget.maxPackedBytes
    },
    {
      metric: "maxUnpackedBytes",
      actualMetric: "unpackedBytes",
      actual: packageInfo.unpackedSize,
      limit: budget.maxUnpackedBytes
    },
    {
      metric: "maxEntryCount",
      actualMetric: "entryCount",
      actual: packageInfo.entryCount,
      limit: budget.maxEntryCount
    }
  ].filter((check) => Number.isFinite(check.limit) && check.actual > check.limit);
}

export function findForbiddenPackageFiles(
  packageInfo,
  forbiddenPathPrefixes = defaultForbiddenPathPrefixes
) {
  return (packageInfo.files ?? [])
    .map((file) => file.path)
    .filter((filePath) =>
      forbiddenPathPrefixes.some(
        (prefix) => filePath === prefix.replace(/\/$/, "") || filePath.startsWith(prefix)
      )
    )
    .sort();
}

export function assertPackageIdentity(packageInfo, expectedName) {
  if (typeof expectedName !== "string" || expectedName.length === 0) {
    return;
  }
  if (packageInfo.name !== expectedName) {
    throw new Error(
      `npm pack measured ${packageInfo.name ?? "an unnamed package"}; expected ${expectedName}`
    );
  }
}

export function createPackageSizeReport(
  packageInfo,
  { budget = defaultBudget, forbiddenPathPrefixes = defaultForbiddenPathPrefixes } = {}
) {
  const violations = evaluatePackageSizeBudget(packageInfo, budget);
  const forbiddenFiles = findForbiddenPackageFiles(packageInfo, forbiddenPathPrefixes);
  return {
    generatedAt: new Date().toISOString(),
    budget,
    forbiddenPathPrefixes,
    package: {
      id: packageInfo.id,
      name: packageInfo.name,
      version: packageInfo.version,
      filename: packageInfo.filename,
      packedBytes: packageInfo.size,
      unpackedBytes: packageInfo.unpackedSize,
      entryCount: packageInfo.entryCount
    },
    largestFiles: [...(packageInfo.files ?? [])]
      .sort((left, right) => right.size - left.size)
      .slice(0, 10)
      .map((file) => ({
        path: file.path,
        bytes: file.size
      })),
    forbiddenFiles,
    violations,
    passed: violations.length === 0 && forbiddenFiles.length === 0
  };
}

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function readIntegerOption(name, fallback) {
  const value = readOption(name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function usage() {
  return `Usage:
  node scripts/qa/check-package-size.mjs [--workspace <name>] [--report <path>]

Options:
  --root <path>                  Repository root. Defaults to cwd.
  --workspace <name>             Optional workspace package to inspect. Defaults to the root package.
  --expected-name <name>         Fail unless npm pack reports this package name.
  --max-packed-bytes <bytes>     Packed tarball budget. Defaults to ${defaultBudget.maxPackedBytes}.
  --max-unpacked-bytes <bytes>   Unpacked package budget. Defaults to ${defaultBudget.maxUnpackedBytes}.
  --max-entry-count <count>      Packed file entry-count budget. Defaults to ${defaultBudget.maxEntryCount}.
`;
}

function runNpmPack({ repoRoot, workspace }) {
  const packArgs = ["pack", "--dry-run", "--json"];
  if (workspace) {
    packArgs.splice(1, 0, "--workspace", workspace);
  }
  const child = spawnSync("npm", packArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });
  if (child.status !== 0) {
    throw new Error(`npm pack failed with exit ${child.status}: ${child.stderr || child.stdout}`);
  }
  const output = child.stdout.trim();
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`npm pack did not return JSON output: ${output}`);
  }
  const parsed = JSON.parse(output.slice(jsonStart));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack JSON output must contain exactly one package");
  }
  return parsed[0];
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const workspace = readOption("--workspace");
  const expectedName = readOption("--expected-name");
  const budget = {
    maxPackedBytes: readIntegerOption("--max-packed-bytes", defaultBudget.maxPackedBytes),
    maxUnpackedBytes: readIntegerOption("--max-unpacked-bytes", defaultBudget.maxUnpackedBytes),
    maxEntryCount: readIntegerOption("--max-entry-count", defaultBudget.maxEntryCount)
  };
  const packageInfo = runNpmPack({ repoRoot, workspace });
  assertPackageIdentity(packageInfo, expectedName);
  const report = createPackageSizeReport(packageInfo, { budget });
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const summary =
    `Package size ${report.passed ? "passed" : "failed"}: ${report.package.name} ` +
    `packed=${report.package.packedBytes} unpacked=${report.package.unpackedBytes} ` +
    `entries=${report.package.entryCount}`;
  console.log(summary);
  if (!report.passed) {
    for (const violation of report.violations) {
      console.error(
        `${violation.actualMetric} ${violation.actual} exceeds ${violation.metric} ${violation.limit}`
      );
    }
    for (const filePath of report.forbiddenFiles) {
      console.error(`forbidden package path included: ${filePath}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
