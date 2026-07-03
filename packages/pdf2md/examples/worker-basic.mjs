import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const inputPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(repoRoot, "corpus/generated/synthetic-simple-text.pdf");
const outputDir = process.argv[3]
  ? resolve(process.cwd(), process.argv[3])
  : resolve(repoRoot, ".temp/examples/worker-basic");
const markdownPath = resolve(outputDir, "output.md");
const diagnosticsPath = resolve(outputDir, "diagnostics.json");

await mkdir(outputDir, { recursive: true });

const bytes = await readFile(inputPath);
const result = await convertInWorker(bytes, {
  markdown: {
    pageAnchors: true
  },
  tables: {
    csvSidecars: true
  },
  security: {
    timeoutMs: 30_000
  }
});

await writeFile(markdownPath, result.markdown);
await writeFile(
  diagnosticsPath,
  `${JSON.stringify(
    {
      diagnostics: result.diagnostics,
      assets: result.assets,
      warnings: result.warnings,
      confidence: result.confidence
    },
    null,
    2
  )}\n`
);

console.log(
  JSON.stringify(
    {
      inputPath,
      markdownPath,
      diagnosticsPath,
      pages: result.diagnostics.pages,
      textLines: result.diagnostics.extraction.textLines,
      warnings: result.warnings.length,
      provider: result.diagnostics.acceleration.webgpu.selectedProvider,
      confidence: result.confidence.overall
    },
    null,
    2
  )
);

function convertInWorker(inputBytes, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./worker-basic-worker.mjs", import.meta.url), {
      type: "module"
    });
    const id = `convert-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => rejectPromise(new Error("Worker conversion timed out.")));
    }, 35_000);

    worker.on("message", (message) => {
      if (message?.id !== id) {
        return;
      }
      if (message.type === "progress") {
        process.stderr.write(
          `worker pdf2md ${message.event.stage} ${Math.round(message.event.progress * 100)}%\n`
        );
        return;
      }
      if (message.type === "result") {
        settle(() => resolvePromise(message.result));
        return;
      }
      if (message.type === "error") {
        settle(() => rejectPromise(errorFromWorker(message.error)));
      }
    });

    worker.on("error", (error) => {
      settle(() => rejectPromise(error));
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        settle(() => rejectPromise(new Error(`Worker stopped with exit code ${code}.`)));
      }
    });

    const arrayBuffer = inputBytes.buffer.slice(
      inputBytes.byteOffset,
      inputBytes.byteOffset + inputBytes.byteLength
    );
    worker.postMessage(
      {
        id,
        type: "convert",
        bytes: arrayBuffer,
        options
      },
      [arrayBuffer]
    );

    function settle(callback) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});
      callback();
    }
  });
}

function errorFromWorker(error) {
  const normalized = new Error(error?.message ?? "Worker conversion failed.");
  normalized.name = error?.name ?? "Error";
  if (error?.stack) {
    normalized.stack = error.stack;
  }
  return normalized;
}
