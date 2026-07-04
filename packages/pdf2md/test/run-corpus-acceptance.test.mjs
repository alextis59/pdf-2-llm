import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAcceptanceOutput,
  parseAcceptanceText
} from "../../../scripts/qa/run-corpus.mjs";
import { warningCodes } from "../src/index.mjs";

function fakeResult({ markdown = "Alpha\n\nBeta\n", warnings = [] } = {}) {
  return {
    markdown,
    sourceMap: {
      entries: [
        {
          markdownStart: 0,
          markdownEnd: 5,
          kind: "paragraph",
          regions: [{ pageIndex: 0 }]
        },
        {
          markdownStart: 7,
          markdownEnd: 11,
          kind: "paragraph",
          regions: [{ pageIndex: 1 }]
        }
      ]
    },
    warnings
  };
}

test("parseAcceptanceText reads snippets, warnings, metrics, and behavior criteria", () => {
  const acceptance = parseAcceptanceText(
    [
      "id: sample",
      "gate: text-mvp",
      "sourceType: digital",
      "expectedMode: pdf-text",
      "gating: true",
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "metrics:",
      "  maxUnexpectedWarnings: 0",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed:",
      "    - figure.low_semantic_content"
    ].join("\n")
  );

  assert.equal(acceptance.id, "sample");
  assert.deepEqual(acceptance.must, ["extract_main_text"]);
  assert.deepEqual(acceptance.mustNot, ["emit_binary_garbage"]);
  assert.equal(acceptance.maxUnexpectedWarnings, 0);
  assert.deepEqual(acceptance.snippets, [{ page: "1", contains: "Alpha" }]);
  assert.deepEqual(acceptance.warningsAllowed, ["figure.low_semantic_content"]);
});

test("checkAcceptanceOutput enforces snippets on the expected source page", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "metrics:",
      "  maxUnexpectedWarnings: 0",
      "snippets:",
      "  - page: 2",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed: []"
    ].join("\n")
  );

  const output = checkAcceptanceOutput(acceptance, fakeResult());
  assert.match(output.errors.join("\n"), /wrong or unmapped page 2/);
});

test("checkAcceptanceOutput applies allowed warnings and max unexpected warning budget", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "metrics:",
      "  maxUnexpectedWarnings: 0",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed:",
      "    - figure.low_semantic_content"
    ].join("\n")
  );

  const passing = checkAcceptanceOutput(
    acceptance,
    fakeResult({
      warnings: [
        { code: warningCodes.OcrDisabled },
        { code: warningCodes.HeuristicTextExtraction },
        { code: warningCodes.FigureLowSemanticContent }
      ]
    })
  );
  assert.deepEqual(passing.errors, []);

  const failing = checkAcceptanceOutput(
    acceptance,
    fakeResult({
      warnings: [
        { code: warningCodes.OcrDisabled },
        { code: warningCodes.TextOrderingUncertain }
      ]
    })
  );
  assert.match(failing.errors.join("\n"), /unexpected warning count 1 above 0/);
});

test("checkAcceptanceOutput rejects unknown behavior criteria instead of silently passing", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - preserve_unknown_behavior",
      "mustNot:",
      "  - emit_binary_garbage",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed: []"
    ].join("\n")
  );

  const output = checkAcceptanceOutput(acceptance, fakeResult());
  assert.match(output.errors.join("\n"), /unsupported acceptance must criterion/);
});
