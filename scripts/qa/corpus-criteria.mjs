function passWhen(predicate) {
  return (context) => Boolean(predicate(context));
}

function extraction(context) {
  return context.result.diagnostics?.extraction ?? {};
}

function parser(context) {
  return extraction(context).parser ?? {};
}

function reconciliation(context) {
  return extraction(context).ocr?.reconciliation ?? {};
}

function tables(context) {
  return extraction(context).tables ?? [];
}

function figures(context) {
  return extraction(context).figures ?? { figures: [] };
}

function forms(context) {
  return extraction(context).forms ?? { fields: [] };
}

function layoutPages(context) {
  return extraction(context).layout?.pages ?? [];
}

function diagnosticPages(context) {
  return context.result.diagnostics?.pages ?? [];
}

function sourceMapEntries(context) {
  return context.result.sourceMap?.entries ?? [];
}

function hasText(context) {
  return /[\p{L}\p{N}]/u.test(context.result.markdown ?? "");
}

function hasHeading(context, level = null) {
  const pattern = level === null
    ? /^#{1,6}\s+\S/m
    : new RegExp(`^#{${level}}\\s+\\S`, "m");
  return pattern.test(context.result.markdown ?? "");
}

function hasParagraph(context) {
  return sourceMapEntries(context).some((entry) => entry.kind === "paragraph");
}

function hasMultipleDocumentBlocks(context) {
  return sourceMapEntries(context).filter((entry) => entry.kind !== "page_anchor").length >= 2;
}

function hasList(context) {
  return (
    sourceMapEntries(context).some((entry) => entry.kind === "list") ||
    /^\s*(?:[-*]|\d+[.)])\s+\S/m.test(context.result.markdown ?? "")
  );
}

function hasTable(context) {
  return tables(context).length > 0 || hasGfmTable(context) || hasHtmlTable(context);
}

function hasGfmTable(context) {
  return /^\|.*\|\n\|\s*:?-{3,}/m.test(context.result.markdown ?? "");
}

function hasHtmlTable(context) {
  return /<table>[\s\S]*<\/table>/i.test(context.result.markdown ?? "");
}

function hasSpannedTable(context) {
  return /<(?:th|td)\s+[^>]*(?:rowspan|colspan)="[2-9]\d*"/i.test(
    context.result.markdown ?? ""
  );
}

function hasCsvSidecar(context) {
  return (context.result.assets ?? []).some((asset) => asset.kind === "table-csv");
}

function hasColumns(context) {
  return layoutPages(context).some(
    (page) =>
      page.kind === "multi-column" ||
      page.kind === "mixed" ||
      (page.columns?.length ?? 0) >= 2
  );
}

function hasFootnote(context) {
  return layoutPages(context).some((page) => (page.footnotes?.length ?? 0) > 0);
}

function hasFigure(context) {
  return (figures(context).total ?? figures(context).figures?.length ?? 0) > 0;
}

function hasVectorFigure(context) {
  return (figures(context).vectorFigures ?? 0) > 0;
}

function hasCaption(context) {
  return (
    (figures(context).figures ?? []).some((figure) => Boolean(figure.caption)) ||
    layoutPages(context).some((page) => (page.captions?.length ?? 0) > 0)
  );
}

function hasBidiMarkup(context) {
  return /<p\s+dir="rtl">/i.test(context.result.markdown ?? "");
}

function hasVerticalMarkup(context) {
  return /writing-mode:\s*vertical-rl/i.test(context.result.markdown ?? "");
}

function hasCjkText(context) {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(context.result.markdown ?? "");
}

function hasRtlText(context) {
  return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u.test(
    context.result.markdown ?? ""
  );
}

function hasNoBinaryGarbage(context) {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(
    context.result.markdown ?? ""
  );
}

function hasSourceType(context, sourceType) {
  return context.result.ir?.sourceType === sourceType;
}

function textCoveragePassed(context) {
  return context.evidence?.textCoveragePassed === true;
}

function characterFidelityPassed(context) {
  if (context.evidence?.characterErrorPassed != null) {
    return context.evidence.characterErrorPassed === true;
  }
  return context.evidence?.expectedMarkdownMatch === true || textCoveragePassed(context);
}

function readingOrderPassed(context) {
  if (context.evidence?.readingOrderPassed != null) {
    return context.evidence.readingOrderPassed === true;
  }
  return context.evidence?.expectedMarkdownMatch === true;
}

function noInventedText(context) {
  if (context.evidence?.expectedMarkdownMatch === true) {
    return true;
  }
  const precision = context.evidence?.textPrecision;
  const minimum = context.acceptance.minTextCoverage ?? 1;
  return Number.isFinite(precision) && precision + Number.EPSILON >= minimum;
}

function exactOrCharacterFidelity(context) {
  return context.evidence?.expectedMarkdownMatch === true || characterFidelityPassed(context);
}

function hasReferences(context) {
  return /(?:^|\n)#{1,6}\s+(?:references|bibliography)\b|\breferences\b/i.test(
    context.result.markdown ?? ""
  );
}

function hasAppendix(context) {
  return /(?:^|\n)#{1,6}\s+appendi(?:x|ces)\b|\bappendix\s+[A-Z0-9]/i.test(
    context.result.markdown ?? ""
  );
}

function hasWithdrawnNotice(context) {
  return /withdrawn|superseded/i.test(context.result.markdown ?? "");
}

function hasNistIdentifier(context) {
  return /NIST\s+SP\s+800[-\s][0-9A-Za-z.-]+/i.test(context.result.markdown ?? "");
}

function hasSectionHeadings(context) {
  return (context.result.markdown?.match(/^#{1,6}\s+\S/gm) ?? []).length >= 2;
}

function hasPageAnchors(context) {
  return /<a id="page-\d+"><\/a>/i.test(context.result.markdown ?? "");
}

function hasTableCellEvidence(context) {
  const comparison = context.evidence?.tableCellAdjacency;
  return comparison ? comparison.expectedPairs > 0 && comparison.score > 0 : hasTable(context);
}

function hasTableNote(context) {
  return /(?:^|\n)(?:note|source):\s+\S/im.test(context.result.markdown ?? "");
}

function hasFormFields(context) {
  return (forms(context).fields?.length ?? forms(context).total ?? 0) > 0;
}

function formsMatch(context) {
  return (context.evidence?.matchedForms ?? 0) === (context.acceptance.forms?.length ?? 0);
}

function buttonStatesPreserved(context) {
  const fields = forms(context).fields ?? [];
  return fields.some((field) => field.buttonType === "checkbox" && typeof field.checked === "boolean") &&
    fields.some((field) => field.buttonType === "radio" && field.selectedValue != null);
}

function parserModeIncludes(context, value) {
  return String(parser(context).mode ?? "").includes(value);
}

function parserResolvedXrefStream(context) {
  return parser(context).mode === "xref-stream";
}

function parserResolvedObjectStream(context) {
  return parserResolvedXrefStream(context) && context.entry.features?.includes("object-stream");
}

function parserFollowedPrev(context) {
  return parserModeIncludes(context, "+prev");
}

function parserRepaired(context) {
  return parser(context).repaired === true && parser(context).mode === "object-scan-repair";
}

function hasRotatedPage(context) {
  return diagnosticPages(context).some((page) => page.rotation === 90) && hasText(context);
}

function hasCropBox(context) {
  return diagnosticPages(context).some((page) => Array.isArray(page.cropBox)) && hasText(context);
}

function hasOcrText(context) {
  return (reconciliation(context).selectedOcrTextLines ?? 0) > 0 && hasText(context);
}

function hasHybridSelection(context) {
  const value = reconciliation(context);
  return (
    hasSourceType(context, "hybrid") &&
    (value.selectedPdfTextLines ?? 0) > 0 &&
    (value.selectedOcrTextLines ?? 0) > 0
  );
}

function preferredAlignedHiddenText(context) {
  return (reconciliation(context).pages ?? []).some(
    (page) =>
      page.pdfHiddenImageAlignedTextLines > 0 &&
      page.selectedPdfTextLines > 0
  );
}

function usedOcrForBadHiddenRegion(context) {
  return (
    (reconciliation(context).selectedOcrTextLines ?? 0) > 0 &&
    (reconciliation(context).suppressedPdfTextLines ?? 0) > 0
  );
}

function hasRunningContentEvidence(context) {
  const running = context.evidence?.runningContent;
  return running?.passed === true || context.evidence?.expectedMarkdownMatch === true;
}

function hasTaggedStructure(context) {
  return extraction(context).structure?.tagged === true;
}

function hasFormMetadataOnly(context) {
  const formDiagnostics = forms(context);
  return formDiagnostics.present === true && (formDiagnostics.filled ?? 0) === 0;
}

function hasRowsAndColumns(context, rows, columns) {
  const matchingColumns = tables(context).filter(
    (table) => columns == null || table.columns === columns
  );
  return (
    matchingColumns.some((table) => rows == null || table.rows === rows) ||
    (rows != null && matchingColumns.reduce((sum, table) => sum + (table.rows ?? 0), 0) === rows)
  );
}

function hasContinuedTable(context) {
  const tablePages = new Set(
    tables(context).map((table) => table.pageIndex).filter(Number.isInteger)
  );
  return tables(context).length >= 2 && tablePages.size >= 2;
}

function hasNewestRevision(context) {
  return parserFollowedPrev(context) && /updated incremental fixture/i.test(context.result.markdown ?? "");
}

function hasHyphenationRepair(context) {
  return context.evidence?.expectedMarkdownMatch === true && !/\p{L}-\s+\p{Ll}/u.test(
    context.result.markdown ?? ""
  );
}

const mustCriterionPredicates = new Map([
  ["decrypt_with_known_user_password", passWhen((c) => hasText(c) && !c.result.warnings?.some((w) => w.code === "security.password_required"))],
  ["detect_borderless_table", passWhen((c) => tables(c).some((table) => table.source === "borderless-heuristic"))],
  ["detect_cell_span", passWhen(hasSpannedTable)],
  ["detect_columns", passWhen(hasColumns)],
  ["detect_footnote_region", passWhen(hasFootnote)],
  ["detect_repeated_footer", passWhen(hasRunningContentEvidence)],
  ["detect_repeated_header", passWhen(hasRunningContentEvidence)],
  ["detect_vector_figure_region", passWhen(hasVectorFigure)],
  ["detect_visible_table", passWhen(hasTable)],
  ["emit_bidi_markup", passWhen(hasBidiMarkup)],
  ["emit_csv_sidecar", passWhen(hasCsvSidecar)],
  ["emit_gfm_table", passWhen(hasGfmTable)],
  ["emit_html_table", passWhen(hasHtmlTable)],
  ["emit_vertical_writing_markup", passWhen(hasVerticalMarkup)],
  ["extract_acroform_fields", passWhen(hasFormFields)],
  ["extract_bullet_list", passWhen(hasList)],
  ["extract_cjk_text", passWhen(hasCjkText)],
  ["extract_headings", passWhen((c) => hasHeading(c))],
  ["extract_main_text", passWhen((c) => hasText(c) && textCoveragePassed(c))],
  ["extract_ocr_text", passWhen(hasOcrText)],
  ["extract_rtl_text", passWhen(hasRtlText)],
  ["extract_title", passWhen((c) => hasHeading(c, 1) || sourceMapEntries(c).some((entry) => entry.kind === "heading"))],
  ["extract_updated_revision_text", passWhen(hasNewestRevision)],
  ["extract_vertical_text", passWhen((c) => hasVerticalMarkup(c) && hasText(c))],
  ["follow_prev_xref_chain", passWhen(parserFollowedPrev)],
  ["follow_xref_prev_chain", passWhen(parserFollowedPrev)],
  ["join_cjk_wrapped_lines_without_spaces", passWhen(exactOrCharacterFidelity)],
  ["meet_ocr_error_thresholds", passWhen((c) => c.evidence?.ocrAccuracyPassed === true)],
  ["normalize_coordinates", passWhen(hasRotatedPage)],
  ["prefer_aligned_hidden_text", passWhen(preferredAlignedHiddenText)],
  ["prefer_newest_object_revision", passWhen(hasNewestRevision)],
  ["preserve_appendices", passWhen(hasAppendix)],
  ["preserve_body_text", passWhen((c) => hasText(c) && textCoveragePassed(c))],
  ["preserve_button_states", passWhen(buttonStatesPreserved)],
  ["preserve_caption", passWhen(hasCaption)],
  ["preserve_column_alignment", passWhen((c) => tables(c).some((table) => (table.numericColumns?.length ?? 0) > 0))],
  ["preserve_continued_table_rows", passWhen(hasContinuedTable)],
  ["preserve_decrypted_text_order", passWhen(readingOrderPassed)],
  ["preserve_field_values", passWhen(formsMatch)],
  ["preserve_footnote_text", passWhen((c) => hasFootnote(c) && textCoveragePassed(c))],
  ["preserve_heading", passWhen((c) => hasHeading(c) && textCoveragePassed(c))],
  ["preserve_left_then_right_reading_order", passWhen((c) => hasColumns(c) && readingOrderPassed(c))],
  ["preserve_list_order", passWhen((c) => hasList(c) && readingOrderPassed(c))],
  ["preserve_lists", passWhen(hasList)],
  ["preserve_nist_publication_identifier", passWhen(hasNistIdentifier)],
  ["preserve_page_anchors", passWhen(hasPageAnchors)],
  ["preserve_paragraph_order", passWhen((c) => hasParagraph(c) && readingOrderPassed(c))],
  ["preserve_references", passWhen(hasReferences)],
  ["preserve_rtl_reading_order", passWhen((c) => hasBidiMarkup(c) && exactOrCharacterFidelity(c))],
  ["preserve_section_headings", passWhen(hasSectionHeadings)],
  ["preserve_table_cells", passWhen(hasTableCellEvidence)],
  ["preserve_table_note", passWhen(hasTableNote)],
  ["preserve_tables", passWhen(hasTable)],
  ["preserve_tagged_pdf_signal", passWhen(hasTaggedStructure)],
  ["preserve_vertical_column_order", passWhen((c) => hasVerticalMarkup(c) && readingOrderPassed(c))],
  ["preserve_visible_crop_text", passWhen(hasCropBox)],
  ["preserve_withdrawn_notice", passWhen(hasWithdrawnNotice)],
  ["read_rotated_page", passWhen(hasRotatedPage)],
  ["repair_damaged_xref", passWhen(parserRepaired)],
  ["repair_line_end_hyphenation", passWhen(hasHyphenationRepair)],
  ["report_form_metadata", passWhen(hasFormFields)],
  ["require_password_before_extraction", passWhen((c) => c.result.warnings?.some((warning) => warning.code === "security.password_required"))],
  ["resolve_linearized_pdf", passWhen((c) => parserFollowedPrev(c) && c.entry.features?.includes("linearized"))],
  ["resolve_object_stream", passWhen(parserResolvedObjectStream)],
  ["resolve_qpdf_object_stream", passWhen(parserResolvedObjectStream)],
  ["resolve_qpdf_xref_stream", passWhen(parserResolvedXrefStream)],
  ["resolve_xref_stream", passWhen(parserResolvedXrefStream)],
  ["respect_crop_box", passWhen(hasCropBox)],
  ["route_as_hybrid", passWhen(hasHybridSelection)],
  ["route_as_scanned", passWhen((c) => hasSourceType(c, "scanned") && hasOcrText(c))],
  ["scan_indirect_objects", passWhen(parserRepaired)],
  ["use_ocr_for_bad_hidden_region", passWhen(usedOcrForBadHiddenRegion)]
]);

const mustNotCriterionPredicates = new Map([
  ["bypass_encryption_without_password", passWhen((c) => c.result.warnings?.some((warning) => warning.code === "security.password_required"))],
  ["drop_authenticator_requirement_tables", passWhen(hasTable)],
  ["drop_bidi_markup", passWhen(hasBidiMarkup)],
  ["drop_checked_state", passWhen(buttonStatesPreserved)],
  ["drop_compressed_page_objects", passWhen((c) => parserResolvedObjectStream(c) && hasText(c))],
  ["drop_continued_rows", passWhen(hasContinuedTable)],
  ["drop_rotated_text", passWhen(hasRotatedPage)],
  ["drop_spanned_header", passWhen(hasSpannedTable)],
  ["drop_table_note", passWhen(hasTableNote)],
  ["drop_title_page_metadata", passWhen((c) => hasHeading(c) || hasNistIdentifier(c))],
  ["drop_vertical_writing_markup", passWhen(hasVerticalMarkup)],
  ["emit_bad_hidden_text", passWhen((c) => exactOrCharacterFidelity(c) && usedOcrForBadHiddenRegion(c))],
  ["emit_binary_garbage", passWhen(hasNoBinaryGarbage)],
  ["emit_broken_gfm_for_spans", passWhen((c) => hasHtmlTable(c) && hasSpannedTable(c))],
  ["emit_empty_markdown", passWhen(hasText)],
  ["emit_ocr_duplicate_text", passWhen(exactOrCharacterFidelity)],
  ["fall_back_to_unstructured_binary_scan", passWhen((c) => parser(c).mode !== "unavailable" && hasText(c))],
  ["flatten_all_sections_into_one_paragraph", passWhen((c) => hasMultipleDocumentBlocks(c) && (hasHeading(c) || hasParagraph(c)))],
  ["flatten_table_to_unstructured_paragraph", passWhen(hasTable)],
  ["flatten_vertical_columns", passWhen(hasVerticalMarkup)],
  ["fold_note_into_table", passWhen((c) => hasTableNote(c) && exactOrCharacterFidelity(c))],
  ["ignore_newest_xref_revision", passWhen(parserFollowedPrev)],
  ["insert_synthetic_cjk_spaces", passWhen(exactOrCharacterFidelity)],
  ["interleave_columns_line_by_line", passWhen(readingOrderPassed)],
  ["interleave_footnote_inside_body_sentence", passWhen(exactOrCharacterFidelity)],
  ["invent_chart_data", passWhen((c) => hasFigure(c) && noInventedText(c))],
  ["invent_missing_form_values", passWhen(formsMatch)],
  ["invent_missing_values", passWhen(noInventedText)],
  ["keep_unrepaired_line_end_hyphen", passWhen(hasHyphenationRepair)],
  ["merge_adjacent_columns", passWhen((c) => hasTable(c) && exactOrCharacterFidelity(c))],
  ["merge_rows_across_columns", passWhen((c) => hasTable(c) && exactOrCharacterFidelity(c))],
  ["move_caption_before_body", passWhen((c) => hasCaption(c) && readingOrderPassed(c))],
  ["omit_withdrawn_notice", passWhen(hasWithdrawnNotice)],
  ["prefer_hidden_media_box_content", passWhen(hasCropBox)],
  ["repeat_running_header_in_body", passWhen(hasRunningContentEvidence)],
  ["reverse_rtl_fragments", passWhen((c) => hasBidiMarkup(c) && exactOrCharacterFidelity(c))],
  ["split_wrapped_cjk_paragraph", passWhen(exactOrCharacterFidelity)],
  ["treat_acroform_metadata_as_user_filled_values", passWhen(hasFormMetadataOnly)],
  ["trust_repaired_output_without_diagnostics", passWhen(parserRepaired)],
  ["use_stale_page_tree", passWhen(hasNewestRevision)]
]);

const structureExpectationPredicates = new Map([
  ["abstract", passWhen((c) => /(?:^|\n)#{1,6}\s+abstract\b|\babstract\b/i.test(c.result.markdown ?? ""))],
  ["acroform_fields", passWhen(hasFormFields)],
  ["acroform_metadata", passWhen(hasFormFields)],
  ["aligned_numeric_columns", passWhen((c) => tables(c).some((table) => (table.numericColumns?.length ?? 0) > 0))],
  ["appendices", passWhen(hasAppendix)],
  ["bidi_markup", passWhen(hasBidiMarkup)],
  ["borderless_table", passWhen((c) => tables(c).some((table) => table.source === "borderless-heuristic"))],
  ["caption", passWhen(hasCaption)],
  ["cjk_paragraph", passWhen((c) => hasCjkText(c) && hasParagraph(c))],
  ["column_span", passWhen(hasSpannedTable)],
  ["continued_table_parts", passWhen(hasContinuedTable)],
  ["crop_box", passWhen(hasCropBox)],
  ["csv_sidecar", passWhen(hasCsvSidecar)],
  ["figure", passWhen(hasFigure)],
  ["figures", passWhen(hasFigure)],
  ["footnote", passWhen(hasFootnote)],
  ["gfm_table", passWhen(hasGfmTable)],
  ["header_footer_removal", passWhen(hasRunningContentEvidence)],
  ["heading_level_1", passWhen((c) => hasHeading(c, 1))],
  ["heading_level_2", passWhen((c) => hasHeading(c, 2))],
  ["html_table", passWhen(hasHtmlTable)],
  ["hyphenation_repair", passWhen(hasHyphenationRepair)],
  ["incremental_update", passWhen(hasNewestRevision)],
  ["linearized", passWhen((c) => parserFollowedPrev(c) && c.entry.features?.includes("linearized"))],
  ["lists", passWhen(hasList)],
  ["long_document", passWhen((c) => (c.result.ir?.pages?.length ?? 0) >= 50)],
  ["mixed_pdf_ocr_regions", passWhen(hasHybridSelection)],
  ["multi_page", passWhen((c) => (c.result.ir?.pages?.length ?? 0) > 1)],
  ["newest_revision", passWhen(hasNewestRevision)],
  ["object_scan_repair", passWhen(parserRepaired)],
  ["object_stream", passWhen(parserResolvedObjectStream)],
  ["ocr_text_lines", passWhen(hasOcrText)],
  ["page_rotation_90", passWhen(hasRotatedPage)],
  ["paragraph", passWhen(hasParagraph)],
  ["paragraphs", passWhen(hasParagraph)],
  ["rc4-40", passWhen((c) => c.entry.features?.includes("rc4-40") && hasText(c))],
  ["reading_order", passWhen(readingOrderPassed)],
  ["references", passWhen(hasReferences)],
  ["rtl_paragraph", passWhen((c) => hasRtlText(c) && hasBidiMarkup(c))],
  ["scientific_paper", passWhen((c) => hasHeading(c) && hasText(c))],
  ["section_headings", passWhen(hasSectionHeadings)],
  ["six_rows", passWhen((c) => hasRowsAndColumns(c, 6, null))],
  ["standard-security-handler-r2", passWhen((c) => c.entry.features?.includes("standard-security-handler-r2") && hasText(c))],
  ["table_note", passWhen(hasTableNote)],
  ["tables", passWhen(hasTable)],
  ["tagged_pdf", passWhen(hasTaggedStructure)],
  ["three_columns", passWhen((c) => hasRowsAndColumns(c, null, 3))],
  ["three_rows", passWhen((c) => hasRowsAndColumns(c, 3, null))],
  ["title_page", passWhen((c) => hasHeading(c) || hasNistIdentifier(c))],
  ["two_column_layout", passWhen(hasColumns)],
  ["two_columns", passWhen(hasColumns)],
  ["unordered_list", passWhen(hasList)],
  ["vector_paths", passWhen(hasVectorFigure)],
  ["vertical_rl_markup", passWhen(hasVerticalMarkup)],
  ["vertical_writing", passWhen(hasVerticalMarkup)],
  ["visible_table", passWhen(hasTable)],
  ["withdrawal_notice", passWhen(hasWithdrawnNotice)],
  ["xref_prev_chain", passWhen(parserFollowedPrev)],
  ["xref_stream", passWhen(parserResolvedXrefStream)]
]);

export function evaluateAcceptanceCriteria(acceptance, context) {
  const errors = [];
  let checked = 0;
  checked += evaluateCriteriaBlock(
    acceptance.must ?? [],
    mustCriterionPredicates,
    "must",
    context,
    errors
  );
  checked += evaluateCriteriaBlock(
    acceptance.mustNot ?? [],
    mustNotCriterionPredicates,
    "mustNot",
    context,
    errors
  );
  return { errors, checked };
}

function evaluateCriteriaBlock(criteria, predicates, blockName, context, errors) {
  let checked = 0;
  for (const criterion of criteria) {
    const predicate = predicates.get(criterion);
    if (!predicate) {
      errors.push(
        `unsupported acceptance ${blockName} criterion "${criterion}" without a corpus runner checker`
      );
      continue;
    }
    checked += 1;
    if (!predicate(context)) {
      errors.push(`acceptance ${blockName} criterion "${criterion}" failed its runtime predicate`);
    }
  }
  return checked;
}

export function evaluateStructureExpectations(expectations, context) {
  const errors = [];
  let checked = 0;
  for (const expectation of expectations ?? []) {
    const predicate = structureExpectationPredicates.get(expectation);
    if (!predicate) {
      errors.push(`unsupported structure.expected value "${expectation}" without a checker`);
      continue;
    }
    checked += 1;
    if (!predicate(context)) {
      errors.push(`structure.expected value "${expectation}" failed its runtime predicate`);
    }
  }
  return { errors, checked };
}

export function evaluateExpectedMode(expectedMode, context) {
  const checks = new Map([
    ["pdf-text", () => (reconciliation(context).selectedPdfTextLines ?? 0) > 0],
    ["ocr", () => hasOcrText(context)],
    ["hybrid", () => hasHybridSelection(context)],
    ["asset-only", () => (context.result.assets?.length ?? 0) > 0],
    ["metadata-only", () => !hasText(context) && Boolean(context.result.diagnostics)],
    ["unsupported", () => false]
  ]);
  const check = checks.get(expectedMode);
  if (!check) {
    return [`unsupported expectedMode "${expectedMode}" without a checker`];
  }
  return check() ? [] : [`expectedMode "${expectedMode}" failed its runtime predicate`];
}
