import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown } from "../src/index.mjs";
import {
  createDocumentIr,
  documentIrJsonSchema,
  markdownSourceMapJsonSchema
} from "../src/schema.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);
const visibleTableFixturePath = new URL(
  "../../../corpus/generated/synthetic-visible-table.pdf",
  import.meta.url
);

test("serialized conversion contracts validate against JSON schemas", async () => {
  const bytes = await readFile(fixturePath);
  const result = await convertPdfToMarkdown(bytes);

  assert.deepEqual(validateJsonSchema(documentIrJsonSchema, JSON.parse(JSON.stringify(result.ir))), []);
  assert.deepEqual(
    validateJsonSchema(markdownSourceMapJsonSchema, JSON.parse(JSON.stringify(result.sourceMap))),
    []
  );
});

test("document IR JSON schema rejects missing required page fields", () => {
  const invalid = createDocumentIr({
    sourceType: "digital",
    pages: [
      {
        sourceType: "digital",
        elements: []
      }
    ]
  });

  const errors = validateJsonSchema(documentIrJsonSchema, invalid);
  assert.ok(errors.some((error) => error.includes("$.pages[0].pageIndex")));
});

test("document IR JSON schema accepts table CSV sidecar assets", async () => {
  const result = await convertPdfToMarkdown(visibleTableFixturePath.pathname);

  assert.equal(result.ir.assets.length, 1);
  assert.deepEqual(validateJsonSchema(documentIrJsonSchema, JSON.parse(JSON.stringify(result.ir))), []);
});

test("document IR JSON schema accepts encoded attachment sidecar assets", () => {
  const ir = createDocumentIr({ sourceType: "digital" });
  ir.assets = [
    {
      id: "attachment-1-report-txt",
      kind: "attachment",
      path: "assets/attachments/report.txt",
      mediaType: "text/plain",
      content: "YXR0YWNoZWQgcmVwb3J0Cg==",
      encoding: "base64",
      pageIndex: null
    }
  ];

  assert.deepEqual(validateJsonSchema(documentIrJsonSchema, ir), []);
});

function validateJsonSchema(schema, value, path = "$") {
  const errors = [];

  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (schema.type && !matchesJsonType(schema.type, value)) {
    errors.push(`${path}: expected type ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`);
    return errors;
  }

  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"))) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      errors.push(...validateObjectSchema(schema, value, path));
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`));
    });
  }

  return errors;
}

function validateObjectSchema(schema, value, path) {
  const errors = [];
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`${path}.${key}: missing required property`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      errors.push(...validateJsonSchema(propertySchema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

function matchesJsonType(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === "array") {
      return Array.isArray(value);
    }
    if (candidate === "integer") {
      return Number.isInteger(value);
    }
    if (candidate === "number") {
      return typeof value === "number" && Number.isFinite(value);
    }
    if (candidate === "object") {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    if (candidate === "null") {
      return value === null;
    }
    return typeof value === candidate;
  });
}
