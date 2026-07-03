import { parentPort } from "node:worker_threads";
import { convertPdfToMarkdown } from "../src/worker.mjs";

parentPort.on("message", async (message) => {
  if (message?.type !== "convert") {
    return;
  }

  try {
    const result = await convertPdfToMarkdown(message.bytes, {
      ...(message.options ?? {}),
      onProgress(event) {
        parentPort.postMessage({
          id: message.id,
          type: "progress",
          event
        });
      }
    });

    parentPort.postMessage({
      id: message.id,
      type: "result",
      result: createWorkerResult(result)
    });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      type: "error",
      error: serializeError(error)
    });
  }
});

function createWorkerResult(result) {
  return {
    markdown: result.markdown,
    diagnostics: {
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
      timing: result.diagnostics.timing,
      pages: result.diagnostics.pages.length
    },
    assets: result.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      path: asset.path,
      mediaType: asset.mediaType,
      pageIndex: asset.pageIndex ?? null
    })),
    warnings: result.warnings,
    confidence: result.confidence
  };
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  };
}
