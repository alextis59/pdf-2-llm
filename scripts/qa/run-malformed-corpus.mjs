import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { convertPdfToMarkdown, warningCodes } from "../../packages/pdf2md/src/index.mjs";

const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, "corpus", "manifest.json");

const inlineCases = [
  {
    id: "inline-missing-startxref",
    bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "binary")
  },
  {
    id: "inline-truncated-xref",
    bytes: Buffer.from("%PDF-1.4\nxref\n0 2\n0000000000 65535 f\ntrailer\n<< /Size 2 >>\n", "binary")
  },
  {
    id: "inline-invalid-header",
    bytes: Buffer.from("not a pdf\n1 0 obj\n<<>>\nendobj\n", "binary")
  }
];

async function loadDamagedCorpusCases() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return manifest.entries
    .filter((entry) => entry.kind === "damaged" || entry.features?.some((item) => item.includes("damaged")))
    .map((entry) => ({
      id: entry.id,
      path: path.join(repoRoot, entry.path)
    }));
}

function summarizeResult(result) {
  const parseWarning = result.warnings.find((warning) => warning.code === warningCodes.PdfParseFailed);
  return {
    parserMode: result.diagnostics.extraction.parser.mode,
    parseCode: parseWarning?.details?.code ?? "none",
    markdownBytes: Buffer.byteLength(result.markdown, "utf8")
  };
}

async function runCase({ id, input, options }) {
  const result = await convertPdfToMarkdown(input, {
    ...options,
    ocr: { enabled: false }
  });
  const summary = summarizeResult(result);
  console.log(
    `PASS ${id} parser=${summary.parserMode} parseCode=${summary.parseCode} markdownBytes=${summary.markdownBytes}`
  );
}

async function main() {
  const failures = [];
  const damagedCases = await loadDamagedCorpusCases();

  for (const corpusCase of damagedCases) {
    for (const mode of ["strict", "tolerant"]) {
      try {
        await runCase({
          id: `${corpusCase.id}:${mode}`,
          input: corpusCase.path,
          options: { parser: { mode } }
        });
      } catch (error) {
        failures.push(`${corpusCase.id}:${mode}: ${error.stack ?? error.message}`);
      }
    }
  }

  for (const inlineCase of inlineCases) {
    for (const mode of ["strict", "tolerant"]) {
      try {
        await runCase({
          id: `${inlineCase.id}:${mode}`,
          input: inlineCase.bytes,
          options: { parser: { mode } }
        });
      } catch (error) {
        failures.push(`${inlineCase.id}:${mode}: ${error.stack ?? error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Malformed corpus run passed: ${damagedCases.length + inlineCases.length} case(s).`);
}

await main();
