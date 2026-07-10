import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown } from "../src/index.mjs";
import {
  createDocumentIr,
  documentIrJsonSchema,
  markdownSourceMapJsonSchema,
  pageElementJsonSchema
} from "../src/schema.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);
const visibleTableFixturePath = new URL(
  "../../../corpus/generated/synthetic-visible-table.pdf",
  import.meta.url
);
const declarationPath = new URL("../src/index.d.ts", import.meta.url);

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

test("page element schema accepts every declared discriminated variant", () => {
  const ir = createDocumentIr({
    sourceType: "digital",
    pages: [
      {
        pageIndex: 0,
        widthPt: 612,
        heightPt: 792,
        rotation: 0,
        sourceType: "digital",
        elements: [
          {
            type: "text",
            spans: [
              {
                text: "Hello",
                x: 72,
                y: 720,
                width: 30,
                height: 12,
                direction: "ltr",
                confidence: 1,
                source: "pdf-text"
              }
            ]
          },
          {
            type: "table",
            rows: [[{ text: "Cell", rowSpan: 1, colSpan: 1 }]],
            confidence: 0.9
          },
          { type: "figure", caption: "Figure 1", x: 10, y: 20, width: 30, height: 40 },
          { type: "equation", text: "x = 1", latex: "x = 1" },
          { type: "form-field", name: "approved", buttonType: "checkbox", checked: true },
          { type: "annotation", subtype: "Link", uri: "https://example.test" },
          { type: "asset-reference", assetId: "attachment-1" }
        ]
      }
    ]
  });

  assert.deepEqual(validateJsonSchema(documentIrJsonSchema, ir), []);
});

test("page element schema rejects unknown, incomplete, and drifted elements", () => {
  for (const element of [
    { type: "unknown" },
    { type: "text" },
    { type: "figure", unexpected: true },
    { type: "table", rows: [[{ text: "Cell" }]], confidence: 1 }
  ]) {
    assert.notDeepEqual(validateJsonSchema(pageElementJsonSchema, element), []);
  }
});

test("page element schema discriminators match the public PageElement union", async () => {
  const declaration = await readFile(declarationPath, "utf8");
  const unionBody = declaration.match(/export type PageElement =([\s\S]*?);/)?.[1] ?? "";
  const blockNames = [...unionBody.matchAll(/\|\s*([A-Za-z][A-Za-z0-9]*)/g)].map(
    (match) => match[1]
  );
  const declaredTypes = blockNames.map((blockName) => {
    const typeBody = declaration.match(
      new RegExp(`export type ${blockName} = \\{([\\s\\S]*?)\\n\\};`)
    )?.[1];
    return typeBody?.match(/type:\s*"([^"]+)"/)?.[1];
  });
  const schemaTypes = pageElementJsonSchema.oneOf.map(
    (variant) => variant.properties.type.const
  );

  assert.deepEqual(schemaTypes.sort(), declaredTypes.sort());
});

function validateJsonSchema(schema, value, path = "$") {
  const errors = [];

  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (variant) => validateJsonSchema(variant, value, path).length === 0
    );
    if (matches.length !== 1) {
      errors.push(`${path}: expected exactly one schema variant, matched ${matches.length}`);
    }
    return errors;
  }

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
