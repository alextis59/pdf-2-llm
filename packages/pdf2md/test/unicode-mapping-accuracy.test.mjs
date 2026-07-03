import assert from "node:assert/strict";
import test from "node:test";
import {
  compareUnicodeMapping,
  createUnicodeMappingAccuracyReport,
  extractMappedUnicodeText
} from "../../../scripts/qa/check-unicode-mapping.mjs";

test("extractMappedUnicodeText keeps mapped non-ASCII text and strips markup", () => {
  assert.equal(
    extractMappedUnicodeText('# Title\n\n<p dir="rtl">אבג דהו</p>\n\n![図](assets/figure.png)\n'),
    "אבגדהו図"
  );
});

test("compareUnicodeMapping passes exact Unicode codepoint sequences", () => {
  assert.deepEqual(compareUnicodeMapping("<p>אבג דהו</p>\n", "<p>אבג דהו</p>\n"), {
    expectedText: "אבגדהו",
    actualText: "אבגדהו",
    expectedCodePoints: 6,
    actualCodePoints: 6,
    editDistance: 0,
    accuracy: 1,
    passed: true
  });
});

test("compareUnicodeMapping reports substitutions and reordering", () => {
  const comparison = compareUnicodeMapping("これは一行目", "これは二行目");

  assert.equal(comparison.expectedCodePoints, 6);
  assert.equal(comparison.actualCodePoints, 6);
  assert.equal(comparison.editDistance, 1);
  assert.equal(comparison.accuracy, 5 / 6);
  assert.equal(comparison.passed, false);
});

test("createUnicodeMappingAccuracyReport aggregates edit distance", () => {
  const report = createUnicodeMappingAccuracyReport([
    compareUnicodeMapping("縦書き", "縦書き"),
    compareUnicodeMapping("列二", "列三")
  ]);

  assert.equal(report.passed, false);
  assert.equal(report.caseCount, 2);
  assert.equal(report.expectedCodePoints, 5);
  assert.equal(report.editDistance, 1);
  assert.equal(report.accuracy, 0.8);
});
