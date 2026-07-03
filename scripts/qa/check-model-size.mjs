import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

const defaultWorkspace = "@pdf-2-llm/pdf2md";
const modelExtensions = Object.freeze([
  ".bin",
  ".gguf",
  ".mlmodel",
  ".onnx",
  ".ort",
  ".pb",
  ".pt",
  ".pth",
  ".safetensors",
  ".tflite",
  ".traineddata",
  ".weights"
]);
const defaultModelRoots = Object.freeze([
  "packages/pdf2md/models",
  "packages/pdf2md/src/models",
  "models",
  "public/models"
]);
const defaultBenchmarkReports = Object.freeze([
  ".temp/qa/ocr-throughput-benchmark.json",
  "corpus/reports/ocr-throughput-benchmark.json",
  "corpus/reports/webgpu-benchmark.json"
]);
const defaultBudget = Object.freeze({
  maxPackagedModelBytes: 0,
  maxPackagedModelFiles: 0,
  maxRepositoryModelBytes: 0,
  maxRepositoryModelFiles: 0,
  maxDeclaredLazyModelFiles: 8
});

export function evaluateModelSizeBudget(report, budget = defaultBudget) {
  return [
    {
      metric: "maxPackagedModelBytes",
      actualMetric: "packagedModelBytes",
      actual: report.package.packagedModelBytes,
      limit: budget.maxPackagedModelBytes
    },
    {
      metric: "maxPackagedModelFiles",
      actualMetric: "packagedModelFileCount",
      actual: report.package.packagedModelFileCount,
      limit: budget.maxPackagedModelFiles
    },
    {
      metric: "maxRepositoryModelBytes",
      actualMetric: "repositoryModelBytes",
      actual: report.repository.modelBytes,
      limit: budget.maxRepositoryModelBytes
    },
    {
      metric: "maxRepositoryModelFiles",
      actualMetric: "repositoryModelFileCount",
      actual: report.repository.modelFileCount,
      limit: budget.maxRepositoryModelFiles
    },
    {
      metric: "maxDeclaredLazyModelFiles",
      actualMetric: "declaredLazyModelFileCount",
      actual: report.declaredLazyModels.count,
      limit: budget.maxDeclaredLazyModelFiles
    }
  ].filter((check) => Number.isFinite(check.limit) && check.actual > check.limit);
}

export function createModelSizeReport(
  {
    packageInfo,
    repositoryModelFiles = [],
    declaredLazyModelFiles = [],
    modelRoots = defaultModelRoots,
    benchmarkReports = defaultBenchmarkReports
  },
  { budget = defaultBudget } = {}
) {
  const packagedModelFiles = packageModelFiles(packageInfo);
  const repositoryFiles = sortedModelFiles(repositoryModelFiles);
  const declaredFiles = [...declaredLazyModelFiles].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const report = {
    generatedAt: new Date().toISOString(),
    budget,
    package: {
      id: packageInfo.id,
      name: packageInfo.name,
      version: packageInfo.version,
      filename: packageInfo.filename,
      packagedModelBytes: sumBytes(packagedModelFiles),
      packagedModelFileCount: packagedModelFiles.length,
      modelFiles: packagedModelFiles
    },
    repository: {
      scannedRoots: [...modelRoots],
      modelBytes: sumBytes(repositoryFiles),
      modelFileCount: repositoryFiles.length,
      modelFiles: repositoryFiles
    },
    declaredLazyModels: {
      reportPaths: [...benchmarkReports],
      count: declaredFiles.length,
      modelFiles: declaredFiles
    }
  };
  const violations = evaluateModelSizeBudget(report, budget);
  return {
    ...report,
    violations,
    passed: violations.length === 0
  };
}

function packageModelFiles(packageInfo) {
  return sortedModelFiles(
    (packageInfo.files ?? [])
      .filter((file) => isModelPath(file.path))
      .map((file) => ({
        path: file.path,
        bytes: file.size
      }))
  );
}

function sortedModelFiles(files) {
  return [...files]
    .map((file) => ({
      path: file.path,
      bytes: file.bytes
    }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
}

function sumBytes(files) {
  return files.reduce((total, file) => total + file.bytes, 0);
}

function isModelPath(filePath) {
  const normalizedPath = filePath.toLowerCase();
  return modelExtensions.some((extension) => normalizedPath.endsWith(extension));
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

function readRepeatedOption(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
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
  node scripts/qa/check-model-size.mjs [--workspace <name>] [--report <path>]

Options:
  --root <path>                         Repository root. Defaults to cwd.
  --model-root <path>                   Model root to scan. May be repeated.
  --benchmark-report <path>             Benchmark report to inspect. May be repeated.
  --max-packaged-model-bytes <bytes>    Packaged model byte budget. Defaults to ${defaultBudget.maxPackagedModelBytes}.
  --max-packaged-model-files <count>    Packaged model file budget. Defaults to ${defaultBudget.maxPackagedModelFiles}.
  --max-repository-model-bytes <bytes>  Repository model byte budget. Defaults to ${defaultBudget.maxRepositoryModelBytes}.
  --max-repository-model-files <count>  Repository model file budget. Defaults to ${defaultBudget.maxRepositoryModelFiles}.
  --max-declared-lazy-model-files <count>
                                       Lazy model declaration budget. Defaults to ${defaultBudget.maxDeclaredLazyModelFiles}.
`;
}

function runNpmPack({ repoRoot, workspace }) {
  const child = spawnSync("npm", ["pack", "--workspace", workspace, "--dry-run", "--json"], {
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

async function collectRepositoryModelFiles({ repoRoot, modelRoots }) {
  const files = [];
  for (const modelRoot of modelRoots) {
    const absoluteRoot = path.resolve(repoRoot, modelRoot);
    try {
      const rootStat = await stat(absoluteRoot);
      if (!rootStat.isDirectory()) {
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    await walkModelRoot({ repoRoot, directory: absoluteRoot, files });
  }
  return sortedModelFiles(files);
}

async function walkModelRoot({ repoRoot, directory, files }) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkModelRoot({ repoRoot, directory: absolutePath, files });
    } else if (entry.isFile() && isModelPath(entry.name)) {
      const fileStat = await stat(absolutePath);
      files.push({
        path: normalizePath(path.relative(repoRoot, absolutePath)),
        bytes: fileStat.size
      });
    }
  }
}

async function collectDeclaredLazyModels({ repoRoot, benchmarkReports }) {
  const modelsByPath = new Map();
  for (const reportPath of benchmarkReports) {
    const absolutePath = path.resolve(repoRoot, reportPath);
    let payload;
    try {
      payload = JSON.parse(await readFile(absolutePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw new Error(`${reportPath} is not readable JSON: ${error.message}`);
    }

    for (const modelPath of modelFilesFromValue(payload)) {
      if (!modelsByPath.has(modelPath)) {
        modelsByPath.set(modelPath, new Set());
      }
      modelsByPath.get(modelPath).add(normalizePath(path.relative(repoRoot, absolutePath)));
    }
  }

  return [...modelsByPath.entries()].map(([modelPath, sources]) => ({
    path: modelPath,
    bytes: null,
    sources: [...sources].sort()
  }));
}

function modelFilesFromValue(value) {
  const modelFiles = [];
  collectModelFilesFromValue(value, modelFiles);
  return [...new Set(modelFiles)].sort();
}

function collectModelFilesFromValue(value, modelFiles) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelFilesFromValue(item, modelFiles);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "modelFiles" && Array.isArray(child)) {
      for (const modelPath of child) {
        if (typeof modelPath === "string" && isModelPath(modelPath)) {
          modelFiles.push(modelPath);
        }
      }
    } else {
      collectModelFilesFromValue(child, modelFiles);
    }
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
  const workspace = readOption("--workspace") ?? defaultWorkspace;
  const selectedModelRoots = readRepeatedOption("--model-root");
  const modelRoots = selectedModelRoots.length > 0 ? selectedModelRoots : defaultModelRoots;
  const selectedBenchmarkReports = readRepeatedOption("--benchmark-report");
  const benchmarkReports =
    selectedBenchmarkReports.length > 0 ? selectedBenchmarkReports : defaultBenchmarkReports;
  const budget = {
    maxPackagedModelBytes: readIntegerOption(
      "--max-packaged-model-bytes",
      defaultBudget.maxPackagedModelBytes
    ),
    maxPackagedModelFiles: readIntegerOption(
      "--max-packaged-model-files",
      defaultBudget.maxPackagedModelFiles
    ),
    maxRepositoryModelBytes: readIntegerOption(
      "--max-repository-model-bytes",
      defaultBudget.maxRepositoryModelBytes
    ),
    maxRepositoryModelFiles: readIntegerOption(
      "--max-repository-model-files",
      defaultBudget.maxRepositoryModelFiles
    ),
    maxDeclaredLazyModelFiles: readIntegerOption(
      "--max-declared-lazy-model-files",
      defaultBudget.maxDeclaredLazyModelFiles
    )
  };

  const packageInfo = runNpmPack({ repoRoot, workspace });
  const repositoryModelFiles = await collectRepositoryModelFiles({ repoRoot, modelRoots });
  const declaredLazyModelFiles = await collectDeclaredLazyModels({ repoRoot, benchmarkReports });
  const report = createModelSizeReport(
    {
      packageInfo,
      repositoryModelFiles,
      declaredLazyModelFiles,
      modelRoots,
      benchmarkReports
    },
    { budget }
  );
  const reportPath = readOption("--report");
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const summary =
    `Model size ${report.passed ? "passed" : "failed"}: ` +
    `packaged=${report.package.packagedModelBytes} bytes/${report.package.packagedModelFileCount} files ` +
    `repository=${report.repository.modelBytes} bytes/${report.repository.modelFileCount} files ` +
    `declaredLazy=${report.declaredLazyModels.count}`;
  console.log(summary);
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
