import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

const requiredProtocolChecks = Object.freeze([
  {
    id: "read-study-and-plan",
    phrases: [
      "docs/pdf-to-markdown-webassembly-study.md",
      "docs/pdf-to-markdown-implementation-plan.md"
    ]
  },
  {
    id: "tests-before-complete",
    phrases: ["Add or update focused unit, integration, corpus, or QA tests"]
  },
  {
    id: "versioned-contracts",
    phrases: ["versioned IR", "schema tests"]
  },
  {
    id: "performance-before-after",
    phrases: ["before/after benchmark reports", "corpus/reports/"]
  }
]);

export function evaluateAgentCoordinationProtocol(protocolText) {
  const checks = requiredProtocolChecks.map((check) => {
    const missingPhrases = check.phrases.filter((phrase) => !protocolText.includes(phrase));
    return {
      id: check.id,
      passed: missingPhrases.length === 0,
      missingPhrases
    };
  });
  return {
    passed: checks.every((check) => check.passed),
    checks
  };
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
  const protocolPath = path.join(repoRoot, "docs", "agent-coordination.md");
  const summaryPath = readOption("--summary");
  const protocolText = await readFile(protocolPath, "utf8");
  const summary = evaluateAgentCoordinationProtocol(protocolText);

  if (summaryPath) {
    const resolvedSummaryPath = path.resolve(summaryPath);
    await mkdir(path.dirname(resolvedSummaryPath), { recursive: true });
    await writeFile(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  for (const check of summary.checks) {
    const prefix = check.passed ? "PASS" : "FAIL";
    console.log(`${prefix} agent-coordination ${check.id}`);
    for (const phrase of check.missingPhrases) {
      console.error(`${check.id}: missing phrase "${phrase}"`);
    }
  }

  if (!summary.passed) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
