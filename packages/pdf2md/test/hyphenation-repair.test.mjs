import assert from "node:assert/strict";
import test from "node:test";
import {
  compareHyphenationRepairs,
  createHyphenationRepairReport
} from "../../../scripts/qa/check-hyphenation-repair.mjs";

test("compareHyphenationRepairs passes repaired terms without rejected forms", () => {
  assert.deepEqual(
    compareHyphenationRepairs("This paragraph validates hyphenation repair.\n", {
      repairedTerms: ["hyphenation"],
      rejectedTerms: ["hyphen- ation", "hyphen-\nation"]
    }),
    {
      repairedTerms: ["hyphenation"],
      rejectedTerms: ["hyphen- ation", "hyphen-\nation"],
      matchedTerms: ["hyphenation"],
      missingTerms: [],
      rejectedTermsPresent: [],
      accuracy: 1,
      passed: true
    }
  );
});

test("compareHyphenationRepairs reports missing repairs and rejected forms", () => {
  const comparison = compareHyphenationRepairs("This paragraph keeps hyphen- ation.\n", {
    repairedTerms: ["hyphenation"],
    rejectedTerms: ["hyphen- ation"]
  });

  assert.equal(comparison.passed, false);
  assert.equal(comparison.accuracy, 0);
  assert.deepEqual(comparison.missingTerms, ["hyphenation"]);
  assert.deepEqual(comparison.rejectedTermsPresent, ["hyphen- ation"]);
});

test("createHyphenationRepairReport aggregates accuracy", () => {
  const report = createHyphenationRepairReport([
    compareHyphenationRepairs("hyphenation", {
      repairedTerms: ["hyphenation"],
      rejectedTerms: ["hyphen- ation"]
    }),
    compareHyphenationRepairs("split- word", {
      repairedTerms: ["splitword"],
      rejectedTerms: ["split- word"]
    })
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.expectedRepairs, 2);
  assert.equal(report.matchedRepairs, 1);
  assert.equal(report.rejectedTermsPresent, 1);
  assert.equal(report.accuracy, 0.5);
});
