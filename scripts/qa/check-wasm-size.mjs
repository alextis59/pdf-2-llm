import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

const defaultWasmPath = "packages/pdf2md/src/wasm/pdf2md_core.wasm";
const defaultBudget = Object.freeze({
  maxBytes: 256 * 1024
});

export function evaluateWasmSizeBudget(wasmInfo, budget = defaultBudget) {
  return [
    {
      metric: "maxBytes",
      actualMetric: "bytes",
      actual: wasmInfo.bytes,
      limit: budget.maxBytes
    }
  ].filter((check) => Number.isFinite(check.limit) && check.actual > check.limit);
}

export function createWasmSizeReport(wasmInfo, { budget = defaultBudget } = {}) {
  const violations = evaluateWasmSizeBudget(wasmInfo, budget);
  return {
    generatedAt: new Date().toISOString(),
    budget,
    wasm: {
      path: wasmInfo.path,
      bytes: wasmInfo.bytes
    },
    violations,
    passed: violations.length === 0
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
  node scripts/qa/check-wasm-size.mjs [--wasm <path>] [--report <path>]

Options:
  --root <path>              Repository root. Defaults to cwd.
  --wasm <path>              WASM file path. Defaults to ${defaultWasmPath}.
  --max-bytes <bytes>        WASM artifact budget. Defaults to ${defaultBudget.maxBytes}.
`;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const wasmPath = path.resolve(repoRoot, readOption("--wasm") ?? defaultWasmPath);
  const budget = {
    maxBytes: readIntegerOption("--max-bytes", defaultBudget.maxBytes)
  };
  const wasmStats = await stat(wasmPath);
  if (!wasmStats.isFile()) {
    throw new Error(`WASM artifact is not a file: ${wasmPath}`);
  }

  const report = createWasmSizeReport(
    {
      path: path.relative(repoRoot, wasmPath),
      bytes: wasmStats.size
    },
    { budget }
  );
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(
    `WASM size ${report.passed ? "passed" : "failed"}: ${report.wasm.path} ` +
      `bytes=${report.wasm.bytes}`
  );
  if (!report.passed) {
    for (const violation of report.violations) {
      console.error(
        `${violation.actualMetric} ${violation.actual} exceeds ${violation.metric} ${violation.limit}`
      );
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
