import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkAcceptanceOutput,
  parseAcceptanceText
} from "../../../scripts/qa/run-corpus.mjs";
import { compareReadingOrder } from "../../../scripts/qa/compare-oracles.mjs";
import { convertPdfToMarkdown, warningCodes } from "../src/index.mjs";
import {
  evaluateAcceptanceCriteria,
  evaluateStructureExpectations
} from "../../../scripts/qa/corpus-criteria.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const runCorpusPath = fileURLToPath(
  new URL("../../../scripts/qa/run-corpus.mjs", import.meta.url)
);
const damagedXrefAcceptance = new URL(
  "../../../corpus/accepted/synthetic-damaged-xref.yaml",
  import.meta.url
);
const damagedXrefExpected = new URL(
  "../../../corpus/expected/synthetic-damaged-xref.md",
  import.meta.url
);
const damagedXrefFixture = new URL(
  "../../../corpus/generated/synthetic-damaged-xref.pdf",
  import.meta.url
);

function runCommand(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function fakeResult({ markdown = "Alpha\n\nBeta\n", warnings = [] } = {}) {
  return {
    markdown,
    sourceMap: {
      entries: [
        {
          markdownStart: 0,
          markdownEnd: 5,
          kind: "paragraph",
          regions: [{ pageIndex: 0 }]
        },
        {
          markdownStart: 7,
          markdownEnd: 11,
          kind: "paragraph",
          regions: [{ pageIndex: 1 }]
        }
      ]
    },
    warnings
  };
}

test("parseAcceptanceText reads snippets, warnings, metrics, and behavior criteria", () => {
  const acceptance = parseAcceptanceText(
    [
      "id: sample",
      "gate: text-mvp",
      "sourceType: digital",
      "expectedMode: pdf-text",
      "gating: true",
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "metrics:",
      "  minTextCoverage: 0.9",
      "  maxReadingOrderDistance: 0.1",
      "  maxCharacterErrorRate: 0.05",
      "  maxUnexpectedWarnings: 0",
      "  minRenderedHtmlTextChars: 5",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed:",
      "    - figure.low_semantic_content",
      "structure:",
      "  expected:",
      "    - paragraphs",
      "assets:",
      "  required:",
      "    - table-csv",
      "runningContent:",
      "  expectedRetained:",
      "    - Alpha",
      "review:",
      "  humanReviewedBy: reviewer",
      "  reviewedAt: 2026-07-10"
    ].join("\n")
  );

  assert.equal(acceptance.id, "sample");
  assert.deepEqual(acceptance.must, ["extract_main_text"]);
  assert.deepEqual(acceptance.mustNot, ["emit_binary_garbage"]);
  assert.equal(acceptance.maxUnexpectedWarnings, 0);
  assert.equal(acceptance.minTextCoverage, 0.9);
  assert.equal(acceptance.maxReadingOrderDistance, 0.1);
  assert.equal(acceptance.maxCharacterErrorRate, 0.05);
  assert.equal(acceptance.minRenderedHtmlTextChars, 5);
  assert.deepEqual(acceptance.snippets, [{ page: "1", contains: "Alpha" }]);
  assert.deepEqual(acceptance.warningsAllowed, ["figure.low_semantic_content"]);
  assert.deepEqual(acceptance.structureExpected, ["paragraphs"]);
  assert.deepEqual(acceptance.assetsRequired, ["table-csv"]);
  assert.deepEqual(acceptance.runningContent.expectedRetained, ["Alpha"]);
  assert.equal(acceptance.humanReviewedBy, "reviewer");
  assert.equal(acceptance.reviewedAt, "2026-07-10");
});

test("checkAcceptanceOutput enforces snippets on the expected source page", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "metrics:",
      "  maxUnexpectedWarnings: 0",
      "snippets:",
      "  - page: 2",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed: []"
    ].join("\n")
  );

  const output = checkAcceptanceOutput(acceptance, fakeResult());
  assert.match(output.errors.join("\n"), /wrong or unmapped page 2/);
});

test("checkAcceptanceOutput rejects page snippets without source-map evidence", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed: []"
    ].join("\n")
  );
  const result = fakeResult();
  result.sourceMap.entries = [];

  const output = checkAcceptanceOutput(acceptance, result);
  assert.match(output.errors.join("\n"), /wrong or unmapped page 1/);
});

test("checkAcceptanceOutput applies allowed warnings and max unexpected warning budget", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - extract_main_text",
      "mustNot:",
      "  - emit_binary_garbage",
      "metrics:",
      "  maxUnexpectedWarnings: 0",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed:",
      "    - figure.low_semantic_content"
    ].join("\n")
  );

  const passing = checkAcceptanceOutput(
    acceptance,
    fakeResult({
      warnings: [
        { code: warningCodes.OcrDisabled },
        { code: warningCodes.HeuristicTextExtraction },
        { code: warningCodes.FigureLowSemanticContent }
      ]
    })
  );
  assert.deepEqual(passing.errors, []);

  const failing = checkAcceptanceOutput(
    acceptance,
    fakeResult({
      warnings: [
        { code: warningCodes.OcrDisabled },
        { code: warningCodes.TextOrderingUncertain }
      ]
    })
  );
  assert.match(failing.errors.join("\n"), /unexpected warning count 1 above 0/);
});

test("checkAcceptanceOutput rejects unknown behavior criteria instead of silently passing", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - preserve_unknown_behavior",
      "mustNot:",
      "  - emit_binary_garbage",
      "snippets:",
      "  - page: 1",
      "    contains: \"Alpha\"",
      "warnings:",
      "  allowed: []"
    ].join("\n")
  );

  const output = checkAcceptanceOutput(acceptance, fakeResult());
  assert.match(output.errors.join("\n"), /unsupported acceptance must criterion/);
});

test("recognized behavior criteria execute predicates instead of passing by name", () => {
  const acceptance = parseAcceptanceText(
    [
      "must:",
      "  - emit_gfm_table",
      "mustNot:",
      "  - emit_empty_markdown",
      "snippets: []",
      "warnings:",
      "  allowed: []"
    ].join("\n")
  );
  const output = checkAcceptanceOutput(acceptance, fakeResult({ markdown: "" }));

  assert.match(output.errors.join("\n"), /must criterion "emit_gfm_table" failed/);
  assert.match(output.errors.join("\n"), /mustNot criterion "emit_empty_markdown" failed/);
});

test("ignore-newest-revision evidence accepts every followed Prev chain", () => {
  const acceptance = {
    must: [],
    mustNot: ["ignore_newest_xref_revision"]
  };
  const context = {
    acceptance,
    result: {
      markdown: "# Synthetic Simple Text\n",
      diagnostics: {
        extraction: {
          parser: { mode: "classic-xref+prev" }
        }
      }
    }
  };

  assert.deepEqual(evaluateAcceptanceCriteria(acceptance, context), {
    errors: [],
    checked: 1
  });

  const failed = evaluateAcceptanceCriteria(acceptance, {
    ...context,
    result: {
      ...context.result,
      diagnostics: {
        extraction: {
          parser: { mode: "classic-xref" }
        }
      }
    }
  });
  assert.match(
    failed.errors.join("\n"),
    /mustNot criterion "ignore_newest_xref_revision" failed/
  );
});

test("damaged-xref acceptance executes paragraph-order evidence after tolerant repair", async () => {
  const acceptance = parseAcceptanceText(await readFile(damagedXrefAcceptance, "utf8"));
  const expected = await readFile(damagedXrefExpected, "utf8");
  const result = await convertPdfToMarkdown(fileURLToPath(damagedXrefFixture), {
    parser: { mode: "tolerant" }
  });
  const readingOrder = compareReadingOrder(expected, result.markdown);
  const context = {
    acceptance,
    entry: { features: ["damaged-xref", "repair-mode"] },
    evidence: {
      expectedMarkdownMatch: result.markdown === expected,
      readingOrderPassed:
        readingOrder.readingOrderDistance <= acceptance.maxReadingOrderDistance
    },
    result
  };

  assert.ok(acceptance.must.includes("preserve_paragraph_order"));
  assert.ok(!acceptance.must.includes("preserve_decrypted_text_order"));
  assert.equal(result.markdown, expected);
  assert.equal(readingOrder.readingOrderDistance, 0);
  assert.deepEqual(evaluateAcceptanceCriteria(acceptance, context), {
    errors: [],
    checked: 6
  });

  const failed = evaluateAcceptanceCriteria(acceptance, {
    ...context,
    evidence: { ...context.evidence, readingOrderPassed: false }
  });
  assert.match(
    failed.errors.join("\n"),
    /must criterion "preserve_paragraph_order" failed/
  );
});

test("every committed criterion and structure expectation has an executable checker", async () => {
  const acceptanceDir = new URL("../../../corpus/accepted/", import.meta.url);
  const files = (await readdir(acceptanceDir)).filter(
    (file) => file.endsWith(".yaml") && file !== "template.yaml"
  );
  const result = fakeResult();

  for (const file of files) {
    const acceptance = parseAcceptanceText(
      await readFile(new URL(file, acceptanceDir), "utf8")
    );
    const context = {
      acceptance,
      entry: { features: [] },
      evidence: {},
      result
    };
    const criterionErrors = evaluateAcceptanceCriteria(acceptance, context).errors;
    const structureErrors = evaluateStructureExpectations(
      acceptance.structureExpected,
      context
    ).errors;

    assert.doesNotMatch(
      [...criterionErrors, ...structureErrors].join("\n"),
      /unsupported .* without a checker/,
      file
    );
  }
});

test("run-corpus rejects reserved snapshot updates instead of silently continuing", async () => {
  const result = await runCommand(
    process.execPath,
    [runCorpusPath, "--update-snapshots", "--id", "synthetic-simple-text"],
    { cwd: repoRoot }
  );

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--update-snapshots is reserved/);
  assert.match(result.stderr, /not implemented/);
});
