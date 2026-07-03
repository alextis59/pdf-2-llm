import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { deflateSync } from "node:zlib";

const repoRoot = process.cwd();
const generatedAt = "2026-07-02";
const command = "npm run corpus:generate";

function pdfString(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function text(x, y, size, value) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET`;
}

function line(x1, y1, x2, y2) {
  return `${x1} ${y1} m ${x2} ${y2} l S`;
}

function rect(x, y, width, height) {
  return `${x} ${y} ${width} ${height} re S`;
}

function streamObject(content, extraDictionary = "") {
  const bytes = typeof content === "string" ? Buffer.from(content, "binary") : Buffer.from(content);
  return `<< /Length ${bytes.byteLength}${extraDictionary ? ` ${extraDictionary}` : ""} >>\nstream\n${bytes.toString("binary")}\nendstream`;
}

function createPdf({ pages }) {
  const objects = new Map();
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const pageIds = [];

  objects.set(
    fontId,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );

  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const content = `${page.operations.join("\n")}\n`;
    objects.set(contentId, streamObject(content));

    const mediaBox = page.mediaBox ?? [0, 0, 612, 792];
    const cropBox = page.cropBox ? `/CropBox [${page.cropBox.join(" ")}] ` : "";
    const rotate = page.rotate ? `/Rotate ${page.rotate} ` : "";
    objects.set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [${mediaBox.join(" ")}] ${cropBox}${rotate}/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
  });

  objects.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`
  );
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const maxObjectId = Math.max(...objects.keys());
  let body = "%PDF-1.4\n% pdf-2-llm generated fixture\n";
  const offsets = Array(maxObjectId + 1).fill(0);

  for (let objectId = 1; objectId <= maxObjectId; objectId += 1) {
    const objectBody = objects.get(objectId);
    if (!objectBody) {
      continue;
    }
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${maxObjectId + 1}\n`;
  body += "0000000000 65535 f\n";
  for (let objectId = 1; objectId <= maxObjectId; objectId += 1) {
    body += `${String(offsets[objectId]).padStart(10, "0")} 00000 n\n`;
  }
  body += `trailer\n<< /Size ${maxObjectId + 1} /Root ${catalogId} 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, "binary");
}

function createXrefStreamPdf({ pages }) {
  const objects = new Map();
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const pageIds = [];

  objects.set(
    fontId,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
  );

  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const content = `${page.operations.join("\n")}\n`;
    objects.set(contentId, streamObject(content));

    const mediaBox = page.mediaBox ?? [0, 0, 612, 792];
    const cropBox = page.cropBox ? `/CropBox [${page.cropBox.join(" ")}] ` : "";
    const rotate = page.rotate ? `/Rotate ${page.rotate} ` : "";
    objects.set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [${mediaBox.join(" ")}] ${cropBox}${rotate}/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
  });

  objects.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`
  );
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const maxObjectId = Math.max(...objects.keys());
  let body = "%PDF-1.5\n% pdf-2-llm generated fixture\n";
  const offsets = Array(maxObjectId + 2).fill(0);

  for (let objectId = 1; objectId <= maxObjectId; objectId += 1) {
    const objectBody = objects.get(objectId);
    if (!objectBody) {
      continue;
    }
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  }

  const xrefObjectId = maxObjectId + 1;
  offsets[xrefObjectId] = Buffer.byteLength(body, "binary");
  const xrefStream = createXrefStreamBytes(offsets);
  body += `${xrefObjectId} 0 obj\n`;
  body += `<< /Type /XRef /Size ${xrefObjectId + 1} /Root ${catalogId} 0 R /W [1 4 2] /Length ${xrefStream.byteLength} >>\n`;
  body += `stream\n${xrefStream.toString("binary")}endstream\nendobj\n`;
  body += `startxref\n${offsets[xrefObjectId]}\n%%EOF\n`;

  return Buffer.from(body, "binary");
}

function createObjectStreamPdf({ pages }) {
  if (pages.length !== 1) {
    throw new Error("Object-stream generated fixture currently supports exactly one page.");
  }

  const [page] = pages;
  const content = `${page.operations.join("\n")}\n`;
  const mediaBox = page.mediaBox ?? [0, 0, 612, 792];
  const cropBox = page.cropBox ? `/CropBox [${page.cropBox.join(" ")}] ` : "";
  const rotate = page.rotate ? `/Rotate ${page.rotate} ` : "";
  const compressedObjects = [
    { objectNumber: 4, value: "<< /Type /Catalog /Pages 5 0 R >>" },
    {
      objectNumber: 5,
      value: `<< /Type /Pages /Kids [6 0 R] /Count 1 /Resources << /Font << /F1 1 0 R >> >> /MediaBox [${mediaBox.join(" ")}] >>`
    },
    {
      objectNumber: 6,
      value: `<< /Type /Page /Parent 5 0 R /MediaBox [${mediaBox.join(" ")}] ${cropBox}${rotate}/Contents 2 0 R >>`
    }
  ];
  const directObjects = [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamObject(content),
    objectStreamObject(compressedObjects)
  ];

  let body = "%PDF-1.5\n% pdf-2-llm generated fixture\n";
  const offsets = [0];
  directObjects.forEach((objectBody, index) => {
    const objectId = index + 1;
    offsets[objectId] = Buffer.byteLength(body, "binary");
    body += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  });

  const xrefObjectId = 7;
  offsets[xrefObjectId] = Buffer.byteLength(body, "binary");
  const xrefStream = createObjectStreamXrefBytes(offsets, xrefObjectId);
  body += `${xrefObjectId} 0 obj\n`;
  body += `<< /Type /XRef /Size ${xrefObjectId + 1} /Root 4 0 R /W [1 4 2] /Length ${xrefStream.byteLength} >>\n`;
  body += `stream\n${xrefStream.toString("binary")}endstream\nendobj\n`;
  body += `startxref\n${offsets[xrefObjectId]}\n%%EOF\n`;

  return Buffer.from(body, "binary");
}

function createXrefStreamBytes(offsets) {
  const bytes = Buffer.alloc(offsets.length * 7);
  writeXrefStreamEntry(bytes, 0, 0, 0, 65535);
  for (let objectId = 1; objectId < offsets.length; objectId += 1) {
    writeXrefStreamEntry(bytes, objectId * 7, 1, offsets[objectId], 0);
  }
  return bytes;
}

function createObjectStreamXrefBytes(offsets, xrefObjectId) {
  const bytes = Buffer.alloc((xrefObjectId + 1) * 7);
  writeXrefStreamEntry(bytes, 0, 0, 0, 65535);
  writeXrefStreamEntry(bytes, 7, 1, offsets[1], 0);
  writeXrefStreamEntry(bytes, 14, 1, offsets[2], 0);
  writeXrefStreamEntry(bytes, 21, 1, offsets[3], 0);
  writeXrefStreamEntry(bytes, 28, 2, 3, 0);
  writeXrefStreamEntry(bytes, 35, 2, 3, 1);
  writeXrefStreamEntry(bytes, 42, 2, 3, 2);
  writeXrefStreamEntry(bytes, 49, 1, offsets[xrefObjectId], 0);
  return bytes;
}

function writeXrefStreamEntry(bytes, offset, type, field2, field3) {
  bytes[offset] = type;
  bytes.writeUInt32BE(field2, offset + 1);
  bytes.writeUInt16BE(field3, offset + 5);
}

function objectStreamObject(objects) {
  let currentOffset = 0;
  const offsets = objects.map((object) => {
    const offset = currentOffset;
    currentOffset += Buffer.byteLength(object.value, "binary") + 1;
    return offset;
  });
  const header = objects
    .map((object, index) => `${object.objectNumber} ${offsets[index]}`)
    .join(" ");
  const values = objects.map((object) => object.value).join(" ");
  const objectStream = `${header} ${values}`;
  const first = Buffer.byteLength(`${header} `, "binary");
  return streamObject(
    deflateSync(Buffer.from(objectStream, "binary")),
    `/Type /ObjStm /N ${objects.length} /First ${first} /Filter /FlateDecode`
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function yamlList(items) {
  return items.map((item) => `  - ${item}`).join("\n");
}

function yamlQuoted(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function acceptanceYaml(fixture) {
  const snippets = fixture.snippets
    .map((snippet) => `  - page: ${snippet.page}\n    contains: ${yamlQuoted(snippet.contains)}`)
    .join("\n");
  const structures = fixture.structures
    .map((item) => `    - ${item}`)
    .join("\n");
  const readingOrderMetric =
    fixture.maxReadingOrderDistance == null
      ? ""
      : `  maxReadingOrderDistance: ${fixture.maxReadingOrderDistance}\n`;
  const renderedHtmlTextMetric =
    fixture.minRenderedHtmlTextChars == null
      ? ""
      : `  minRenderedHtmlTextChars: ${fixture.minRenderedHtmlTextChars}\n`;
  const renderedHtmlHeadingMetric =
    fixture.minRenderedHtmlHeadings == null
      ? ""
      : `  minRenderedHtmlHeadings: ${fixture.minRenderedHtmlHeadings}\n`;
  const renderedHtmlParagraphMetric =
    fixture.minRenderedHtmlParagraphs == null
      ? ""
      : `  minRenderedHtmlParagraphs: ${fixture.minRenderedHtmlParagraphs}\n`;
  const renderedHtmlParagraphLengthMetric =
    fixture.maxRenderedHtmlParagraphChars == null
      ? ""
      : `  maxRenderedHtmlParagraphChars: ${fixture.maxRenderedHtmlParagraphChars}\n`;
  const tableAdjacencyMetric =
    fixture.minTableCellAdjacency == null
      ? ""
      : `  minTableCellAdjacency: ${fixture.minTableCellAdjacency}\n`;
  const tableSpanMetric =
    fixture.minTableSpanAccuracy == null
      ? ""
      : `  minTableSpanAccuracy: ${fixture.minTableSpanAccuracy}\n`;
  const tableCsvCellTextMetric =
    fixture.minTableCsvCellTextAccuracy == null
      ? ""
      : `  minTableCsvCellTextAccuracy: ${fixture.minTableCsvCellTextAccuracy}\n`;

  return `id: ${fixture.id}
gate: ${fixture.gate}
sourceType: digital
expectedMode: pdf-text
gating: true
must:
${yamlList(fixture.must)}
mustNot:
${yamlList([
  "invent_missing_values",
  "emit_binary_garbage",
  ...fixture.mustNot
])}
metrics:
  minTextCoverage: ${fixture.minTextCoverage}
${readingOrderMetric}\
${renderedHtmlTextMetric}\
${renderedHtmlHeadingMetric}\
${renderedHtmlParagraphMetric}\
${renderedHtmlParagraphLengthMetric}\
${tableAdjacencyMetric}\
${tableCsvCellTextMetric}\
${tableSpanMetric}\
  maxUnexpectedWarnings: 0
snippets:
${snippets}
structure:
  expected:
${structures}
warnings:
  allowed: []
assets:
  required: []
review:
  humanReviewedBy: "codex"
  reviewedAt: "${generatedAt}"
  notes: ${yamlQuoted(fixture.reviewNotes)}
`;
}

function manifestEntry(fixture, pdfBytes) {
  return {
    id: fixture.id,
    kind: fixture.kind,
    path: `corpus/generated/${fixture.id}.pdf`,
    source: {
      type: "generated",
      description: fixture.description,
      command
    },
    retrievedAt: generatedAt,
    license: {
      name: "Generated test fixture",
      notes: "Created from repository fixture-generation code for unrestricted project testing."
    },
    redistributable: true,
    sha256: sha256(pdfBytes),
    bytes: pdfBytes.length,
    pages: fixture.pages.length,
    pdfVersion: fixture.pdfVersion ?? "1.4",
    features: fixture.features,
    acceptanceFile: `corpus/accepted/${fixture.id}.yaml`,
    notes: fixture.description
  };
}

const fixtures = [
  {
    id: "synthetic-simple-text",
    kind: "synthetic",
    gate: "text-mvp",
    features: ["born-digital", "paragraphs", "headings"],
    description: "Simple one-page born-digital text fixture.",
    minTextCoverage: 1,
    must: ["extract_main_text", "preserve_heading", "preserve_paragraph_order"],
    mustNot: [],
    structures: ["heading_level_1", "paragraphs"],
    snippets: [
      { page: 1, contains: "Synthetic Simple Text" },
      { page: 1, contains: "This fixture validates basic paragraph extraction." }
    ],
    reviewNotes: "Exact-output generated fixture with one heading and two paragraphs.",
    expectedMarkdown:
      "# Synthetic Simple Text\n\nThis fixture validates basic paragraph extraction.\n\nThe expected output is deterministic.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Synthetic Simple Text"),
          text(72, 680, 12, "This fixture validates basic paragraph extraction."),
          text(72, 660, 12, "The expected output is deterministic.")
        ]
      }
    ]
  },
  {
    id: "synthetic-headings-lists",
    kind: "synthetic",
    gate: "text-mvp",
    features: ["born-digital", "headings", "lists"],
    description: "Headings and simple list fixture.",
    minTextCoverage: 1,
    must: ["extract_headings", "extract_bullet_list", "preserve_list_order"],
    mustNot: [],
    structures: ["heading_level_1", "heading_level_2", "unordered_list"],
    snippets: [
      { page: 1, contains: "Implementation Checklist" },
      { page: 1, contains: "Parse objects" }
    ],
    reviewNotes: "Exact-output generated fixture with visible list markers.",
    expectedMarkdown:
      "# Implementation Checklist\n\n## Parser\n\n- Parse objects\n- Decode streams\n- Emit warnings\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Implementation Checklist"),
          text(72, 682, 16, "Parser"),
          text(90, 650, 12, "- Parse objects"),
          text(90, 630, 12, "- Decode streams"),
          text(90, 610, 12, "- Emit warnings")
        ]
      }
    ]
  },
  {
    id: "synthetic-two-column",
    kind: "synthetic",
    gate: "layout-v1",
    features: ["born-digital", "two-column", "reading-order"],
    description: "Two-column reading-order fixture.",
    minTextCoverage: 1,
    maxReadingOrderDistance: 0,
    must: ["detect_columns", "preserve_left_then_right_reading_order"],
    mustNot: ["interleave_columns_line_by_line"],
    structures: ["two_columns", "reading_order"],
    snippets: [
      { page: 1, contains: "Left column starts here." },
      { page: 1, contains: "Right column starts here." }
    ],
    reviewNotes: "Expected order is left column top-down, then right column top-down.",
    expectedMarkdown:
      "# Two Column Fixture\n\nLeft column starts here.\n\nLeft column continues here.\n\nRight column starts here.\n\nRight column continues here.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Two Column Fixture"),
          text(72, 670, 12, "Left column starts here."),
          text(72, 650, 12, "Left column continues here."),
          text(330, 670, 12, "Right column starts here."),
          text(330, 650, 12, "Right column continues here.")
        ]
      }
    ]
  },
  {
    id: "synthetic-scientific-two-column",
    kind: "scientific-paper",
    gate: "layout-v1",
    features: ["born-digital", "two-column", "scientific-layout", "reading-order", "caption"],
    description: "Two-column scientific reading-order fixture.",
    minTextCoverage: 1,
    maxReadingOrderDistance: 0,
    must: ["detect_columns", "preserve_left_then_right_reading_order", "preserve_caption"],
    mustNot: ["interleave_columns_line_by_line", "move_caption_before_body"],
    structures: ["two_columns", "reading_order", "caption"],
    snippets: [
      { page: 1, contains: "Abstract result starts here." },
      { page: 1, contains: "Conclusion follows the discussion." }
    ],
    reviewNotes:
      "Expected order is left column top-down, including the figure caption, then right column top-down; maxReadingOrderDistance is zero because the generated fixture has exact reviewed Markdown. Rendered HTML thresholds confirm the paper fixture keeps a title and five readable paragraphs without paragraph collapse.",
    minRenderedHtmlTextChars: 150,
    minRenderedHtmlHeadings: 1,
    minRenderedHtmlParagraphs: 5,
    maxRenderedHtmlParagraphChars: 200,
    expectedMarkdown:
      "# Scientific Two Column Fixture\n\nAbstract result starts here.\n\nMethod detail continues here.\n\nFigure 1. Measured response.\n\nDiscussion starts on the right.\n\nConclusion follows the discussion.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Scientific Two Column Fixture"),
          text(72, 670, 12, "Abstract result starts here."),
          text(72, 650, 12, "Method detail continues here."),
          text(72, 610, 11, "Figure 1. Measured response."),
          text(330, 670, 12, "Discussion starts on the right."),
          text(330, 650, 12, "Conclusion follows the discussion.")
        ]
      }
    ]
  },
  {
    id: "synthetic-visible-table",
    kind: "visible-table",
    gate: "tables-v1",
    features: ["born-digital", "visible-table", "ruling-lines"],
    description: "Visible grid table fixture.",
    minTextCoverage: 1,
    minTableCellAdjacency: 1,
    minTableCsvCellTextAccuracy: 1,
    minTableSpanAccuracy: 1,
    must: ["detect_visible_table", "preserve_table_cells", "emit_gfm_table"],
    mustNot: ["flatten_table_to_unstructured_paragraph"],
    structures: ["gfm_table", "three_columns", "three_rows"],
    snippets: [
      { page: 1, contains: "Quarter" },
      { page: 1, contains: "Q2" }
    ],
    reviewNotes: "Grid lines and cell text are generated at deterministic coordinates.",
    expectedMarkdown:
      "# Visible Table\n\n| Quarter | Revenue | Cost |\n| --- | ---: | ---: |\n| Q1 | 100 | 50 |\n| Q2 | 120 | 60 |\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Visible Table"),
          rect(72, 610, 360, 90),
          line(192, 610, 192, 700),
          line(312, 610, 312, 700),
          line(72, 670, 432, 670),
          line(72, 640, 432, 640),
          text(82, 680, 11, "Quarter"),
          text(202, 680, 11, "Revenue"),
          text(322, 680, 11, "Cost"),
          text(82, 650, 11, "Q1"),
          text(202, 650, 11, "100"),
          text(322, 650, 11, "50"),
          text(82, 620, 11, "Q2"),
          text(202, 620, 11, "120"),
          text(322, 620, 11, "60")
        ]
      }
    ]
  },
  {
    id: "synthetic-split-across-page-table",
    kind: "visible-table",
    gate: "tables-v1",
    features: ["born-digital", "visible-table", "ruling-lines", "multi-page", "split-table"],
    description: "Two-page visible table fixture whose rows continue on the next page.",
    minTextCoverage: 1,
    minTableCellAdjacency: 1,
    minTableSpanAccuracy: 1,
    must: ["detect_visible_table", "preserve_table_cells", "preserve_continued_table_rows"],
    mustNot: ["merge_rows_across_columns", "drop_continued_rows"],
    structures: ["continued_table_parts", "three_columns", "six_rows"],
    snippets: [
      { page: 1, contains: "Alpha" },
      { page: 2, contains: "Delta" }
    ],
    reviewNotes:
      "The table is intentionally split across pages; current acceptance requires both page-local table parts to preserve their cells and row order.",
    expectedMarkdown:
      "# Split Across Page Table\n\n| Item | Count | Price |\n| --- | ---: | ---: |\n| Alpha | 10 | 1.50 |\n| Beta | 20 | 2.50 |\n\n| Item | Count | Price |\n| --- | ---: | ---: |\n| Gamma | 30 | 3.50 |\n| Delta | 40 | 4.50 |\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Split Across Page Table"),
          rect(72, 570, 360, 90),
          line(192, 570, 192, 660),
          line(312, 570, 312, 660),
          line(72, 630, 432, 630),
          line(72, 600, 432, 600),
          text(82, 640, 11, "Item"),
          text(202, 640, 11, "Count"),
          text(322, 640, 11, "Price"),
          text(82, 610, 11, "Alpha"),
          text(202, 610, 11, "10"),
          text(322, 610, 11, "1.50"),
          text(82, 580, 11, "Beta"),
          text(202, 580, 11, "20"),
          text(322, 580, 11, "2.50")
        ]
      },
      {
        operations: [
          rect(72, 600, 360, 90),
          line(192, 600, 192, 690),
          line(312, 600, 312, 690),
          line(72, 660, 432, 660),
          line(72, 630, 432, 630),
          text(82, 670, 11, "Item"),
          text(202, 670, 11, "Count"),
          text(322, 670, 11, "Price"),
          text(82, 640, 11, "Gamma"),
          text(202, 640, 11, "30"),
          text(322, 640, 11, "3.50"),
          text(82, 610, 11, "Delta"),
          text(202, 610, 11, "40"),
          text(322, 610, 11, "4.50")
        ]
      }
    ]
  },
  {
    id: "synthetic-table-with-note",
    kind: "visible-table",
    gate: "tables-v1",
    features: ["born-digital", "visible-table", "ruling-lines", "table-note"],
    description: "Visible table fixture with a note directly below the grid.",
    minTextCoverage: 1,
    minTableCellAdjacency: 1,
    minTableCsvCellTextAccuracy: 1,
    minTableSpanAccuracy: 1,
    must: ["detect_visible_table", "preserve_table_cells", "preserve_table_note"],
    mustNot: ["fold_note_into_table", "drop_table_note"],
    structures: ["gfm_table", "table_note", "three_columns", "three_rows"],
    snippets: [
      { page: 1, contains: "Region" },
      { page: 1, contains: "Note: Values are rounded to the nearest whole user." }
    ],
    reviewNotes:
      "The note is close to the ruled grid but outside its borders; acceptance requires preserving it as prose after the table.",
    expectedMarkdown:
      "# Table With Note\n\n| Region | Users | Change |\n| --- | ---: | ---: |\n| North | 120 | 5% |\n| South | 95 | -2% |\n\nNote: Values are rounded to the nearest whole user.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Table With Note"),
          rect(72, 610, 360, 90),
          line(192, 610, 192, 700),
          line(312, 610, 312, 700),
          line(72, 670, 432, 670),
          line(72, 640, 432, 640),
          text(82, 680, 11, "Region"),
          text(202, 680, 11, "Users"),
          text(322, 680, 11, "Change"),
          text(82, 650, 11, "North"),
          text(202, 650, 11, "120"),
          text(322, 650, 11, "5%"),
          text(82, 620, 11, "South"),
          text(202, 620, 11, "95"),
          text(322, 620, 11, "-2%"),
          text(72, 580, 10, "Note: Values are rounded to the nearest whole user.")
        ]
      }
    ]
  },
  {
    id: "synthetic-complex-spanned-table",
    kind: "complex-table",
    gate: "tables-v1",
    features: ["born-digital", "visible-table", "ruling-lines", "column-span", "html-table"],
    description: "Visible ruled table fixture with a merged header cell requiring HTML output.",
    minTextCoverage: 1,
    minTableCsvCellTextAccuracy: 1,
    minTableSpanAccuracy: 1,
    must: ["detect_visible_table", "detect_cell_span", "emit_html_table", "emit_csv_sidecar"],
    mustNot: ["emit_broken_gfm_for_spans", "drop_spanned_header"],
    structures: ["html_table", "column_span", "csv_sidecar"],
    snippets: [
      { page: 1, contains: "Revenue <Total>" },
      { page: 1, contains: "100 \"net\"" }
    ],
    reviewNotes:
      "The missing vertical rule in the header creates a colspan; Markdown cannot represent the span, so acceptance requires HTML table output plus CSV cell text coverage.",
    expectedMarkdown:
      "# Complex Spanned Table\n\n<table>\n  <thead>\n    <tr>\n      <th colspan=\"2\">Revenue &lt;Total&gt;</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>Q1 &amp; Q2</td>\n      <td>100 &quot;net&quot;</td>\n    </tr>\n  </tbody>\n</table>\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Complex Spanned Table"),
          rect(72, 610, 240, 60),
          line(192, 610, 192, 640),
          line(72, 640, 312, 640),
          text(82, 650, 11, "Revenue <Total>"),
          text(82, 620, 11, "Q1 & Q2"),
          text(202, 620, 11, "100 \"net\"")
        ]
      }
    ]
  },
  {
    id: "synthetic-borderless-table",
    kind: "borderless-table",
    gate: "tables-v1",
    features: ["born-digital", "borderless-table", "aligned-columns"],
    description: "Whitespace-aligned borderless table fixture.",
    minTextCoverage: 1,
    minTableCellAdjacency: 1,
    minTableSpanAccuracy: 1,
    must: ["detect_borderless_table", "preserve_column_alignment"],
    mustNot: ["merge_adjacent_columns"],
    structures: ["borderless_table", "aligned_numeric_columns"],
    snippets: [
      { page: 1, contains: "Item" },
      { page: 1, contains: "Notebook" }
    ],
    reviewNotes: "Columns are aligned without ruling lines to test whitespace inference.",
    expectedMarkdown:
      "# Borderless Table\n\n| Item | Count | Price |\n| --- | ---: | ---: |\n| Pencil | 4 | 2.00 |\n| Notebook | 2 | 7.50 |\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Borderless Table"),
          text(72, 680, 11, "Item"),
          text(220, 680, 11, "Count"),
          text(330, 680, 11, "Price"),
          text(72, 650, 11, "Pencil"),
          text(220, 650, 11, "4"),
          text(330, 650, 11, "2.00"),
          text(72, 620, 11, "Notebook"),
          text(220, 620, 11, "2"),
          text(330, 620, 11, "7.50")
        ]
      }
    ]
  },
  {
    id: "synthetic-rotated-page",
    kind: "rotated-cropped",
    gate: "robust-parser",
    features: ["born-digital", "rotated-page"],
    description: "Page rotation fixture.",
    minTextCoverage: 1,
    must: ["read_rotated_page", "normalize_coordinates"],
    mustNot: ["drop_rotated_text"],
    structures: ["page_rotation_90"],
    snippets: [{ page: 1, contains: "Rotated Page Fixture" }],
    reviewNotes: "The page dictionary has Rotate 90 and simple visible text.",
    expectedMarkdown: "# Rotated Page Fixture\n\nText remains readable after rotation normalization.\n",
    pages: [
      {
        rotate: 90,
        operations: [
          text(72, 720, 22, "Rotated Page Fixture"),
          text(72, 680, 12, "Text remains readable after rotation normalization.")
        ]
      }
    ]
  },
  {
    id: "synthetic-cropped-page",
    kind: "rotated-cropped",
    gate: "robust-parser",
    features: ["born-digital", "cropped-page"],
    description: "CropBox fixture.",
    minTextCoverage: 1,
    must: ["respect_crop_box", "preserve_visible_crop_text"],
    mustNot: ["prefer_hidden_media_box_content"],
    structures: ["crop_box"],
    snippets: [{ page: 1, contains: "Visible Crop Text" }],
    reviewNotes: "The page has a CropBox and visible text inside the cropped region.",
    expectedMarkdown: "# Cropped Page Fixture\n\nVisible Crop Text\n",
    pages: [
      {
        cropBox: [36, 300, 576, 756],
        operations: [
          text(72, 720, 22, "Cropped Page Fixture"),
          text(72, 680, 12, "Visible Crop Text")
        ]
      }
    ]
  },
  {
    id: "synthetic-xref-stream",
    kind: "pdf-feature",
    gate: "robust-parser",
    pdfVersion: "1.5",
    createPdf: createXrefStreamPdf,
    features: ["born-digital", "xref-stream", "pdf-1.5"],
    description: "PDF 1.5 xref stream fixture with direct page objects.",
    minTextCoverage: 1,
    must: ["resolve_xref_stream", "extract_main_text"],
    mustNot: ["fall_back_to_unstructured_binary_scan"],
    structures: ["xref_stream", "paragraphs"],
    snippets: [
      { page: 1, contains: "XRef Stream Corpus Fixture" },
      { page: 1, contains: "This fixture validates xref stream parsing." }
    ],
    reviewNotes: "The file uses a cross-reference stream instead of a classic xref table.",
    expectedMarkdown:
      "# XRef Stream Corpus Fixture\n\nThis fixture validates xref stream parsing.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "XRef Stream Corpus Fixture"),
          text(72, 680, 12, "This fixture validates xref stream parsing.")
        ]
      }
    ]
  },
  {
    id: "synthetic-object-stream",
    kind: "pdf-feature",
    gate: "robust-parser",
    pdfVersion: "1.5",
    createPdf: createObjectStreamPdf,
    features: ["born-digital", "xref-stream", "object-stream", "pdf-1.5"],
    description: "PDF 1.5 object stream fixture with compressed page tree objects.",
    minTextCoverage: 1,
    must: ["resolve_object_stream", "extract_main_text"],
    mustNot: ["drop_compressed_page_objects"],
    structures: ["object_stream", "xref_stream", "paragraphs"],
    snippets: [
      { page: 1, contains: "Object Stream Corpus Fixture" },
      { page: 1, contains: "This fixture validates object stream parsing." }
    ],
    reviewNotes: "The catalog, page tree, and page dictionaries are stored inside an object stream.",
    expectedMarkdown:
      "# Object Stream Corpus Fixture\n\nThis fixture validates object stream parsing.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Object Stream Corpus Fixture"),
          text(72, 680, 12, "This fixture validates object stream parsing.")
        ]
      }
    ]
  },
  {
    id: "synthetic-header-footer",
    kind: "long-document",
    gate: "layout-v1",
    features: ["born-digital", "multi-page", "headers", "footers"],
    description: "Two-page repeated header and footer fixture.",
    minTextCoverage: 1,
    must: ["detect_repeated_header", "detect_repeated_footer", "preserve_body_text"],
    mustNot: ["repeat_running_header_in_body"],
    structures: ["multi_page", "header_footer_removal"],
    snippets: [
      { page: 1, contains: "First page body." },
      { page: 2, contains: "Second page body." }
    ],
    reviewNotes: "Header and footer repeat across both pages and should be removable.",
    expectedMarkdown: "# Header Footer Fixture\n\nFirst page body.\n\nSecond page body.\n",
    pages: [
      {
        operations: [
          text(72, 760, 10, "Running Header"),
          text(72, 720, 22, "Header Footer Fixture"),
          text(72, 680, 12, "First page body."),
          text(280, 40, 10, "Page Footer")
        ]
      },
      {
        operations: [
          text(72, 760, 10, "Running Header"),
          text(72, 700, 12, "Second page body."),
          text(280, 40, 10, "Page Footer")
        ]
      }
    ]
  },
  {
    id: "synthetic-footnote",
    kind: "scientific-paper",
    gate: "layout-v1",
    features: ["born-digital", "footnote", "scientific-layout"],
    description: "Body text with footnote fixture.",
    minTextCoverage: 1,
    must: ["detect_footnote_region", "preserve_footnote_text"],
    mustNot: ["interleave_footnote_inside_body_sentence"],
    structures: ["paragraph", "footnote"],
    snippets: [
      { page: 1, contains: "A measured result refers to note 1." },
      { page: 1, contains: "1. Footnote text belongs after the paragraph." }
    ],
    reviewNotes: "The footnote is spatially separated near the bottom of the page.",
    expectedMarkdown:
      "# Footnote Fixture\n\nA measured result refers to note 1.\n\n1. Footnote text belongs after the paragraph.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Footnote Fixture"),
          text(72, 680, 12, "A measured result refers to note 1."),
          line(72, 120, 240, 120),
          text(72, 96, 9, "1. Footnote text belongs after the paragraph.")
        ]
      }
    ]
  },
  {
    id: "synthetic-vector-figure",
    kind: "vector-heavy",
    gate: "advanced-v1",
    features: ["born-digital", "vector-figure", "caption"],
    description: "Vector figure and caption fixture.",
    minTextCoverage: 1,
    must: ["detect_vector_figure_region", "preserve_caption"],
    mustNot: ["invent_chart_data"],
    structures: ["figure", "caption", "vector_paths"],
    snippets: [
      { page: 1, contains: "Figure 1. A generated vector box." },
      { page: 1, contains: "Vector Figure Fixture" }
    ],
    reviewNotes: "The figure is represented by vector paths plus a visible caption.",
    expectedMarkdown:
      "# Vector Figure Fixture\n\n![Figure 1](assets/synthetic-vector-figure-page-1-figure-1.png)\n\nFigure 1. A generated vector box.\n",
    pages: [
      {
        operations: [
          text(72, 720, 22, "Vector Figure Fixture"),
          rect(120, 520, 240, 120),
          line(120, 520, 360, 640),
          line(120, 640, 360, 520),
          text(120, 490, 11, "Figure 1. A generated vector box.")
        ]
      }
    ]
  }
];

async function writeFixtureFiles(fixture) {
  const pdfBytes = (fixture.createPdf ?? createPdf)({ pages: fixture.pages });
  await writeFile(path.join(repoRoot, "corpus", "generated", `${fixture.id}.pdf`), pdfBytes);
  await writeFile(
    path.join(repoRoot, "corpus", "expected", `${fixture.id}.md`),
    fixture.expectedMarkdown
  );
  await writeFile(
    path.join(repoRoot, "corpus", "accepted", `${fixture.id}.yaml`),
    acceptanceYaml(fixture)
  );
  return manifestEntry(fixture, pdfBytes);
}

async function updateManifest(entries) {
  const manifestPath = path.join(repoRoot, "corpus", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const generatedById = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set();
  manifest.entries = manifest.entries.map((entry) => {
    const generated = generatedById.get(entry.id);
    if (generated) {
      seen.add(entry.id);
      return generated;
    }
    return entry;
  });
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      manifest.entries.push(entry);
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  await mkdir(path.join(repoRoot, "corpus", "generated"), { recursive: true });
  await mkdir(path.join(repoRoot, "corpus", "expected"), { recursive: true });
  await mkdir(path.join(repoRoot, "corpus", "accepted"), { recursive: true });

  const entries = [];
  for (const fixture of fixtures) {
    entries.push(await writeFixtureFiles(fixture));
    console.log(`generated ${fixture.id}`);
  }
  await updateManifest(entries);
  console.log(`updated corpus/manifest.json with ${entries.length} generated fixture(s)`);
}

await main();
