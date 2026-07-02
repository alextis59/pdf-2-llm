import assert from "node:assert/strict";
import test from "node:test";
import { PdfSyntaxError, parsePdfValue } from "../src/pdf-parser.mjs";

test("parsePdfValue fuzz smoke parses generated primitive values", () => {
  const rng = createRng(0x5eed);

  for (let index = 0; index < 200; index += 1) {
    const value = randomPdfValue(rng, 0);
    const parsed = parsePdfValue(value);
    assert.ok(parsed.offset > 0, value);
  }
});

test("parsePdfValue fuzz smoke reports malformed values as syntax errors", () => {
  const rng = createRng(0xbad);
  const alphabet = "[]<>()/%#0123456789+- .\n\r\tABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  for (let index = 0; index < 300; index += 1) {
    const length = randomInt(rng, 1, 80);
    let value = "";
    for (let offset = 0; offset < length; offset += 1) {
      value += alphabet[randomInt(rng, 0, alphabet.length - 1)];
    }

    try {
      parsePdfValue(value);
    } catch (error) {
      assert.ok(error instanceof PdfSyntaxError, `${error.name}: ${value}`);
    }
  }
});

function randomPdfValue(rng, depth) {
  const choices = depth > 2 ? ["number", "bool", "null", "name", "string"] : [
    "array",
    "dict",
    "number",
    "bool",
    "null",
    "name",
    "string",
    "hex",
    "ref"
  ];
  const choice = choices[randomInt(rng, 0, choices.length - 1)];

  if (choice === "array") {
    const items = Array.from({ length: randomInt(rng, 0, 5) }, () => randomPdfValue(rng, depth + 1));
    return `[${items.join(" ")}]`;
  }
  if (choice === "dict") {
    const entries = [];
    for (let index = 0; index < randomInt(rng, 0, 4); index += 1) {
      entries.push(`/${randomName(rng)} ${randomPdfValue(rng, depth + 1)}`);
    }
    return `<< ${entries.join(" ")} >>`;
  }
  if (choice === "number") {
    return String(randomInt(rng, -5000, 5000) / (randomBool(rng) ? 1 : 10));
  }
  if (choice === "bool") {
    return randomBool(rng) ? "true" : "false";
  }
  if (choice === "null") {
    return "null";
  }
  if (choice === "name") {
    return `/${randomName(rng)}`;
  }
  if (choice === "string") {
    return `(${randomString(rng)})`;
  }
  if (choice === "hex") {
    return `<${randomHex(rng, randomInt(rng, 0, 12))}>`;
  }

  return `${randomInt(rng, 1, 20)} ${randomInt(rng, 0, 3)} R`;
}

function randomName(rng) {
  const parts = ["A", "Name", "F1", "Example#20Name", "X", "Length", "Root"];
  return parts[randomInt(rng, 0, parts.length - 1)];
}

function randomString(rng) {
  const parts = ["hello", "with\\nnewline", "paren\\(value\\)", "octal\\101", ""];
  return parts[randomInt(rng, 0, parts.length - 1)];
}

function randomHex(rng, length) {
  const chars = "0123456789ABCDEF";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += chars[randomInt(rng, 0, chars.length - 1)];
  }
  return value;
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomBool(rng) {
  return rng() >= 0.5;
}
