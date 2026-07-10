import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { convertPdfToMarkdown } from "../../packages/pdf2md/src/index.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.join(repoRoot, ".temp", "qa", "type-contract");
const contractPath = path.join(outputDir, "convert-result.contract.ts");
const configPath = path.join(outputDir, "tsconfig.json");
const fixturePath = path.join(
  repoRoot,
  "corpus",
  "generated",
  "synthetic-visible-table.pdf"
);

const result = await convertPdfToMarkdown(fixturePath, {
  raster: { enabled: true, dpi: 144, thumbnailDpi: 72 }
});
result.diagnostics.timing.elapsedMs = 0;

await mkdir(outputDir, { recursive: true });
await writeFile(
  contractPath,
  [
    'import type { ConvertResult } from "@pdf-2-llm/pdf2md";',
    "",
    `export const actualConvertResult = ${JSON.stringify(result, null, 2)} satisfies ConvertResult;`,
    ""
  ].join("\n")
);
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2022",
        types: []
      },
      files: ["convert-result.contract.ts"]
    },
    null,
    2
  )}\n`
);

try {
  await execFileAsync(path.join(repoRoot, "node_modules", ".bin", "tsc"), [
    "--project",
    configPath
  ], { cwd: repoRoot });
} catch (error) {
  process.stderr.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? "");
  process.exitCode = error.code ?? 1;
  throw new Error("Type declaration contract failed");
}

console.log(`Type contract passed: ${path.relative(repoRoot, contractPath)}`);
