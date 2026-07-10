import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertPdfToMarkdown } from "pdf-2-llm/node";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const inputPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(repoRoot, "corpus/generated/synthetic-simple-text.pdf");
const outputDir = process.argv[3]
  ? resolve(process.cwd(), process.argv[3])
  : resolve(repoRoot, ".temp/examples/node-basic");
const markdownPath = resolve(outputDir, "output.md");
const diagnosticsPath = resolve(outputDir, "diagnostics.json");

await mkdir(outputDir, { recursive: true });

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const result = await convertPdfToMarkdown(inputPath, {
    signal: controller.signal,
    markdown: {
      pageAnchors: true
    },
    tables: {
      csvSidecars: true
    },
    security: {
      timeoutMs: 30_000
    },
    onProgress(event) {
      process.stderr.write(`pdf2md ${event.stage} ${Math.round(event.progress * 100)}%\n`);
    }
  });

  await writeFile(markdownPath, result.markdown);
  await writeFile(
    diagnosticsPath,
    `${JSON.stringify(createDiagnosticsSummary(result), null, 2)}\n`
  );

  console.log(
    JSON.stringify(
      {
        inputPath,
        markdownPath,
        diagnosticsPath,
        pages: result.diagnostics.pages.length,
        textLines: result.diagnostics.extraction.textLines,
        warnings: result.warnings.length,
        provider: result.diagnostics.acceleration.webgpu.selectedProvider,
        confidence: result.confidence.overall
      },
      null,
      2
    )
  );
} finally {
  clearTimeout(timeout);
}

function createDiagnosticsSummary(result) {
  return {
    input: result.diagnostics.input,
    extraction: {
      mode: result.diagnostics.extraction.mode,
      textLines: result.diagnostics.extraction.textLines,
      sourceType: result.diagnostics.extraction.scanDetection.sourceType,
      ocr: {
        enabled: result.diagnostics.extraction.ocr.enabled,
        status: result.diagnostics.extraction.ocr.status,
        textBoxes: result.diagnostics.extraction.ocr.textBoxes.status
      }
    },
    acceleration: result.diagnostics.acceleration,
    assets: result.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      path: asset.path,
      mediaType: asset.mediaType,
      pageIndex: asset.pageIndex ?? null
    })),
    warnings: result.warnings,
    confidence: result.confidence,
    timing: result.diagnostics.timing
  };
}
