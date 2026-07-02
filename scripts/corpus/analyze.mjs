import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
const selectedFiles = readOptions("--file");
const skipTools = hasFlag("--no-tools");
const maxToolBytes = Number.parseInt(readOption("--max-tool-bytes") ?? `${5 * 1024 * 1024}`, 10);
const analyzedAt = readOption("--analyzed-at") ?? new Date().toISOString();

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
  node scripts/corpus/analyze.mjs --all [--dry-run] [--no-tools]
  node scripts/corpus/analyze.mjs --id <manifest-id> [--dry-run] [--no-tools]
  node scripts/corpus/analyze.mjs --file <path> [--id <id>] [--dry-run] [--no-tools]

Options:
  --manifest <path>        Manifest path. Defaults to corpus/manifest.json.
  --root <path>            Repository root. Defaults to cwd.
  --max-tool-bytes <n>     Maximum captured bytes per external tool.
  --analyzed-at <iso>      Timestamp to write into analysis JSON.
`;
}

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : null;
}

function collectPageBoxes(text) {
  const boxes = [];
  const pattern =
    /\/(MediaBox|CropBox|BleedBox|TrimBox|ArtBox)\s*\[\s*([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s*\]/g;
  for (const match of text.matchAll(pattern)) {
    boxes.push({
      type: match[1],
      values: match.slice(2, 6).map((value) => Number.parseFloat(value))
    });
    if (boxes.length >= 100) {
      break;
    }
  }
  return boxes;
}

function collectRotations(text) {
  return [...new Set([...text.matchAll(/\/Rotate\s+([-+]?\d+)/g)].map((match) => Number.parseInt(match[1], 10)))];
}

function sanitizeId(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "incoming-pdf";
}

function relativeToRoot(absolutePath) {
  const relativePath = path.relative(repoRoot, absolutePath);
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

function selectManifestEntries(manifest) {
  if (!Array.isArray(manifest.entries)) {
    throw new Error("manifest entries must be an array");
  }

  if (selectAll) {
    return manifest.entries.map((entry) => ({
      id: entry.id,
      path: path.join(repoRoot, entry.path),
      manifestEntry: entry
    }));
  }

  const selected = [];
  const entriesById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  for (const id of selectedIds) {
    const entry = entriesById.get(id);
    if (!entry) {
      throw new Error(`unknown manifest id "${id}"`);
    }
    selected.push({
      id: entry.id,
      path: path.join(repoRoot, entry.path),
      manifestEntry: entry
    });
  }
  return selected;
}

function selectFileEntries() {
  if (selectedFiles.length === 0) {
    return [];
  }

  if (selectedFiles.length > 1 && selectedIds.length > 0 && selectedIds.length !== selectedFiles.length) {
    throw new Error("when multiple --file values are used, --id must be omitted or provided once per file");
  }

  return selectedFiles.map((filePath, index) => {
    const absolutePath = path.resolve(repoRoot, filePath);
    return {
      id: selectedIds[index] ?? sanitizeId(filePath),
      path: absolutePath,
      manifestEntry: null
    };
  });
}

function analyzeStaticBytes(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("latin1");
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1");
  const text = bytes.toString("latin1");

  const textShowOps =
    countMatches(text, /(?:\s|\])Tj\b/g) +
    countMatches(text, /(?:\s|\])TJ\b/g) +
    countMatches(text, /'\s/g) +
    countMatches(text, /"\s/g);
  const beginTextOps = countMatches(text, /(?:^|\s)BT(?:\s|$)/g);
  const endTextOps = countMatches(text, /(?:^|\s)ET(?:\s|$)/g);
  const imageXObjects = countMatches(text, /\/Subtype\s*\/Image\b/g);
  const pathOperators =
    countMatches(text, /(?:^|\s)(?:m|l|c|v|y|h|re|S|s|f|F|B|b|n|W)(?:\s|$)/g);

  const pageObjects = countMatches(text, /\/Type\s*\/Page\b(?!s)/g);
  const fontObjects = countMatches(text, /\/Font\b/g);
  const toUnicodeMaps = countMatches(text, /\/ToUnicode\b/g);
  const encodings = countMatches(text, /\/Encoding\b/g);
  const cidFonts = countMatches(text, /\/CIDFontType[02]\b/g);
  const cidSystemInfo = countMatches(text, /\/CIDSystemInfo\b/g);
  const pageBoxes = collectPageBoxes(text);
  const rotations = collectRotations(text);
  const estimatedPages = pageObjects > 0 ? pageObjects : 1;

  return {
    header: {
      pdfVersion: firstMatch(head, /%PDF-(\d\.\d)/),
      hasPdfHeader: head.includes("%PDF-"),
      hasEofMarker: tail.includes("%%EOF"),
      startxrefCount: countMatches(text, /startxref/g)
    },
    structure: {
      pageObjectCount: pageObjects,
      pageBoxes,
      rotations,
      classicXrefCount: countMatches(text, /(?:^|\n)xref(?:\r?\n|\s)/g),
      xrefStreamCount: countMatches(text, /\/Type\s*\/XRef\b/g),
      objectStreamCount: countMatches(text, /\/ObjStm\b/g),
      linearizedHint: /\/Linearized\b/.test(head) || /\/Linearized\b/.test(text.slice(0, 65536)),
      encrypted: /\/Encrypt\b/.test(text)
    },
    documentFeatures: {
      tagged: /\/StructTreeRoot\b/.test(text),
      roleMap: /\/RoleMap\b/.test(text),
      acroForm: /\/AcroForm\b/.test(text),
      xfa: /\/XFA\b/.test(text),
      annotations: /\/Annots\b/.test(text),
      outlines: /\/Outlines\b/.test(text),
      attachments: /\/EmbeddedFiles\b/.test(text),
      signatures: /\/Sig\b/.test(text),
      metadata: /\/Metadata\b/.test(text)
    },
    contentSignals: {
      beginTextOps,
      endTextOps,
      textShowOps,
      imageXObjects,
      pathOperators,
      fontObjects,
      cidFonts,
      cidSystemInfo,
      toUnicodeMaps,
      encodings,
      missingToUnicodeLikely: fontObjects > 0 && toUnicodeMaps === 0,
      estimatedTextShowOpsPerPage: textShowOps / estimatedPages,
      imageDominantLikely: imageXObjects > 0 && textShowOps < imageXObjects,
      pathHeavyLikely: pathOperators > Math.max(textShowOps * 4, 50)
    }
  };
}

function parsePdfInfoPages(stdout) {
  const match = stdout.match(/^Pages:\s+(\d+)$/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function runTool(command, argsForCommand, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(command, argsForCommand, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    function collect(current, chunk) {
      if (current.length >= maxToolBytes) {
        truncated = true;
        return current;
      }
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxToolBytes) {
        truncated = true;
        return next.subarray(0, maxToolBytes);
      }
      return next;
    }

    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        resolve({ available: false, command, args: argsForCommand, error: "not found" });
      } else {
        resolve({ available: true, command, args: argsForCommand, error: error.message });
      }
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        available: true,
        command,
        args: argsForCommand,
        status,
        signal,
        truncated,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      });
    });
  });
}

async function runExternalTools(filePath) {
  if (skipTools) {
    return {};
  }

  const tools = {
    pdfinfo: await runTool("pdfinfo", [filePath]),
    pdfimages: await runTool("pdfimages", ["-list", filePath]),
    qpdfJson: await runTool("qpdf", ["--json", filePath]),
    mutoolInfo: await runTool("mutool", ["info", filePath])
  };

  return tools;
}

function summarizeTools(tools) {
  const summary = {};
  for (const [name, result] of Object.entries(tools)) {
    summary[name] = {
      available: result.available === true,
      status: result.status ?? null,
      signal: result.signal ?? null,
      truncated: result.truncated === true
    };
  }
  return summary;
}

async function writeToolOutputs(id, tools) {
  const outputDir = path.join(repoRoot, "corpus", "baselines", id, "tools");
  await mkdir(outputDir, { recursive: true });
  const paths = {};

  for (const [name, result] of Object.entries(tools)) {
    const toolPath = path.join(outputDir, `${name}.json`);
    await writeFile(toolPath, `${JSON.stringify(result, null, 2)}\n`);
    paths[name] = relativeToRoot(toolPath);
  }

  return paths;
}

async function analyzePdf(target) {
  const fileStat = await stat(target.path);
  if (!fileStat.isFile()) {
    throw new Error(`${target.id}: ${target.path} is not a file`);
  }

  const bytes = await readFile(target.path);
  const staticAnalysis = analyzeStaticBytes(bytes);
  const tools = await runExternalTools(target.path);
  const toolOutputPaths = dryRun ? {} : await writeToolOutputs(target.id, tools);
  const pdfInfoPages = tools.pdfinfo?.available && tools.pdfinfo.status === 0
    ? parsePdfInfoPages(tools.pdfinfo.stdout)
    : null;

  return {
    id: target.id,
    analyzedAt,
    path: relativeToRoot(target.path),
    bytes: bytes.length,
    sha256: sha256(bytes),
    manifest: target.manifestEntry
      ? {
          kind: target.manifestEntry.kind,
          features: target.manifestEntry.features ?? [],
          redistributable: target.manifestEntry.redistributable,
          acceptanceFile: target.manifestEntry.acceptanceFile
        }
      : null,
    pdfVersion: staticAnalysis.header.pdfVersion,
    pages: {
      staticPageObjectCount: staticAnalysis.structure.pageObjectCount,
      pdfinfo: pdfInfoPages
    },
    ...staticAnalysis,
    externalTools: summarizeTools(tools),
    toolOutputs: toolOutputPaths,
    notes: [
      "Static byte-pattern analysis is a triage aid, not a correctness oracle.",
      "External tool outputs are baselines for review and must not be treated as ground truth without acceptance criteria."
    ]
  };
}

async function writeAnalysis(id, analysis) {
  const outputDir = path.join(repoRoot, "corpus", "baselines", id);
  await mkdir(outputDir, { recursive: true });
  const analysisPath = path.join(outputDir, "analysis.json");
  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
  return analysisPath;
}

async function writeInventoryReport(analyses) {
  const reportPath = path.join(repoRoot, "corpus", "reports", "corpus-inventory.md");
  const lines = [
    "# Corpus Inventory",
    "",
    "Generated by `scripts/corpus/analyze.mjs`.",
    "",
    `Entries analyzed: ${analyses.length}`,
    "",
    "| ID | Bytes | SHA-256 | PDF version | Pages | Features |",
    "| --- | ---: | --- | --- | ---: | --- |"
  ];

  for (const analysis of analyses) {
    const detectedFeatures = Object.entries(analysis.documentFeatures)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    const manifestFeatures = analysis.manifest?.features ?? [];
    const features = [...new Set([...manifestFeatures, ...detectedFeatures])].join(", ");
    lines.push(
      `| ${analysis.id} | ${analysis.bytes} | ${analysis.sha256} | ${analysis.pdfVersion ?? "unknown"} | ${analysis.pages.pdfinfo ?? analysis.pages.staticPageObjectCount ?? 0} | ${features || "none detected"} |`
    );
  }

  if (analyses.length === 0) {
    lines.push("| _none_ | 0 |  | unknown | 0 | none |");
  }

  await writeFile(reportPath, `${lines.join("\n")}\n`);
  return reportPath;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const fileTargets = selectFileEntries();
  let manifestTargets = [];

  if (fileTargets.length === 0) {
    if (!selectAll && selectedIds.length === 0) {
      console.error(usage());
      process.exit(1);
    }
    manifestTargets = selectManifestEntries(await loadManifest());
  }

  const targets = fileTargets.length > 0 ? fileTargets : manifestTargets;

  if (targets.length === 0) {
    console.log("No PDFs selected for analysis.");
    if (!dryRun && fileTargets.length === 0) {
      const reportPath = await writeInventoryReport([]);
      console.log(`Wrote ${relativeToRoot(reportPath)}`);
    }
    return;
  }

  if (dryRun) {
    for (const target of targets) {
      console.log(`${target.id}: ${relativeToRoot(target.path)}`);
    }
    console.log(`Dry run selected ${targets.length} PDF(s).`);
    return;
  }

  const analyses = [];
  for (const target of targets) {
    const analysis = await analyzePdf(target);
    const analysisPath = await writeAnalysis(target.id, analysis);
    analyses.push(analysis);
    console.log(`${target.id}: wrote ${relativeToRoot(analysisPath)}`);
  }

  if (fileTargets.length === 0) {
    const reportPath = await writeInventoryReport(analyses);
    console.log(`Wrote ${relativeToRoot(reportPath)}`);
  }
}

await main();
