import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const manifestPath = path.resolve(
  readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
);
const outputRoot = path.resolve(readOption("--out-root") ?? path.join(repoRoot, "corpus", "baselines"));
const selectedIds = readOptions("--id");
const selectAll = hasFlag("--all");
const dryRun = hasFlag("--dry-run");
const update = hasFlag("--update");
const dpi = parsePositiveInteger(readOption("--dpi") ?? "36", "--dpi");
const firstPage = parsePositiveInteger(readOption("--first-page") ?? "1", "--first-page");
const maxPages = parsePositiveInteger(readOption("--max-pages") ?? "3", "--max-pages");
const explicitLastPage = readOption("--last-page");
const lastPageOption = explicitLastPage
  ? parsePositiveInteger(explicitLastPage, "--last-page")
  : null;
const format = readOption("--format") ?? "png";
const generatedAt = readOption("--generated-at") ?? new Date().toISOString();

if (!["png", "jpeg"].includes(format)) {
  throw new Error(`--format must be png or jpeg, got "${format}"`);
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
  node scripts/corpus/render-previews.mjs --all [--dry-run] [--update]
  node scripts/corpus/render-previews.mjs --id <manifest-id> [--id <manifest-id>]

Options:
  --root <path>          Repository root. Defaults to cwd.
  --manifest <path>      Manifest path. Defaults to corpus/manifest.json.
  --out-root <path>      Preview root. Defaults to corpus/baselines.
  --dpi <n>              Render DPI. Defaults to 36.
  --first-page <n>       First page to render. Defaults to 1.
  --last-page <n>        Last page to render. Overrides --max-pages.
  --max-pages <n>        Maximum pages per PDF when --last-page is omitted. Defaults to 3.
  --format <png|jpeg>    Preview image format. Defaults to png.
  --generated-at <iso>   Timestamp to write into preview index JSON.
  --update               Replace existing previews.
`;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function relativeToRoot(absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function selectManifestEntries(manifest) {
  if (!Array.isArray(manifest.entries)) {
    throw new Error("manifest entries must be an array");
  }

  if (selectAll) {
    return manifest.entries;
  }

  const entriesById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const selected = [];
  for (const id of selectedIds) {
    const entry = entriesById.get(id);
    if (!entry) {
      throw new Error(`unknown manifest id "${id}"`);
    }
    selected.push(entry);
  }
  return selected;
}

function pageRangeForEntry(entry) {
  const availablePages = Number.isInteger(entry.pages) && entry.pages > 0 ? entry.pages : firstPage;
  const requestedLastPage = lastPageOption ?? firstPage + maxPages - 1;
  const lastPage = Math.min(availablePages, requestedLastPage);
  if (lastPage < firstPage) {
    throw new Error(`${entry.id}: first page ${firstPage} is after available page count ${availablePages}`);
  }
  const pages = [];
  for (let page = firstPage; page <= lastPage; page += 1) {
    pages.push(page);
  }
  return pages;
}

function previewPath(outputDir, page) {
  return path.join(outputDir, `page-${String(page).padStart(4, "0")}.${format}`);
}

async function runTool(command, argsForCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argsForCommand, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${command} not found; install poppler-utils to render previews`));
      } else {
        reject(error);
      }
    });
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} failed with status ${status ?? signal}: ${stderr || stdout}`));
      }
    });
  });
}

async function findRenderedPreview(outputDir, prefixBase) {
  const files = await readdir(outputDir);
  const rendered = files
    .filter((file) => file.startsWith(`${prefixBase}-`) && file.endsWith(`.${format}`))
    .sort();
  if (rendered.length !== 1) {
    throw new Error(`expected one rendered preview for ${prefixBase}, found ${rendered.length}`);
  }
  return path.join(outputDir, rendered[0]);
}

async function cleanupTempPreviews(outputDir, prefixBase) {
  let files = [];
  try {
    files = await readdir(outputDir);
  } catch {
    return;
  }
  await Promise.all(
    files
      .filter((file) => file.startsWith(`${prefixBase}-`))
      .map((file) => rm(path.join(outputDir, file), { force: true }))
  );
}

async function renderPreview(entry, page, outputDir) {
  const outputPath = previewPath(outputDir, page);
  if ((await pathExists(outputPath)) && !update) {
    return { page, path: outputPath, status: "exists" };
  }

  await mkdir(outputDir, { recursive: true });
  const prefixBase = `.preview-${process.pid}-${entry.id}-${page}`;
  const prefix = path.join(outputDir, prefixBase);
  const inputPath = path.join(repoRoot, entry.path);

  try {
    await runTool("pdftoppm", [
      "-f",
      String(page),
      "-l",
      String(page),
      "-r",
      String(dpi),
      `-${format}`,
      inputPath,
      prefix
    ]);
    const renderedPath = await findRenderedPreview(outputDir, prefixBase);
    await rename(renderedPath, outputPath);
  } finally {
    await cleanupTempPreviews(outputDir, prefixBase);
  }

  return { page, path: outputPath, status: "rendered" };
}

async function writePreviewIndex(entry, renderedPages, outputDir) {
  const indexPath = path.join(outputDir, "index.json");
  const shouldWriteIndex =
    update ||
    renderedPages.some((preview) => preview.status === "rendered") ||
    !(await pathExists(indexPath));
  if (!shouldWriteIndex) {
    return { path: indexPath, status: "exists" };
  }

  const index = {
    id: entry.id,
    generatedAt,
    renderer: {
      command: "pdftoppm",
      dpi,
      format
    },
    source: {
      path: entry.path,
      sha256: entry.sha256,
      pages: entry.pages
    },
    previews: renderedPages.map((preview) => ({
      page: preview.page,
      path: relativeToRoot(preview.path)
    }))
  };
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return { path: indexPath, status: "wrote" };
}

async function renderEntry(entry) {
  const pages = pageRangeForEntry(entry);
  const outputDir = path.join(outputRoot, entry.id, "previews");

  if (dryRun) {
    console.log(
      `${entry.id}: ${pages.map((page) => `page-${page}`).join(", ")} -> ${relativeToRoot(outputDir)}`
    );
    return;
  }

  const renderedPages = [];
  for (const page of pages) {
    const rendered = await renderPreview(entry, page, outputDir);
    renderedPages.push(rendered);
    console.log(
      `${entry.id}: ${rendered.status} page ${page} -> ${relativeToRoot(rendered.path)}`
    );
  }
  const index = await writePreviewIndex(entry, renderedPages, outputDir);
  console.log(`${entry.id}: ${index.status} ${relativeToRoot(index.path)}`);
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

  const entries = selectManifestEntries(await loadManifest());
  for (const entry of entries) {
    await renderEntry(entry);
  }
}

await main();
