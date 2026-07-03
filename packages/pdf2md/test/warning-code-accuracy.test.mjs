import assert from "node:assert/strict";
import test from "node:test";
import {
  compareWarningCodeSets,
  createWarningCodeAccuracyReport
} from "../../../scripts/qa/check-warning-codes.mjs";

test("warning-code comparison passes exact expected code sets", () => {
  assert.deepEqual(compareWarningCodeSets(["a", "b"], ["b", "a", "a"]), {
    expectedCodes: ["a", "b"],
    actualCodes: ["a", "b"],
    matchedCodes: ["a", "b"],
    unexpectedCodes: [],
    missingCodes: [],
    precision: 1,
    recall: 1,
    passed: true
  });
});

test("warning-code comparison reports missing and unexpected codes", () => {
  const comparison = compareWarningCodeSets(["a", "b"], ["b", "c"]);

  assert.deepEqual(comparison.missingCodes, ["a"]);
  assert.deepEqual(comparison.unexpectedCodes, ["c"]);
  assert.equal(comparison.precision, 0.5);
  assert.equal(comparison.recall, 0.5);
  assert.equal(comparison.passed, false);
});

test("warning-code report summarizes aggregate precision and recall", () => {
  const report = createWarningCodeAccuracyReport([
    compareWarningCodeSets(["a"], ["a"]),
    compareWarningCodeSets(["b"], ["c"])
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.precision, 0.5);
  assert.equal(report.recall, 0.5);
});
