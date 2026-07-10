import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
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
