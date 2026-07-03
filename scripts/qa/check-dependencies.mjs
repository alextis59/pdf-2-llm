import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

const rootPackagePath = path.join(repoRoot, "package.json");
const lockfilePath = path.join(repoRoot, "package-lock.json");
const projectLicense = "0BSD";
const failures = [];

const rootPackage = await readPackageJson(rootPackagePath);
const workspacePackagePaths = await readWorkspacePackagePaths(rootPackage);
const packageEntries = [
  { packagePath: rootPackagePath, packageJson: rootPackage },
  ...(await Promise.all(
    workspacePackagePaths.map(async (packagePath) => ({
      packagePath,
      packageJson: await readPackageJson(packagePath)
    }))
  ))
];
const workspaceNames = new Set(
  packageEntries.map((entry) => entry.packageJson.name).filter(Boolean)
);
const lockfile = await readPackageLock(lockfilePath);

for (const entry of packageEntries) {
  validatePackageLicense(entry, failures);
}

const externalDependencies = collectExternalDependencies(packageEntries, workspaceNames);
const lockedExternalPackages = collectLockedExternalPackages(lockfile, workspaceNames);

if (externalDependencies.length > 0 && !lockfile) {
  failures.push("External dependencies require a committed package-lock.json for vulnerability checks.");
}

for (const item of lockedExternalPackages) {
  if (!hasLicenseMetadata(item.packageInfo)) {
    failures.push(`Locked dependency ${item.name} is missing license metadata in package-lock.json.`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Dependency license check passed: ${packageEntries.length} package manifest(s), ` +
    `${externalDependencies.length} external dependency declaration(s), ` +
    `${lockedExternalPackages.length} locked external package(s).`
);

async function readPackageJson(packagePath) {
  return JSON.parse(await readFile(packagePath, "utf8"));
}

async function readPackageLock(packagePath) {
  try {
    return JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readWorkspacePackagePaths(packageJson) {
  const workspaces = Array.isArray(packageJson.workspaces) ? packageJson.workspaces : [];
  const packagePaths = [];
  for (const workspace of workspaces) {
    if (!workspace.endsWith("/*")) {
      failures.push(`Unsupported workspace pattern ${workspace}; expected a trailing /* pattern.`);
      continue;
    }
    const directory = path.join(repoRoot, workspace.slice(0, -2));
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        packagePaths.push(path.join(directory, entry.name, "package.json"));
      }
    }
  }
  return packagePaths.sort();
}

function validatePackageLicense({ packagePath, packageJson }, failures) {
  const relativePath = path.relative(repoRoot, packagePath) || "package.json";
  if (typeof packageJson.license !== "string" || packageJson.license.trim() === "") {
    failures.push(`${relativePath} is missing a license field.`);
    return;
  }
  if (packageJson.license !== projectLicense) {
    failures.push(`${relativePath} should use project license "${projectLicense}".`);
  }
}

function collectExternalDependencies(packageEntries, workspaceNames) {
  const externalDependencies = [];
  for (const { packagePath, packageJson } of packageEntries) {
    for (const field of dependencyFields) {
      for (const name of Object.keys(packageJson[field] ?? {})) {
        if (!workspaceNames.has(name)) {
          externalDependencies.push({
            name,
            field,
            packagePath
          });
        }
      }
    }
  }
  return externalDependencies;
}

function collectLockedExternalPackages(lockfile, workspaceNames) {
  if (!lockfile?.packages) {
    return [];
  }

  const packages = [];
  for (const [lockPath, packageInfo] of Object.entries(lockfile.packages)) {
    const name = packageNameFromLockPath(lockPath);
    if (!name || workspaceNames.has(name) || packageInfo.link === true) {
      continue;
    }
    packages.push({
      name,
      packageInfo
    });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function packageNameFromLockPath(lockPath) {
  if (!lockPath.startsWith("node_modules/")) {
    return null;
  }
  const parts = lockPath.split("/");
  if (parts[1]?.startsWith("@")) {
    return parts[2] ? `${parts[1]}/${parts[2]}` : null;
  }
  return parts[1] ?? null;
}

function hasLicenseMetadata(packageInfo) {
  return (
    (typeof packageInfo.license === "string" && packageInfo.license.trim() !== "") ||
    Array.isArray(packageInfo.licenses)
  );
}
