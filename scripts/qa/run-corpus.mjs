import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown, warningCodes } from "../../packages/pdf2md/src/index.mjs";
import { compareOcrAccuracy } from "./ocr-accuracy.mjs";
import {
  compareCharacterErrorRate,
  compareReadingOrder,
  compareTextCoverage,
  markdownToComparableText
} from "./compare-oracles.mjs";
import { compareRunningContent } from "./compare-running-content.mjs";
import { compareTaggedStructure } from "./compare-tagged-structure.mjs";
import { analyzeRenderedHtml, evaluateRenderedHtml } from "./check-rendered-html.mjs";
import {
  evaluateAcceptanceCriteria,
  evaluateExpectedMode,
  evaluateStructureExpectations
} from "./corpus-criteria.mjs";
import { renderMarkdownToHtml } from "./render-markdown.mjs";
import { compareTableCellAdjacency } from "./table-adjacency.mjs";
import { compareTableCsvCellTextAccuracy } from "./table-csv-accuracy.mjs";
import { compareTableSpanAccuracy } from "./table-span-accuracy.mjs";

const args = process.argv.slice(2);
const repoRoot = path.resolve(readOption("--root") ?? process.cwd());
const manifestPath = path.resolve(
  readOption("--manifest") ?? path.join(repoRoot, "corpus", "manifest.json")
);
const listOnly = hasFlag("--list");
const dryRun = hasFlag("--dry-run");
const updateSnapshots = hasFlag("--update-snapshots");
const assertMarkdown = hasFlag("--assert-markdown");
const selectedGate = readOption("--gate");
const selectedIds = readOptions("--id");
const runnerBaselineWarnings = new Set([
  warningCodes.OcrDisabled,
  warningCodes.HeuristicTextExtraction
]);

function hasFlag(name) {
  return args.includes(name);
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function readOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function usage() {
  return `Usage:
  node scripts/qa/run-corpus.mjs --list [--gate <gate>]
  node scripts/qa/run-corpus.mjs --id <manifest-id> [--dry-run]
  node scripts/qa/run-corpus.mjs --gate <gate> [--dry-run]
  node scripts/qa/run-corpus.mjs --all [--dry-run]

Options:
  --manifest <path>          Manifest path. Defaults to corpus/manifest.json.
  --root <path>              Repository root. Defaults to cwd.
  --assert-markdown          Compare output with corpus/expected/<id>.md.
  --update-snapshots         Reserved; currently rejected to avoid no-op updates.
`;
}

function readTopLevelScalars(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line) || /^\s/.test(line)) {
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], normalizeScalar(match[2] ?? ""));
    }
  }
  return values;
}

function normalizeScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readNamedBlockScalars(text, blockName) {
  const values = new Map();
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      inBlock = line.trim() === `${blockName}:`;
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const match = line.match(/^\s{2}([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (match) {
      values.set(match[1], normalizeScalar(match[2] ?? ""));
    }
  }
  return values;
}

function readTopLevelList(text, blockName) {
  const values = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      const inlineEmptyList = line.match(new RegExp(`^${blockName}:\\s*\\[\\]\\s*$`));
      if (inlineEmptyList) {
        return values;
      }
      inBlock = line.trim() === `${blockName}:`;
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const itemMatch = line.match(/^\s{2}-\s+(.*)$/);
    if (itemMatch) {
      values.push(normalizeScalar(itemMatch[1]));
    }
  }
  return values;
}

function readNestedList(text, blockName, listName) {
  const values = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let inList = false;
  for (const line of lines) {
    if (!inBlock) {
      inBlock = line.trim() === `${blockName}:`;
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    if (inList && /^\s{2}[A-Za-z][A-Za-z0-9]*:/.test(line)) {
      break;
    }
    if (!inList) {
      const listMatch = line.match(new RegExp(`^\\s{2}${listName}:(?:\\s*(\\[\\])\\s*)?$`));
      if (listMatch) {
        if (listMatch[1]) {
          return values;
        }
        inList = true;
      }
      continue;
    }
    const itemMatch = line.match(/^\s{4}-\s+(.*)$/);
    if (itemMatch) {
      values.push(normalizeScalar(itemMatch[1]));
    }
  }
  return values;
}

function readStructureForms(text) {
  const forms = [];
  let inStructure = false;
  let inForms = false;
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (!inStructure) {
      inStructure = line.trim() === "structure:";
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    if (!inForms) {
      const formsMatch = line.match(/^  forms:(?:\s*(\[\])\s*)?$/);
      if (formsMatch) {
        inForms = !formsMatch[1];
      }
      continue;
    }

    const itemMatch = line.match(/^    -\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (itemMatch) {
      current = {
        [itemMatch[1]]: readAcceptanceValue(itemMatch[2])
      };
      forms.push(current);
      continue;
    }

    const propertyMatch = line.match(/^      ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (propertyMatch && current) {
      current[propertyMatch[1]] = readAcceptanceValue(propertyMatch[2]);
    }
  }

  return forms;
}

function readSnippetAssertions(text) {
  const snippets = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let current = null;

  for (const line of lines) {
    if (!inBlock) {
      inBlock = line.trim() === "snippets:";
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }

    const itemMatch = line.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (itemMatch) {
      current = {
        [itemMatch[1]]: readAcceptanceValue(itemMatch[2])
      };
      snippets.push(current);
      continue;
    }

    const propertyMatch = line.match(/^\s{4}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (propertyMatch && current) {
      current[propertyMatch[1]] = readAcceptanceValue(propertyMatch[2]);
    }
  }

  return snippets;
}

function readAcceptanceValue(value) {
  const normalized = normalizeScalar(value ?? "");
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return normalized;
}

function readNumber(value, fallback = null) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseAcceptanceText(text) {
  const scalars = readTopLevelScalars(text);
  const metrics = readNamedBlockScalars(text, "metrics");
  const review = readNamedBlockScalars(text, "review");
  return {
    id: scalars.get("id"),
    gate: scalars.get("gate"),
    sourceType: scalars.get("sourceType"),
    expectedMode: scalars.get("expectedMode"),
    gating: scalars.get("gating") === "true",
    must: readTopLevelList(text, "must"),
    mustNot: readTopLevelList(text, "mustNot"),
    minTextCoverage: readNumber(metrics.get("minTextCoverage")),
    maxReadingOrderDistance: readNumber(metrics.get("maxReadingOrderDistance")),
    maxCharacterErrorRate: readNumber(metrics.get("maxCharacterErrorRate")),
    maxOcrCharacterErrorRate: readNumber(metrics.get("maxOcrCharacterErrorRate")),
    maxOcrWordErrorRate: readNumber(metrics.get("maxOcrWordErrorRate")),
    maxUnexpectedWarnings: readNumber(metrics.get("maxUnexpectedWarnings")),
    minRunningContentPrecision: readNumber(metrics.get("minRunningContentPrecision")),
    minRunningContentRecall: readNumber(metrics.get("minRunningContentRecall")),
    minTableCellAdjacency: readNumber(metrics.get("minTableCellAdjacency")),
    minTableCsvCellTextAccuracy: readNumber(metrics.get("minTableCsvCellTextAccuracy")),
    minTableSpanAccuracy: readNumber(metrics.get("minTableSpanAccuracy")),
    maxRssDeltaBytes: readNumber(metrics.get("maxRssDeltaBytes")),
    maxHeapUsedDeltaBytes: readNumber(metrics.get("maxHeapUsedDeltaBytes")),
    minTaggedMarkedContent: readNumber(metrics.get("minTaggedMarkedContent")),
    maxTaggedStructureConflicts: readNumber(metrics.get("maxTaggedStructureConflicts")),
    minRenderedHtmlTextChars: readNumber(metrics.get("minRenderedHtmlTextChars")),
    minRenderedHtmlHeadings: readNumber(metrics.get("minRenderedHtmlHeadings")),
    minRenderedHtmlParagraphs: readNumber(metrics.get("minRenderedHtmlParagraphs")),
    maxRenderedHtmlParagraphChars: readNumber(metrics.get("maxRenderedHtmlParagraphChars")),
    snippets: readSnippetAssertions(text),
    warningsAllowed: readNestedList(text, "warnings", "allowed"),
    structureExpected: readNestedList(text, "structure", "expected"),
    structureHeadings: readNestedList(text, "structure", "headings"),
    structureTables: readNestedList(text, "structure", "tables"),
    forms: readStructureForms(text),
    assetsRequired: readNestedList(text, "assets", "required"),
    runningContent: {
      expectedRemoved: readNestedList(text, "runningContent", "expectedRemoved"),
      expectedRetained: readNestedList(text, "runningContent", "expectedRetained")
    },
    humanReviewedBy: review.get("humanReviewedBy") ?? "",
    reviewedAt: review.get("reviewedAt") ?? "",
    skipReason: scalars.get("skipReason") ?? ""
  };
}

async function loadAcceptance(entry) {
  const text = await readFile(path.join(repoRoot, entry.acceptanceFile), "utf8");
  return parseAcceptanceText(text);
}

async function loadCases() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const cases = [];
  for (const entry of manifest.entries) {
    cases.push({
      entry,
      acceptance: await loadAcceptance(entry)
    });
  }
  return cases;
}

function selectCases(cases) {
  const idSet = new Set(selectedIds);
  const selected = [];
  const skipped = [];

  for (const corpusCase of cases) {
    let reason = null;
    if (idSet.size > 0 && !idSet.has(corpusCase.entry.id)) {
      reason = "id-filter: not requested by --id";
    }
    if (!reason && isLocalOnlyEntry(corpusCase.entry)) {
      reason = formatAcceptanceSkip(corpusCase, "local-only");
    }
    if (!reason && !corpusCase.acceptance.gating) {
      reason = formatAcceptanceSkip(corpusCase, "non-gating");
    }
    if (!reason && corpusCase.acceptance.expectedMode === "unsupported") {
      reason = formatAcceptanceSkip(corpusCase, "unsupported");
    }
    if (!reason && selectedGate && corpusCase.acceptance.gate !== selectedGate) {
      reason =
        `gate-filter: acceptance gate ${corpusCase.acceptance.gate} does not match selected gate ${selectedGate}`;
    }

    if (reason) {
      skipped.push({ ...corpusCase, reason });
    } else {
      selected.push(corpusCase);
    }
  }

  for (const id of idSet) {
    if (!cases.some((corpusCase) => corpusCase.entry.id === id)) {
      throw new Error(`unknown manifest id "${id}"`);
    }
  }

  return { selected, skipped };
}

function isLocalOnlyEntry(entry) {
  return (
    entry.redistributable === false ||
    entry.source?.type === "local-only" ||
    /(^|\/)local-only(\/|$)/.test(entry.path)
  );
}

function formatAcceptanceSkip(corpusCase, code) {
  const detail = corpusCase.acceptance.skipReason || "missing acceptance skipReason";
  return `${code}: ${detail}`;
}

function printCase(prefix, corpusCase) {
  const { entry, acceptance } = corpusCase;
  console.log(
    `${prefix} ${entry.id} gate=${acceptance.gate} gating=${acceptance.gating} kind=${entry.kind} path=${entry.path}`
  );
}

async function runCase(corpusCase) {
  const { entry, acceptance } = corpusCase;
  const ocrResults = entry.ocrResultsFile ? await readOcrResults(entry) : null;
  const conversionOptions = {
    ocr: ocrResults ? { results: ocrResults } : { enabled: false },
    ...(acceptance.must.includes("repair_damaged_xref")
      ? { parser: { mode: "tolerant" } }
      : {}),
    ...(acceptance.must.includes("preserve_page_anchors")
      ? { markdown: { pageAnchors: true } }
      : {})
  };
  const memoryBefore = process.memoryUsage();
  const result = await convertPdfToMarkdown(
    path.join(repoRoot, entry.path),
    conversionOptions
  );
  const memoryAfter = process.memoryUsage();
  const errors = [];
  const details = [];
  const expected = await readOptionalExpectedMarkdown(entry);
  const sourceOracleText = await readTextOracle(entry, expected);
  const oracleText = expected === null
    ? sourceOracleText
    : markdownToComparableText(expected);
  const comparisonText = expected ?? sourceOracleText;
  const evidence = {
    expectedMarkdownMatch: expected === null ? null : result.markdown === expected,
    rssDeltaBytes: Math.max(0, memoryAfter.rss - memoryBefore.rss),
    heapUsedDeltaBytes: Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed)
  };

  if (acceptance.id !== entry.id) {
    errors.push(`acceptance id mismatch: expected ${entry.id}, got ${acceptance.id}`);
  }

  if (result.ir.sourceType !== acceptance.sourceType) {
    errors.push(
      `sourceType mismatch: expected ${acceptance.sourceType}, got ${result.ir.sourceType}`
    );
  }

  if (result.diagnostics.input.sha256 !== entry.sha256) {
    errors.push(`sha256 mismatch: expected ${entry.sha256}, got ${result.diagnostics.input.sha256}`);
  }

  if (result.diagnostics.input.bytes !== entry.bytes) {
    errors.push(`byte mismatch: expected ${entry.bytes}, got ${result.diagnostics.input.bytes}`);
  }

  if (result.diagnostics.input.pdfVersion !== entry.pdfVersion) {
    errors.push(
      `PDF version mismatch: expected ${entry.pdfVersion}, got ${result.diagnostics.input.pdfVersion}`
    );
  }

  if (assertMarkdown) {
    if (expected === null) {
      errors.push(`missing Markdown snapshot at corpus/expected/${entry.id}.md`);
    } else if (result.markdown !== expected) {
      errors.push(`Markdown snapshot mismatch against corpus/expected/${entry.id}.md`);
    } else {
      details.push("markdown=match");
    }
  }

  const textCoverage = compareTextCoverage(oracleText, result.markdown);
  const readingOrder = compareReadingOrder(oracleText, result.markdown);
  const characterError = compareCharacterErrorRate(comparisonText, result.markdown);
  evidence.textCoverage = textCoverage;
  evidence.readingOrder = readingOrder;
  evidence.characterError = characterError;
  evidence.textPrecision =
    textCoverage.actualTokens === 0
      ? textCoverage.oracleTokens === 0
        ? 1
        : 0
      : textCoverage.matchedTokens / textCoverage.actualTokens;
  evidence.textCoveragePassed =
    acceptance.minTextCoverage !== null &&
    textCoverage.coverage + Number.EPSILON >= acceptance.minTextCoverage;
  evidence.readingOrderPassed =
    acceptance.maxReadingOrderDistance === null
      ? evidence.expectedMarkdownMatch
      : readingOrder.readingOrderDistance <=
        acceptance.maxReadingOrderDistance + Number.EPSILON;
  evidence.characterErrorPassed =
    acceptance.maxCharacterErrorRate === null
      ? evidence.expectedMarkdownMatch
      : characterError.characterErrorRate <=
        acceptance.maxCharacterErrorRate + Number.EPSILON;

  if (acceptance.minTextCoverage === null) {
    errors.push("missing executable metrics.minTextCoverage threshold");
  } else if (!evidence.textCoveragePassed) {
    errors.push(
      `text coverage ${formatNumber(textCoverage.coverage)} below ${formatNumber(
        acceptance.minTextCoverage
      )} (${textCoverage.matchedTokens}/${textCoverage.oracleTokens} oracle tokens matched)`
    );
  }
  details.push(
    `textCoverage=${formatNumber(textCoverage.coverage)} min=${formatNumber(
      acceptance.minTextCoverage
    )} precision=${formatNumber(evidence.textPrecision)}`
  );

  if (
    acceptance.maxReadingOrderDistance !== null &&
    !evidence.readingOrderPassed
  ) {
    errors.push(
      `reading order distance ${formatNumber(readingOrder.readingOrderDistance)} above ${formatNumber(
        acceptance.maxReadingOrderDistance
      )}`
    );
  }
  if (acceptance.maxReadingOrderDistance !== null) {
    details.push(
      `readingOrderDistance=${formatNumber(readingOrder.readingOrderDistance)} max=${formatNumber(
        acceptance.maxReadingOrderDistance
      )}`
    );
  }

  if (acceptance.maxCharacterErrorRate !== null && !evidence.characterErrorPassed) {
    errors.push(
      `character error rate ${formatNumber(characterError.characterErrorRate)} above ${formatNumber(
        acceptance.maxCharacterErrorRate
      )}`
    );
  }
  if (acceptance.maxCharacterErrorRate !== null) {
    details.push(
      `characterErrorRate=${formatNumber(characterError.characterErrorRate)} max=${formatNumber(
        acceptance.maxCharacterErrorRate
      )}`
    );
  }

  enforceMaximumMetric(
    errors,
    details,
    "rssDeltaBytes",
    evidence.rssDeltaBytes,
    acceptance.maxRssDeltaBytes
  );
  enforceMaximumMetric(
    errors,
    details,
    "heapUsedDeltaBytes",
    evidence.heapUsedDeltaBytes,
    acceptance.maxHeapUsedDeltaBytes
  );

  const renderedHtml = evaluateRenderedHtml(
    analyzeRenderedHtml(renderMarkdownToHtml(result.markdown)),
    acceptance
  );
  evidence.renderedHtml = renderedHtml;
  if (hasRenderedHtmlMetrics(acceptance)) {
    for (const failure of renderedHtml.failures) {
      errors.push(
        `rendered HTML ${failure.metric} ${failure.actual} must be ${failure.operator} ${failure.limit}`
      );
    }
    details.push(
      `renderedHtml=text:${renderedHtml.textChars} headings:${renderedHtml.headingCount} paragraphs:${renderedHtml.paragraphCount}`
    );
  }

  const taggedStructure = compareTaggedStructure(result.diagnostics.extraction, acceptance);
  evidence.taggedStructure = taggedStructure;
  if (hasTaggedStructureMetrics(acceptance) && !taggedStructure.passed) {
    errors.push(
      `tagged structure failed: tagged=${taggedStructure.tagged} markedContent=${taggedStructure.markedContent}/${formatNumber(
        acceptance.minTaggedMarkedContent
      )} conflicts=${taggedStructure.taggedStructureConflicts}/${formatNumber(
        acceptance.maxTaggedStructureConflicts
      )}`
    );
  }

  if (hasRunningContentLabels(acceptance)) {
    const runningContent = compareRunningContent(
      sourceOracleText,
      result.markdown,
      acceptance.runningContent
    );
    const minPrecision = acceptance.minRunningContentPrecision ?? 1;
    const minRecall = acceptance.minRunningContentRecall ?? 1;
    runningContent.passed =
      runningContent.precision + Number.EPSILON >= minPrecision &&
      runningContent.recall + Number.EPSILON >= minRecall;
    evidence.runningContent = runningContent;
    if (!runningContent.passed) {
      errors.push(
        `running-content precision/recall ${formatNumber(runningContent.precision)}/${formatNumber(
          runningContent.recall
        )} below ${formatNumber(minPrecision)}/${formatNumber(minRecall)}`
      );
    }
    details.push(
      `runningContent=${formatNumber(runningContent.precision)}/${formatNumber(
        runningContent.recall
      )}`
    );
  }

  if (acceptance.maxOcrCharacterErrorRate !== null || acceptance.maxOcrWordErrorRate !== null) {
    const ocrAccuracy = compareOcrAccuracy(comparisonText, result.markdown);
    evidence.ocrAccuracy = ocrAccuracy;
    evidence.ocrAccuracyPassed = true;
    if (
      acceptance.maxOcrCharacterErrorRate !== null &&
      ocrAccuracy.characterErrorRate - Number.EPSILON > acceptance.maxOcrCharacterErrorRate
    ) {
      evidence.ocrAccuracyPassed = false;
      errors.push(
        `OCR character error rate ${formatNumber(ocrAccuracy.characterErrorRate)} above ${formatNumber(
          acceptance.maxOcrCharacterErrorRate
        )} (${ocrAccuracy.characterEdits}/${ocrAccuracy.expectedCharacters} expected characters edited)`
      );
    }
    if (
      acceptance.maxOcrWordErrorRate !== null &&
      ocrAccuracy.wordErrorRate - Number.EPSILON > acceptance.maxOcrWordErrorRate
    ) {
      evidence.ocrAccuracyPassed = false;
      errors.push(
        `OCR word error rate ${formatNumber(ocrAccuracy.wordErrorRate)} above ${formatNumber(
          acceptance.maxOcrWordErrorRate
        )} (${ocrAccuracy.wordEdits}/${ocrAccuracy.expectedWords} expected words edited)`
      );
    }
    details.push(
      `ocrCER=${formatNumber(ocrAccuracy.characterErrorRate)} max=${formatNumber(
        acceptance.maxOcrCharacterErrorRate
      )} edits=${ocrAccuracy.characterEdits}/${ocrAccuracy.expectedCharacters}`
    );
    details.push(
      `ocrWER=${formatNumber(ocrAccuracy.wordErrorRate)} max=${formatNumber(
        acceptance.maxOcrWordErrorRate
      )} edits=${ocrAccuracy.wordEdits}/${ocrAccuracy.expectedWords}`
    );
  }

  if (acceptance.minTableCellAdjacency !== null) {
    const adjacency = expected === null
      ? null
      : compareTableCellAdjacency(expected, result.markdown);
    if (!adjacency) {
      errors.push("table adjacency requires a reviewed Markdown snapshot");
    } else {
      evidence.tableCellAdjacency = adjacency;
      if (adjacency.score + Number.EPSILON < acceptance.minTableCellAdjacency) {
        errors.push(
          `table cell adjacency ${formatNumber(adjacency.score)} below ${formatNumber(
            acceptance.minTableCellAdjacency
          )} (${adjacency.matchedPairs}/${adjacency.expectedPairs} expected pairs matched)`
        );
      }
      details.push(
        `tableCellAdjacency=${formatNumber(adjacency.score)} min=${formatNumber(
          acceptance.minTableCellAdjacency
        )} matched=${adjacency.matchedPairs}/${adjacency.expectedPairs}`
      );
    }
  }

  if (acceptance.minTableSpanAccuracy !== null) {
    const spanAccuracy = expected === null
      ? null
      : compareTableSpanAccuracy(expected, result.markdown);
    if (!spanAccuracy) {
      errors.push("table span accuracy requires a reviewed Markdown snapshot");
    } else {
      evidence.tableSpanAccuracy = spanAccuracy;
      if (spanAccuracy.score + Number.EPSILON < acceptance.minTableSpanAccuracy) {
        errors.push(
          `table span accuracy ${formatNumber(spanAccuracy.score)} below ${formatNumber(
            acceptance.minTableSpanAccuracy
          )} (${spanAccuracy.matchedCells}/${spanAccuracy.expectedCells} expected cells matched)`
        );
      }
      details.push(
        `tableSpanAccuracy=${formatNumber(spanAccuracy.score)} min=${formatNumber(
          acceptance.minTableSpanAccuracy
        )} matched=${spanAccuracy.matchedCells}/${spanAccuracy.expectedCells}`
      );
    }
  }

  if (acceptance.minTableCsvCellTextAccuracy !== null) {
    const csvAccuracy = expected === null
      ? null
      : compareTableCsvCellTextAccuracy(expected, result.assets);
    if (!csvAccuracy) {
      errors.push("table CSV accuracy requires a reviewed Markdown snapshot");
    } else {
      evidence.tableCsvCellTextAccuracy = csvAccuracy;
      if (csvAccuracy.score + Number.EPSILON < acceptance.minTableCsvCellTextAccuracy) {
        errors.push(
          `table CSV cell text accuracy ${formatNumber(csvAccuracy.score)} below ${formatNumber(
            acceptance.minTableCsvCellTextAccuracy
          )} (${csvAccuracy.matchedCells}/${csvAccuracy.expectedCells} expected cells matched)`
        );
      }
      details.push(
        `tableCsvCellTextAccuracy=${formatNumber(csvAccuracy.score)} min=${formatNumber(
          acceptance.minTableCsvCellTextAccuracy
        )} matched=${csvAccuracy.matchedCells}/${csvAccuracy.expectedCells}`
      );
    }
  }

  evidence.matchedForms = 0;
  if (acceptance.forms.length > 0) {
    const fieldsByName = new Map(
      result.diagnostics.extraction.forms.fields.map((field) => [field.name, field])
    );
    let matchedForms = 0;
    for (const expectedForm of acceptance.forms) {
      const actual = fieldsByName.get(expectedForm.name);
      if (!actual) {
        errors.push(`missing form field ${expectedForm.name}`);
        continue;
      }
      let matched = true;
      for (const [key, expectedValue] of Object.entries(expectedForm)) {
        if (actual[key] !== expectedValue) {
          errors.push(
            `form field ${expectedForm.name}.${key} expected ${JSON.stringify(
              expectedValue
            )}, got ${JSON.stringify(actual[key])}`
          );
          matched = false;
        }
      }
      if (matched) {
        matchedForms += 1;
      }
    }
    evidence.matchedForms = matchedForms;
    details.push(`forms=${matchedForms}/${acceptance.forms.length}`);
  }

  const criterionContext = {
    acceptance,
    entry,
    evidence,
    result
  };
  const outputChecks = checkAcceptanceOutput(acceptance, result, criterionContext);
  errors.push(...outputChecks.errors);
  details.push(...outputChecks.details);

  const expectedModeErrors = evaluateExpectedMode(acceptance.expectedMode, criterionContext);
  errors.push(...expectedModeErrors);
  if (expectedModeErrors.length === 0) {
    details.push(`expectedMode=${acceptance.expectedMode}`);
  }

  const structureChecks = evaluateStructureExpectations(
    acceptance.structureExpected,
    criterionContext
  );
  errors.push(...structureChecks.errors);
  if (acceptance.structureExpected.length > 0) {
    details.push(`structure=${structureChecks.checked}/${acceptance.structureExpected.length}`);
  }

  const assetChecks = checkRequiredAssets(acceptance.assetsRequired, result.assets ?? []);
  errors.push(...assetChecks.errors);
  if (acceptance.assetsRequired.length > 0) {
    details.push(`assets=${assetChecks.matched}/${acceptance.assetsRequired.length}`);
  }

  errors.push(...checkNamedStructureText(acceptance, result));

  if (
    acceptance.gating &&
    (!acceptance.humanReviewedBy || !/^\d{4}-\d{2}-\d{2}$/.test(acceptance.reviewedAt))
  ) {
    errors.push("gating acceptance requires executable review provenance");
  }

  if (errors.length > 0) {
    throw new Error(`${entry.id}: ${errors.join("; ")}`);
  }

  console.log(
    `PASS ${entry.id} bytes=${entry.bytes} pdfVersion=${entry.pdfVersion}${
      details.length > 0 ? ` ${details.join(" ")}` : ""
    }`
  );
}

export function checkAcceptanceOutput(acceptance, result, criterionContext = null) {
  const errors = [];
  const details = [];
  const context = criterionContext ?? {
    acceptance,
    entry: { features: [] },
    evidence: {
      textCoveragePassed: /[\p{L}\p{N}]/u.test(result.markdown ?? ""),
      textPrecision: /[\p{L}\p{N}]/u.test(result.markdown ?? "") ? 1 : 0
    },
    result
  };
  const criteriaResult = evaluateAcceptanceCriteria(acceptance, context);
  errors.push(...criteriaResult.errors);

  const snippetResult = checkSnippets(acceptance.snippets, result);
  errors.push(...snippetResult.errors);
  if (acceptance.snippets.length > 0) {
    details.push(`snippets=${snippetResult.matched}/${acceptance.snippets.length}`);
  }

  const warningResult = checkWarnings(acceptance, result.warnings ?? []);
  errors.push(...warningResult.errors);
  if (acceptance.maxUnexpectedWarnings !== null || acceptance.warningsAllowed.length > 0) {
    details.push(
      `warnings=unexpected:${warningResult.unexpectedCount} allowed:${acceptance.warningsAllowed.length}`
    );
  }

  if (acceptance.must.length > 0 || acceptance.mustNot.length > 0) {
    details.push(
      `criteria=${criteriaResult.checked}/${acceptance.must.length + acceptance.mustNot.length}`
    );
  }

  return { errors, details };
}

function checkSnippets(snippets, result) {
  const errors = [];
  let matched = 0;
  for (const snippet of snippets) {
    const contains = typeof snippet.contains === "string" ? snippet.contains : "";
    const page = Number.parseInt(snippet.page, 10);
    if (!contains) {
      errors.push("snippet assertion is missing contains text");
      continue;
    }
    if (!Number.isInteger(page) || page < 1) {
      errors.push(`snippet "${contains}" has invalid page ${JSON.stringify(snippet.page)}`);
      continue;
    }
    if (!result.markdown.includes(contains)) {
      errors.push(`missing snippet on page ${page}: ${JSON.stringify(contains)}`);
      continue;
    }
    if (!snippetAppearsOnPage(result, contains, page - 1)) {
      errors.push(`snippet found on wrong or unmapped page ${page}: ${JSON.stringify(contains)}`);
      continue;
    }
    matched += 1;
  }
  return { errors, matched };
}

function snippetAppearsOnPage(result, text, pageIndex) {
  const entries = result.sourceMap?.entries ?? [];
  let index = result.markdown.indexOf(text);
  while (index !== -1) {
    const end = index + text.length;
    if (
      entries.some(
        (entry) =>
          rangesOverlap(index, end, entry.markdownStart, entry.markdownEnd) &&
          entry.regions?.some((region) => region.pageIndex === pageIndex)
      )
    ) {
      return true;
    }
    index = result.markdown.indexOf(text, index + 1);
  }
  return false;
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function checkWarnings(acceptance, warnings) {
  const allowed = new Set(acceptance.warningsAllowed);
  const unexpected = warnings.filter(
    (warning) => !runnerBaselineWarnings.has(warning.code) && !allowed.has(warning.code)
  );
  const errors = [];
  if (
    acceptance.maxUnexpectedWarnings !== null &&
    unexpected.length > acceptance.maxUnexpectedWarnings
  ) {
    errors.push(
      `unexpected warning count ${unexpected.length} above ${acceptance.maxUnexpectedWarnings}: ${[
        ...new Set(unexpected.map((warning) => warning.code))
      ]
        .sort()
        .join(", ")}`
    );
  }
  return {
    errors,
    unexpectedCount: unexpected.length
  };
}

function enforceMaximumMetric(errors, details, name, actual, maximum) {
  if (maximum === null) {
    return;
  }
  if (actual > maximum) {
    errors.push(`${name} ${actual} above ${maximum}`);
  }
  details.push(`${name}=${actual} max=${maximum}`);
}

function hasRenderedHtmlMetrics(acceptance) {
  return [
    acceptance.minRenderedHtmlTextChars,
    acceptance.minRenderedHtmlHeadings,
    acceptance.minRenderedHtmlParagraphs,
    acceptance.maxRenderedHtmlParagraphChars
  ].some(Number.isFinite);
}

function hasTaggedStructureMetrics(acceptance) {
  return (
    Number.isFinite(acceptance.minTaggedMarkedContent) ||
    Number.isFinite(acceptance.maxTaggedStructureConflicts)
  );
}

function hasRunningContentLabels(acceptance) {
  return (
    acceptance.runningContent.expectedRemoved.length > 0 ||
    acceptance.runningContent.expectedRetained.length > 0
  );
}

function checkRequiredAssets(requiredAssets, assets) {
  const errors = [];
  let matched = 0;
  for (const required of requiredAssets) {
    const asset = assets.find(
      (candidate) =>
        candidate.id === required || candidate.kind === required || candidate.path === required
    );
    if (!asset) {
      errors.push(`missing required asset ${JSON.stringify(required)}`);
    } else {
      matched += 1;
    }
  }
  return { errors, matched };
}

function checkNamedStructureText(acceptance, result) {
  const errors = [];
  for (const heading of acceptance.structureHeadings) {
    const escaped = escapeRegExp(heading);
    if (!new RegExp(`^#{1,6}\\s+${escaped}(?:\\s|$)`, "mi").test(result.markdown)) {
      errors.push(`missing required structure heading ${JSON.stringify(heading)}`);
    }
  }
  for (const tableText of acceptance.structureTables) {
    if (!result.markdown.includes(tableText)) {
      errors.push(`missing required structure table text ${JSON.stringify(tableText)}`);
    }
  }
  return errors;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readOptionalExpectedMarkdown(entry) {
  const expectedPath = path.join(repoRoot, "corpus", "expected", `${entry.id}.md`);
  try {
    return await readFile(expectedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `${entry.id}: expected Markdown is not readable at ${expectedPath}: ${error.message}`
    );
  }
}

async function readTextOracle(entry, expected) {
  const oraclePath = path.join(
    repoRoot,
    "corpus",
    "baselines",
    entry.id,
    "oracles",
    "pdftotext.txt"
  );
  try {
    return await readFile(oraclePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && expected !== null) {
      return expected;
    }
    throw new Error(`${entry.id}: text oracle is not readable at ${oraclePath}: ${error.message}`);
  }
}

async function readOcrResults(entry) {
  const ocrPath = path.join(repoRoot, entry.ocrResultsFile);
  try {
    const payload = JSON.parse(await readFile(ocrPath, "utf8"));
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload.results)) {
      return payload.results;
    }
    throw new Error("expected a JSON array or an object with a results array");
  } catch (error) {
    throw new Error(`${entry.id}: OCR results are not readable at ${ocrPath}: ${error.message}`);
  }
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "n/a";
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(usage());
    return;
  }

  if (updateSnapshots) {
    console.error(
      "--update-snapshots is reserved; snapshot updates are not implemented. Update corpus fixtures through reviewed changes instead."
    );
    process.exit(1);
  }

  if (!listOnly && !hasFlag("--all") && !selectedGate && selectedIds.length === 0) {
    console.error(usage());
    process.exit(1);
  }

  const cases = await loadCases();
  const { selected, skipped } = selectCases(cases);

  if (listOnly || dryRun) {
    for (const corpusCase of selected) {
      printCase("SELECT", corpusCase);
    }
    for (const corpusCase of skipped) {
      console.log(`SKIP ${corpusCase.entry.id} reason=${corpusCase.reason}`);
    }
    console.log(`Selected ${selected.length}; skipped ${skipped.length}.`);
    return;
  }

  for (const corpusCase of selected) {
    await runCase(corpusCase);
  }
  console.log(`Corpus run passed: ${selected.length}; skipped ${skipped.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
