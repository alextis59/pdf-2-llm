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
const selectedTools = readOptions("--tool");
const oracleTools = selectedTools.length > 0 ? selectedTools : ["pdftotext"];
const supportedTools = new Set(["pdftotext", "pypdf"]);
const allowToolFailures = hasFlag("--allow-tool-failures");

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
  node scripts/corpus/extract-oracles.mjs --all [--dry-run] [--tool pdftotext] [--tool pypdf]
  node scripts/corpus/extract-oracles.mjs --id <manifest-id> [--dry-run] [--tool pdftotext] [--tool pypdf]

Options:
  --manifest <path>        Manifest path. Defaults to corpus/manifest.json.
  --root <path>            Repository root. Defaults to cwd.
  --tool <name>            Oracle tool to run. Repeatable. Defaults to pdftotext.
  --allow-tool-failures    Write <tool>.error.txt and continue when a tool fails.
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

async function runPypdf(entry) {
  const pdfPath = path.join(repoRoot, entry.path);
  const script = [
    "import sys",
    "import warnings",
    "warnings.filterwarnings('ignore')",
    "from pypdf import PdfReader",
    "try:",
    "    reader = PdfReader(sys.argv[1])",
    "    for index, page in enumerate(reader.pages):",
    "        if index:",
    "            print('\\f')",
    "        print(page.extract_text() or '')",
    "except Exception as exc:",
    "    print(f'{exc.__class__.__name__}: {exc}', file=sys.stderr)",
    "    sys.exit(1)"
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", script, pdfPath], {
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
        reject(new Error("python3 is required for pypdf oracle extraction"));
      } else {
        reject(error);
      }
    });
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`${entry.id}: pypdf failed with ${status}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function oracleRunner(tool) {
  if (tool === "pdftotext") {
    return runPdftotext;
  }
  if (tool === "pypdf") {
    return runPypdf;
  }
  throw new Error(`unsupported oracle tool "${tool}"`);
}

async function writeOracle(entry) {
  const outputDir = path.join(repoRoot, "corpus", "baselines", entry.id, "oracles");
  await mkdir(outputDir, { recursive: true });
  for (const tool of oracleTools) {
    try {
      const text = await oracleRunner(tool)(entry);
      const outputPath = path.join(outputDir, `${tool}.txt`);
      await writeFile(outputPath, normalizeTextOutput(text));
      console.log(`${entry.id}: wrote ${path.relative(repoRoot, outputPath)}`);
    } catch (error) {
      if (!allowToolFailures) {
        throw error;
      }
      const outputPath = path.join(outputDir, `${tool}.error.txt`);
      await writeFile(outputPath, normalizeTextOutput(formatToolError(error)));
      console.log(`${entry.id}: wrote ${path.relative(repoRoot, outputPath)}`);
    }
  }
}

function normalizeTextOutput(text) {
  return `${String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "")}\n`;
}

function formatToolError(error) {
  return String(error?.message ?? error)
    .replaceAll(repoRoot, "<repo>")
    .replace(/file:\/\/<repo>/g, "file://<repo>")
    .replace(/\/home\/[^\s:)]+/g, "<home>")
    .replace(/line \d+/g, "line <n>");
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
  for (const tool of oracleTools) {
    if (!supportedTools.has(tool)) {
      throw new Error(`unsupported oracle tool "${tool}"`);
    }
  }

  const targets = await loadTargets();
  if (targets.length === 0) {
    console.log("No PDFs selected for oracle extraction.");
    return;
  }

  if (dryRun) {
    for (const target of targets) {
      console.log(`${target.id}: ${target.path} tools=${oracleTools.join(",")}`);
    }
    console.log(`Dry run selected ${targets.length} PDF(s).`);
    return;
  }

  for (const target of targets) {
    await writeOracle(target);
  }
}

await main();
