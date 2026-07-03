import assert from "node:assert/strict";
import test from "node:test";
import { compareOcrAccuracy } from "../../../scripts/qa/ocr-accuracy.mjs";

test("OCR accuracy comparison reports character and word error rates", () => {
  const comparison = compareOcrAccuracy(
    "# Scanned Title\n\nAlpha beta gamma.\n",
    "# Scanned Title\n\nAlpha beta delta.\n"
  );

  assert.equal(comparison.expectedWords, 5);
  assert.equal(comparison.actualWords, 5);
  assert.equal(comparison.wordEdits, 1);
  assert.equal(comparison.wordErrorRate, 1 / 5);
  assert.ok(comparison.characterEdits > 0);
  assert.ok(comparison.characterErrorRate > 0);
});

test("OCR accuracy comparison ignores Markdown syntax", () => {
  const comparison = compareOcrAccuracy("# Title\n\n- First item\n", "Title\n\nFirst item\n");

  assert.equal(comparison.characterErrorRate, 0);
  assert.equal(comparison.wordErrorRate, 0);
});
