import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAgentCoordinationProtocol } from "../../../scripts/qa/check-agent-coordination.mjs";

test("evaluateAgentCoordinationProtocol passes required protocol language", () => {
  const summary = evaluateAgentCoordinationProtocol(
    [
      "docs/pdf-to-markdown-webassembly-study.md",
      "docs/pdf-to-markdown-implementation-plan.md",
      "Add or update focused unit, integration, corpus, or QA tests",
      "versioned IR",
      "schema tests",
      "before/after benchmark reports",
      "corpus/reports/"
    ].join("\n")
  );

  assert.equal(summary.passed, true);
  assert.equal(summary.checks.length, 4);
});

test("evaluateAgentCoordinationProtocol reports missing protocol language", () => {
  const summary = evaluateAgentCoordinationProtocol("schema tests only");

  assert.equal(summary.passed, false);
  assert.equal(summary.checks.some((check) => check.id === "read-study-and-plan" && !check.passed), true);
});
