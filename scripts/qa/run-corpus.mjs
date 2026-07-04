import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { convertPdfToMarkdown, warningCodes } from "../../packages/pdf2md/src/index.mjs";
import { compareOcrAccuracy } from "./ocr-accuracy.mjs";
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
const supportedMustCriteria = new Set([
  "decrypt_with_known_user_password",
  "detect_borderless_table",
  "detect_cell_span",
  "detect_columns",
  "detect_footnote_region",
  "detect_repeated_footer",
  "detect_repeated_header",
  "detect_vector_figure_region",
  "detect_visible_table",
  "emit_bidi_markup",
  "emit_csv_sidecar",
  "emit_gfm_table",
  "emit_html_table",
  "emit_vertical_writing_markup",
  "extract_acroform_fields",
  "extract_bullet_list",
  "extract_cjk_text",
  "extract_headings",
  "extract_main_text",
  "extract_ocr_text",
  "extract_rtl_text",
  "extract_title",
  "extract_updated_revision_text",
  "extract_vertical_text",
  "follow_prev_xref_chain",
  "follow_xref_prev_chain",
  "join_cjk_wrapped_lines_without_spaces",
  "meet_ocr_error_thresholds",
  "normalize_coordinates",
  "prefer_aligned_hidden_text",
  "prefer_newest_object_revision",
  "preserve_appendices",
  "preserve_body_text",
  "preserve_button_states",
  "preserve_caption",
  "preserve_column_alignment",
  "preserve_continued_table_rows",
  "preserve_decrypted_text_order",
  "preserve_field_values",
  "preserve_footnote_text",
  "preserve_heading",
  "preserve_left_then_right_reading_order",
  "preserve_list_order",
  "preserve_lists",
  "preserve_nist_publication_identifier",
  "preserve_page_anchors",
  "preserve_paragraph_order",
  "preserve_references",
  "preserve_rtl_reading_order",
  "preserve_section_headings",
  "preserve_table_cells",
  "preserve_table_note",
  "preserve_tables",
  "preserve_tagged_pdf_signal",
  "preserve_vertical_column_order",
  "preserve_visible_crop_text",
  "preserve_withdrawn_notice",
  "read_rotated_page",
  "repair_damaged_xref",
  "repair_line_end_hyphenation",
  "report_form_metadata",
  "require_password_before_extraction",
  "resolve_linearized_pdf",
  "resolve_object_stream",
  "resolve_qpdf_object_stream",
  "resolve_qpdf_xref_stream",
  "resolve_xref_stream",
  "respect_crop_box",
  "route_as_hybrid",
  "route_as_scanned",
  "scan_indirect_objects",
  "use_ocr_for_bad_hidden_region"
]);
const supportedMustNotCriteria = new Set([
  "bypass_encryption_without_password",
  "drop_authenticator_requirement_tables",
  "drop_bidi_markup",
  "drop_checked_state",
  "drop_compressed_page_objects",
  "drop_continued_rows",
  "drop_rotated_text",
  "drop_spanned_header",
  "drop_table_note",
  "drop_title_page_metadata",
  "drop_vertical_writing_markup",
  "emit_bad_hidden_text",
  "emit_binary_garbage",
  "emit_broken_gfm_for_spans",
  "emit_empty_markdown",
  "emit_ocr_duplicate_text",
  "fall_back_to_unstructured_binary_scan",
  "flatten_all_sections_into_one_paragraph",
  "flatten_table_to_unstructured_paragraph",
  "flatten_vertical_columns",
  "fold_note_into_table",
  "ignore_newest_xref_revision",
  "insert_synthetic_cjk_spaces",
  "interleave_columns_line_by_line",
  "interleave_footnote_inside_body_sentence",
  "invent_chart_data",
  "invent_missing_form_values",
  "invent_missing_values",
  "keep_unrepaired_line_end_hyphen",
  "merge_adjacent_columns",
  "merge_rows_across_columns",
  "move_caption_before_body",
  "omit_withdrawn_notice",
  "prefer_hidden_media_box_content",
  "repeat_running_header_in_body",
  "reverse_rtl_fragments",
  "split_wrapped_cjk_paragraph",
  "treat_acroform_metadata_as_user_filled_values",
  "trust_repaired_output_without_diagnostics",
  "use_stale_page_tree"
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
  --update-snapshots         Reserved for future Markdown/IR snapshot updates.
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
  return {
    id: scalars.get("id"),
    gate: scalars.get("gate"),
    sourceType: scalars.get("sourceType"),
    expectedMode: scalars.get("expectedMode"),
    gating: scalars.get("gating") === "true",
    must: readTopLevelList(text, "must"),
    mustNot: readTopLevelList(text, "mustNot"),
    maxOcrCharacterErrorRate: readNumber(metrics.get("maxOcrCharacterErrorRate")),
    maxOcrWordErrorRate: readNumber(metrics.get("maxOcrWordErrorRate")),
    maxUnexpectedWarnings: readNumber(metrics.get("maxUnexpectedWarnings")),
    minTableCellAdjacency: readNumber(metrics.get("minTableCellAdjacency")),
    minTableCsvCellTextAccuracy: readNumber(metrics.get("minTableCsvCellTextAccuracy")),
    minTableSpanAccuracy: readNumber(metrics.get("minTableSpanAccuracy")),
    snippets: readSnippetAssertions(text),
    warningsAllowed: readNestedList(text, "warnings", "allowed"),
    forms: readStructureForms(text),
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
  const result = await convertPdfToMarkdown(path.join(repoRoot, entry.path), {
    ocr: ocrResults ? { results: ocrResults } : { enabled: false }
  });
  const errors = [];
  const details = [];
  let expected = null;

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

  if (
    assertMarkdown ||
    acceptance.maxOcrCharacterErrorRate !== null ||
    acceptance.maxOcrWordErrorRate !== null ||
    acceptance.minTableCellAdjacency !== null ||
    acceptance.minTableCsvCellTextAccuracy !== null ||
    acceptance.minTableSpanAccuracy !== null
  ) {
    expected = await readExpectedMarkdown(entry);
  }

  if (assertMarkdown) {
    if (result.markdown !== expected) {
      errors.push(`Markdown snapshot mismatch against corpus/expected/${entry.id}.md`);
    } else {
      details.push("markdown=match");
    }
  }

  if (acceptance.maxOcrCharacterErrorRate !== null || acceptance.maxOcrWordErrorRate !== null) {
    const ocrAccuracy = compareOcrAccuracy(expected, result.markdown);
    if (
      acceptance.maxOcrCharacterErrorRate !== null &&
      ocrAccuracy.characterErrorRate - Number.EPSILON > acceptance.maxOcrCharacterErrorRate
    ) {
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
    const adjacency = compareTableCellAdjacency(expected, result.markdown);
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

  if (acceptance.minTableSpanAccuracy !== null) {
    const spanAccuracy = compareTableSpanAccuracy(expected, result.markdown);
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

  if (acceptance.minTableCsvCellTextAccuracy !== null) {
    const csvAccuracy = compareTableCsvCellTextAccuracy(expected, result.assets);
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

  const outputChecks = checkAcceptanceOutput(acceptance, result);
  errors.push(...outputChecks.errors);
  details.push(...outputChecks.details);

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
    details.push(`forms=${matchedForms}/${acceptance.forms.length}`);
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

export function checkAcceptanceOutput(acceptance, result) {
  const errors = [];
  const details = [];
  errors.push(...findUnsupportedCriteria(acceptance.must, supportedMustCriteria, "must"));
  errors.push(...findUnsupportedCriteria(acceptance.mustNot, supportedMustNotCriteria, "mustNot"));

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
    details.push(`criteria=must:${acceptance.must.length} mustNot:${acceptance.mustNot.length}`);
  }

  return { errors, details };
}

function findUnsupportedCriteria(criteria, supported, blockName) {
  return criteria
    .filter((criterion) => !supported.has(criterion))
    .map(
      (criterion) =>
        `unsupported acceptance ${blockName} criterion "${criterion}" without a corpus runner checker`
    );
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
  if (entries.length === 0) {
    return true;
  }
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

async function readExpectedMarkdown(entry) {
  const expectedPath = path.join(repoRoot, "corpus", "expected", `${entry.id}.md`);
  try {
    return await readFile(expectedPath, "utf8");
  } catch (error) {
    throw new Error(`${entry.id}: expected Markdown is not readable at ${expectedPath}: ${error.message}`);
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

  if (updateSnapshots) {
    console.log("Snapshot updates are not implemented in the scaffold runner yet.");
  }

  for (const corpusCase of selected) {
    await runCase(corpusCase);
  }
  console.log(`Corpus run passed: ${selected.length}; skipped ${skipped.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
