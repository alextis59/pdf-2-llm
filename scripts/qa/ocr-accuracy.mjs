import {
  markdownToComparableText,
  tokenEditDistance,
  tokenizeComparableText
} from "./compare-oracles.mjs";

export function compareOcrAccuracy(expectedMarkdown, actualMarkdown) {
  const expectedText = normalizeOcrText(markdownToComparableText(expectedMarkdown));
  const actualText = normalizeOcrText(markdownToComparableText(actualMarkdown));
  const expectedChars = Array.from(expectedText);
  const actualChars = Array.from(actualText);
  const characterEdits = tokenEditDistance(expectedChars, actualChars);
  const characterErrorRate =
    expectedChars.length === 0 ? (actualChars.length === 0 ? 0 : 1) : characterEdits / expectedChars.length;

  const expectedWords = tokenizeComparableText(expectedText);
  const actualWords = tokenizeComparableText(actualText);
  const wordEdits = tokenEditDistance(expectedWords, actualWords);
  const wordErrorRate =
    expectedWords.length === 0 ? (actualWords.length === 0 ? 0 : 1) : wordEdits / expectedWords.length;

  return {
    characterErrorRate,
    characterEdits,
    expectedCharacters: expectedChars.length,
    actualCharacters: actualChars.length,
    wordErrorRate,
    wordEdits,
    expectedWords: expectedWords.length,
    actualWords: actualWords.length
  };
}

function normalizeOcrText(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
