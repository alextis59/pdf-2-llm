#!/usr/bin/env node
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { convertPdfToMarkdown } from "./index.mjs";

const args = process.argv.slice(2);
let activeTrace = null;

function usage() {
  return `Usage:
  pdf-2-llm <input.pdf> [--output <path>] [--json] [--debug] [--debug-trace <path>]
`;
}

function parseArgs(argv) {
  const parsed = {
    inputPath: undefined,
    outputPath: undefined,
    json: false,
    debug: false,
    debugTracePath: undefined,
    help: false,
    error: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--debug") {
      parsed.debug = true;
      continue;
    }
    if (arg === "--debug-trace") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        parsed.error = "--debug-trace requires a path.";
        return parsed;
      }
      parsed.debug = true;
      parsed.debugTracePath = value;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        parsed.error = "--output requires a path.";
        return parsed;
      }
      parsed.outputPath = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith("--") && !parsed.inputPath) {
      parsed.inputPath = arg;
    }
  }

  return parsed;
}

try {
  const exitCode = await runCli(args);
  process.exitCode = exitCode;
} catch (error) {
  await activeTrace?.event("cli.error", {
    error: serializeError(error)
  });
  reportFatalError(error, activeTrace);
  process.exitCode = 1;
}

async function runCli(argv) {
  const parsed = parseArgs(argv);
  activeTrace = await createDebugTrace(parsed);
  await activeTrace?.event("cli.start", {
    argv,
    cwd: process.cwd(),
    execPath: process.execPath,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid
  });

  if (activeTrace) {
    console.error(`Debug trace: ${activeTrace.path}`);
  }

  if (parsed.help) {
    await activeTrace?.event("cli.help");
    console.log(usage());
    return 0;
  }

  if (parsed.error) {
    await activeTrace?.event("cli.argument_error", { message: parsed.error });
    console.error(parsed.error);
    console.log(usage());
    return 1;
  }

  const { inputPath, outputPath, json } = parsed;
  if (!inputPath) {
    await activeTrace?.event("cli.argument_error", { message: "missing input path" });
    console.log(usage());
    return 1;
  }

  await activeTrace?.event("cli.args_parsed", {
    inputPath,
    outputPath: outputPath ?? null,
    json
  });
  await traceInputStat(activeTrace, inputPath);

  const result = await convertWithTrace(inputPath, activeTrace);
  const body = json ? `${JSON.stringify(result, null, 2)}\n` : result.markdown;
  await writeOutputWithTrace({
    body,
    outputPath,
    trace: activeTrace
  });
  await activeTrace?.event("cli.complete", {
    output: outputPath ? "file" : "stdout",
    bytes: byteLength(body)
  });
  return 0;
}

async function convertWithTrace(inputPath, trace) {
  await trace?.event("conversion.start", { inputPath });
  try {
    const result = await convertPdfToMarkdown(inputPath, {
      onProgress(event) {
        void trace?.event("conversion.progress", event);
      }
    });
    await trace?.event("conversion.complete", summarizeResult(result));
    return result;
  } catch (error) {
    await trace?.event("conversion.error", {
      error: serializeError(error)
    });
    throw error;
  }
}

async function writeOutputWithTrace({ body, outputPath, trace }) {
  const bytes = byteLength(body);
  if (outputPath) {
    await trace?.event("output.write_start", {
      target: "file",
      outputPath,
      bytes
    });
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, body);
    await trace?.event("output.write_complete", {
      target: "file",
      outputPath,
      bytes
    });
    return;
  }

  await trace?.event("output.write_start", {
    target: "stdout",
    bytes
  });
  await writeStdout(body);
  await trace?.event("output.write_complete", {
    target: "stdout",
    bytes
  });
}

async function writeStdout(body) {
  await new Promise((resolvePromise, rejectPromise) => {
    process.stdout.write(body, (error) => {
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    });
  });
}

async function traceInputStat(trace, inputPath) {
  if (!trace) {
    return;
  }
  await trace.event("input.stat_start", { inputPath });
  try {
    const info = await stat(inputPath);
    await trace.event("input.stat_complete", {
      inputPath,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      size: info.size,
      mtimeMs: info.mtimeMs,
      mode: info.mode
    });
  } catch (error) {
    await trace.event("input.stat_error", {
      inputPath,
      error: serializeError(error)
    });
  }
}

async function createDebugTrace(parsed) {
  if (!parsed.debug) {
    return null;
  }
  const tracePath = resolve(parsed.debugTracePath ?? defaultDebugTracePath());
  try {
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, "");
  } catch (error) {
    console.error(`Debug trace unavailable: ${formatErrorSummary(error)}`);
    return null;
  }
  let writeQueue = Promise.resolve();
  return {
    path: tracePath,
    event(name, details = {}) {
      writeQueue = writeQueue.then(async () => {
        try {
          const payload = sanitizeForJson({
            timestamp: new Date().toISOString(),
            event: name,
            details
          });
          await appendFile(tracePath, `${JSON.stringify(payload)}\n`);
        } catch (error) {
          console.error(`Debug trace write failed: ${formatErrorSummary(error)}`);
        }
      });
      return writeQueue;
    },
    flush() {
      return writeQueue;
    }
  };
}

function defaultDebugTracePath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(tmpdir(), "pdf-2-llm-traces", `convert-${stamp}-${process.pid}.ndjson`);
}

function summarizeResult(result) {
  return {
    markdownChars: result.markdown.length,
    sourceMapEntries: result.sourceMap.entries.length,
    assets: result.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      path: asset.path,
      mediaType: asset.mediaType,
      pageIndex: asset.pageIndex ?? null
    })),
    warnings: result.warnings,
    diagnostics: result.diagnostics,
    confidence: result.confidence
  };
}

function reportFatalError(error, trace) {
  const summary = formatErrorSummary(error);
  if (trace) {
    console.error(`pdf-2-llm failed: ${summary}`);
    console.error(`Debug trace: ${trace.path}`);
    const stack = error?.stack;
    if (stack) {
      console.error(stack);
    }
    return;
  }

  console.error(`pdf-2-llm failed: ${summary}`);
  console.error("Rerun with --debug for an NDJSON trace file.");
}

function formatErrorSummary(error) {
  if (error?.message) {
    return `${error.name ?? "Error"}: ${error.message}`;
  }
  return String(error);
}

function serializeError(error) {
  if (!error || typeof error !== "object") {
    return {
      name: "Error",
      message: String(error)
    };
  }
  const serialized = {
    name: error.name ?? "Error",
    message: error.message ?? String(error)
  };
  if (error.code != null) {
    serialized.code = error.code;
  }
  if (error.stack) {
    serialized.stack = error.stack;
  }
  if (error.cause) {
    serialized.cause = serializeError(error.cause);
  }
  return serialized;
}

function sanitizeForJson(value, depth = 0, seen = new Set()) {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 4000 ? `${value.slice(0, 4000)}...<truncated>` : value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (depth >= 8) {
    return "[MaxDepth]";
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 200).map((item) => sanitizeForJson(item, depth + 1, seen));
    if (value.length > items.length) {
      items.push(`...${value.length - items.length} more items`);
    }
    seen.delete(value);
    return items;
  }
  if (typeof value === "object") {
    const output = {};
    const entries = Object.entries(value).slice(0, 200);
    for (const [key, item] of entries) {
      output[key] = shouldRedactTraceKey(key)
        ? "[redacted]"
        : sanitizeForJson(item, depth + 1, seen);
    }
    const omitted = Object.keys(value).length - entries.length;
    if (omitted > 0) {
      output.__omittedKeys = omitted;
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

function shouldRedactTraceKey(key) {
  const normalized = key.toLowerCase();
  if (normalized === "passwordprovided" || normalized === "passwordsource") {
    return false;
  }
  return (
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("secret")
  );
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
