import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.mjs";

const cliPath = new URL("../src/cli.mjs", import.meta.url);
const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);

test("parseArgs rejects unknown, duplicate, and extra arguments", () => {
  assert.equal(parseArgs(["input.pdf", "--jsoon"]).error, "Unknown option: --jsoon.");
  assert.equal(parseArgs(["input.pdf", "extra.pdf"]).error, "Unexpected positional argument: extra.pdf.");
  assert.equal(parseArgs(["input.pdf", "--json", "--json"]).error, "Duplicate option: --json.");
  assert.equal(parseArgs(["-h", "--help"]).error, "Duplicate option: --help.");
  assert.equal(
    parseArgs(["input.pdf", "--output", "first.md", "--output", "second.md"]).error,
    "Duplicate option: --output."
  );
});

test("parseArgs supports dash-prefixed paths after the option terminator", () => {
  assert.deepEqual(parseArgs(["--json", "--", "--input.pdf"]), {
    inputPath: "--input.pdf",
    outputPath: undefined,
    json: true,
    debug: false,
    debugTracePath: undefined,
    help: false,
    error: undefined
  });
  assert.equal(parseArgs(["--input.pdf"]).error, "Unknown option: --input.pdf.");
  assert.equal(parseArgs(["input.pdf", "--output", "--result.md"]).outputPath, "--result.md");
});

test("CLI argument errors exit non-zero", () => {
  for (const { argv, message } of [
    { argv: [fixturePath.pathname, "--jsoon"], message: /Unknown option: --jsoon/ },
    { argv: [fixturePath.pathname, "extra.pdf"], message: /Unexpected positional argument: extra\.pdf/ },
    { argv: [fixturePath.pathname, "--json", "--json"], message: /Duplicate option: --json/ }
  ]) {
    const run = spawnSync(process.execPath, [cliPath.pathname, ...argv], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, message);
  }
});

test("CLI converts a dash-prefixed input after the option terminator", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-2-llm-cli-dash-input-"));
  const inputName = "--fixture.pdf";
  try {
    await copyFile(fixturePath, join(root, inputName));
    const run = spawnSync(process.execPath, [cliPath.pathname, "--", inputName], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^# Synthetic Simple Text/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
