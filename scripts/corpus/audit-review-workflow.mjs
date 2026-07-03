import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

export async function auditAcceptanceReviewWorkflow({ root = process.cwd() } = {}) {
  const repoRoot = path.resolve(root);
  const acceptedDir = path.join(repoRoot, "corpus", "accepted");
  const files = (await readdir(acceptedDir))
    .filter((file) => file.endsWith(".yaml"))
    .sort();
  const cases = [];
  for (const file of files) {
    const text = await readFile(path.join(acceptedDir, file), "utf8");
    const id = readScalar(text, "id");
    const gating = readScalar(text, "gating") === "true";
    if (!gating) {
      continue;
    }
    const checks = await auditGatingCase(repoRoot, id, text);
    cases.push({
      id,
      passed: checks.every((check) => check.passed),
      checks
    });
  }
  return {
    passed: cases.every((entry) => entry.passed),
    gatingCaseCount: cases.length,
    cases
  };
}

async function auditGatingCase(repoRoot, id, text) {
  const oracleDir = path.join(repoRoot, "corpus", "baselines", id, "oracles");
  const previewDir = path.join(repoRoot, "corpus", "baselines", id, "previews");
  const oracleFiles = await listExistingFiles(oracleDir);
  const previewFiles = await listExistingFiles(previewDir);
  const successfulOracleFiles = oracleFiles.filter(
    (file) => file.endsWith(".txt") && !file.endsWith(".error.txt")
  );

  return [
    {
      id: "rendered-previews",
      passed: previewFiles.some((file) => /\.(png|jpe?g)$/i.test(file)) && previewFiles.includes("index.json")
    },
    {
      id: "two-text-oracles",
      passed: successfulOracleFiles.length >= 2
    },
    {
      id: "reading-order-and-structure",
      passed: hasSection(text, "structure") && hasListItem(text, "structure")
    },
    {
      id: "running-content-captions-tables-figures-forms-scripts",
      passed: hasAnySection(text, ["runningContent", "structure", "assets"])
    },
    {
      id: "warnings-recorded",
      passed: hasSection(text, "warnings") && /^\s+allowed:/m.test(text)
    },
    {
      id: "representative-snippets",
      passed: hasSection(text, "snippets") && /contains:\s*"/m.test(text)
    },
    {
      id: "metric-rationale",
      passed: !hasSection(text, "metrics") || readNestedScalar(text, "review", "notes").length >= 40
    },
    {
      id: "review-before-gating",
      passed:
        readNestedScalar(text, "review", "humanReviewedBy").length > 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(readNestedScalar(text, "review", "reviewedAt"))
    }
  ];
}

async function listExistingFiles(directory) {
  try {
    const stats = await stat(directory);
    if (!stats.isDirectory()) {
      return [];
    }
    return await readdir(directory);
  } catch {
    return [];
  }
}

function readScalar(text, key) {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*([^\\n#]+)`, "m"));
  return match ? stripQuotes(match[1].trim()) : "";
}

function readNestedScalar(text, section, key) {
  const pattern = new RegExp(`^${escapeRegExp(section)}:\\n(?:  .+\\n)*?  ${escapeRegExp(key)}:\\s*([^\\n#]+)`, "m");
  const match = text.match(pattern);
  return match ? stripQuotes(match[1].trim()) : "";
}

function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, "");
}

function hasSection(text, section) {
  return new RegExp(`^${escapeRegExp(section)}:`, "m").test(text);
}

function hasAnySection(text, sections) {
  return sections.some((section) => hasSection(text, section));
}

function hasListItem(text, section) {
  const pattern = new RegExp(`^${escapeRegExp(section)}:\\n(?:  .+\\n)*?\\s+-\\s+`, "m");
  return pattern.test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function main() {
  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const summaryPath = readOption("--summary");
  const summary = await auditAcceptanceReviewWorkflow({ root: repoRoot });
  if (summaryPath) {
    const resolvedSummaryPath = path.resolve(summaryPath);
    await mkdir(path.dirname(resolvedSummaryPath), { recursive: true });
    await writeFile(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  for (const entry of summary.cases) {
    for (const check of entry.checks) {
      console.log(`${check.passed ? "PASS" : "FAIL"} ${entry.id} ${check.id}`);
    }
  }
  if (!summary.passed) {
    process.exit(1);
  }
  console.log(`Acceptance review workflow passed: ${summary.gatingCaseCount} gating case(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
