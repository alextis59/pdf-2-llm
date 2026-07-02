import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const manifestPath = path.resolve(
  readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
);
const dryRun = hasFlag("--dry-run");
const selectAll = hasFlag("--all");
const selectedIds = readOptions("--id");

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

function readOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function usage() {
  return `Usage:
  node scripts/corpus/extract-oracles.mjs --all [--dry-run]
  node scripts/corpus/extract-oracles.mjs --id <manifest-id> [--dry-run]

Options:
  --manifest <path>        Manifest path. Defaults to corpus/manifest.json.
  --root <path>            Repository root. Defaults to cwd.
`;
}

async function loadTargets() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = manifest.entries ?? [];
  if (selectAll) {
    return entries;
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return selectedIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`unknown manifest id "${id}"`);
    }
    return entry;
  });
}

async function runPdftotext(entry) {
  const pdfPath = path.join(repoRoot, entry.path);
  return new Promise((resolve, reject) => {
    const child = spawn("pdftotext", [pdfPath, "-"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error("pdftotext is required for oracle extraction"));
      } else {
        reject(error);
      }
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`${entry.id}: pdftotext failed with ${status}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function writeOracle(entry) {
  const text = await runPdftotext(entry);
  const outputDir = path.join(repoRoot, "corpus", "baselines", entry.id, "oracles");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "pdftotext.txt");
  await writeFile(outputPath, text);
  console.log(`${entry.id}: wrote ${path.relative(repoRoot, outputPath)}`);
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  if (!selectAll && selectedIds.length === 0) {
    console.error(usage());
    process.exit(1);
  }

  const targets = await loadTargets();
  if (targets.length === 0) {
    console.log("No PDFs selected for oracle extraction.");
    return;
  }

  if (dryRun) {
    for (const target of targets) {
      console.log(`${target.id}: ${target.path}`);
    }
    console.log(`Dry run selected ${targets.length} PDF(s).`);
    return;
  }

  for (const target of targets) {
    await writeOracle(target);
  }
}

await main();
