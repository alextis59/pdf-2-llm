import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  portableToolArgument,
  toolVersionFromResult
} from "../../../scripts/corpus/analyze.mjs";

test("analysis tool captures use portable repository paths", () => {
  const root = path.resolve("/workspace/pdf-2-llm");

  assert.equal(
    portableToolArgument(path.join(root, "corpus", "generated", "sample.pdf"), root),
    "corpus/generated/sample.pdf"
  );
  assert.equal(portableToolArgument("--json", root), "--json");
  assert.equal(portableToolArgument("-", root), "-");
  assert.equal(portableToolArgument(root, root), ".");
});

test("analysis tool captures retain the first reported version line", () => {
  assert.equal(
    toolVersionFromResult({
      available: true,
      status: 0,
      stdout: "",
      stderr: "pdfinfo version 22.02.0\nCopyright"
    }),
    "pdfinfo version 22.02.0"
  );
  assert.equal(
    toolVersionFromResult({ available: false, error: "not found" }),
    null
  );
});

test("committed inventory byte and hash identities match the manifest", async () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "corpus", "manifest.json"), "utf8")
  );
  const inventory = await readFile(
    path.join(repoRoot, "corpus", "reports", "corpus-inventory.md"),
    "utf8"
  );
  const inventoryRows = new Map(
    inventory
      .split("\n")
      .map((line) => line.match(/^\| ([^ ]+) \| (\d+) \| ([0-9a-f]{64}) \|/))
      .filter(Boolean)
      .map((match) => [match[1], { bytes: Number(match[2]), sha256: match[3] }])
  );

  for (const entry of manifest.entries) {
    assert.deepEqual(
      inventoryRows.get(entry.id),
      { bytes: entry.bytes, sha256: entry.sha256 },
      entry.id
    );
  }
});
