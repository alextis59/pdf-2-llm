const defaultImageCoverageThreshold = 0.5;
const defaultMinTextLines = 3;
const defaultMinTextAreaRatio = 0.01;
const defaultMinHiddenTextLines = 1;
const defaultMinHiddenTextImageOverlapRatio = 0.5;

export function createScanDetection(pages = [], options = {}) {
  const textLinesByPage = groupByPage(options.textLines ?? []);
  const imageDrawsByPage = groupByPage(options.imageDraws ?? []);
  const imageCoverageThreshold =
    Number.isFinite(options.imageCoverageThreshold) && options.imageCoverageThreshold > 0
      ? options.imageCoverageThreshold
      : defaultImageCoverageThreshold;
  const minTextLines =
    Number.isInteger(options.minTextLines) && options.minTextLines >= 0
      ? options.minTextLines
      : defaultMinTextLines;
  const minTextAreaRatio =
    Number.isFinite(options.minTextAreaRatio) && options.minTextAreaRatio >= 0
      ? options.minTextAreaRatio
      : defaultMinTextAreaRatio;
  const minHiddenTextLines =
    Number.isInteger(options.minHiddenTextLines) && options.minHiddenTextLines >= 0
      ? options.minHiddenTextLines
      : defaultMinHiddenTextLines;
  const minHiddenTextImageOverlapRatio =
    Number.isFinite(options.minHiddenTextImageOverlapRatio) &&
    options.minHiddenTextImageOverlapRatio >= 0
      ? options.minHiddenTextImageOverlapRatio
      : defaultMinHiddenTextImageOverlapRatio;

  const pageDiagnostics = pages.map((page) =>
    createPageScanDiagnostics(page, {
      imageCoverageThreshold,
      imageDraws: imageDrawsByPage.get(page.pageIndex) ?? [],
      minHiddenTextImageOverlapRatio,
      minHiddenTextLines,
      minTextAreaRatio,
      minTextLines,
      textLines: textLinesByPage.get(page.pageIndex) ?? []
    })
  );
  const sourceTypeCounts = countSourceTypes(pageDiagnostics);

  return {
    sourceType: documentSourceType(sourceTypeCounts, pageDiagnostics.length),
    sourceTypeCounts,
    routingConfidence: averageRoutingConfidence(pageDiagnostics),
    thresholds: {
      imageCoverageRatio: imageCoverageThreshold,
      minTextLines,
      minTextAreaRatio,
      minHiddenTextLines,
      minHiddenTextImageOverlapRatio
    },
    imageDominantPages: pageDiagnostics.filter((page) => page.imageDominant).length,
    littleOrNoTextPages: pageDiagnostics.filter((page) => page.littleOrNoText).length,
    hiddenOcrOverlayPages: pageDiagnostics.filter((page) => page.hiddenOcrOverlayLikely).length,
    hiddenTextImageMismatchPages: pageDiagnostics.filter((page) => page.hiddenTextImageMismatchLikely)
      .length,
    pages: pageDiagnostics
  };
}

function createPageScanDiagnostics(page, options) {
  const imageDraws = options.imageDraws.filter((image) => Number.isFinite(image.area) && image.area > 0);
  const textLines = options.textLines.filter(
    (line) => Number.isFinite(line.width) && Number.isFinite(line.height)
  );
  const hiddenTextLines = options.textLines.filter(isHiddenTextLine);
  const measurableHiddenTextLines = hiddenTextLines.filter(
    (line) => Number.isFinite(line.width) && Number.isFinite(line.height)
  );
  const textLineCount = options.textLines.length;
  const textArea = textLines.reduce(
    (total, line) => total + Math.max(0, line.width) * Math.max(0, line.height),
    0
  );
  const hiddenTextArea = measurableHiddenTextLines.reduce(
    (total, line) => total + Math.max(0, line.width) * Math.max(0, line.height),
    0
  );
  const totalImageArea = imageDraws.reduce((total, image) => total + image.area, 0);
  const maxImageArea = imageDraws.reduce((max, image) => Math.max(max, image.area), 0);
  const pageArea =
    Number.isFinite(page.widthPt) && Number.isFinite(page.heightPt)
      ? Math.max(0, page.widthPt * page.heightPt)
      : null;
  const imageCoverageRatio =
    pageArea && pageArea > 0 ? normalizeRatio(Math.min(totalImageArea / pageArea, 1)) : null;
  const maxImageCoverageRatio =
    pageArea && pageArea > 0 ? normalizeRatio(Math.min(maxImageArea / pageArea, 1)) : null;
  const imageDominant =
    imageCoverageRatio !== null && imageCoverageRatio >= options.imageCoverageThreshold;
  const textAreaRatio =
    pageArea && pageArea > 0 ? normalizeRatio(Math.min(textArea / pageArea, 1)) : null;
  const noText = textLineCount === 0;
  const littleText =
    !noText &&
    textLineCount < options.minTextLines &&
    (textAreaRatio === null || textAreaRatio < options.minTextAreaRatio);
  const littleOrNoText = noText || littleText;
  const hiddenTextAreaRatio =
    pageArea && pageArea > 0 ? normalizeRatio(Math.min(hiddenTextArea / pageArea, 1)) : null;
  const hiddenOcrOverlayLikely =
    imageDominant && hiddenTextLines.length >= options.minHiddenTextLines;
  const hiddenTextImageMismatchLineCount = hiddenTextLines.filter(
    (line) => maxImageOverlapRatio(line, imageDraws) < options.minHiddenTextImageOverlapRatio
  ).length;
  const hiddenTextImageMismatchLikely =
    hiddenOcrOverlayLikely && hiddenTextImageMismatchLineCount > 0;
  const routing = createPageRouting({
    hiddenOcrOverlayLikely,
    hiddenTextImageMismatchLikely,
    imageCoverageRatio,
    imageDominant,
    imageDrawCount: imageDraws.length,
    littleOrNoText,
    noText,
    textLineCount
  });

  return {
    pageIndex: page.pageIndex,
    sourceType: routing.sourceType,
    routingConfidence: routing.confidence,
    routingReasons: routing.reasons,
    textLineCount,
    textArea: normalizeNullableNumber(textArea),
    textAreaRatio,
    noText,
    littleText,
    littleOrNoText,
    hiddenTextLineCount: hiddenTextLines.length,
    hiddenTextArea: normalizeNullableNumber(hiddenTextArea),
    hiddenTextAreaRatio,
    hiddenOcrOverlayLikely,
    hiddenTextImageMismatchLineCount,
    hiddenTextImageMismatchLikely,
    imageResourceCount: countImageResources(page),
    imageDrawCount: imageDraws.length,
    pageArea: normalizeNullableNumber(pageArea),
    totalImageArea: normalizeNullableNumber(totalImageArea),
    maxImageArea: normalizeNullableNumber(maxImageArea),
    imageCoverageRatio,
    maxImageCoverageRatio,
    imageDominant,
    imageDominanceConfidence: imageDominanceConfidence({
      imageCoverageRatio,
      imageDrawCount: imageDraws.length,
      threshold: options.imageCoverageThreshold
    }),
    imageDraws: imageDraws.map(summarizeImageDraw)
  };
}

function createPageRouting({
  hiddenOcrOverlayLikely,
  hiddenTextImageMismatchLikely,
  imageCoverageRatio,
  imageDominant,
  imageDrawCount,
  littleOrNoText,
  noText,
  textLineCount
}) {
  if (imageDominant && hiddenOcrOverlayLikely) {
    return {
      sourceType: "hybrid",
      confidence: hiddenTextImageMismatchLikely ? 0.6 : 0.9,
      reasons: hiddenTextImageMismatchLikely
        ? ["image_dominant", "hidden_ocr_overlay", "hidden_text_image_mismatch"]
        : ["image_dominant", "hidden_ocr_overlay"]
    };
  }
  if (imageDominant && !littleOrNoText && textLineCount > 0) {
    return {
      sourceType: "hybrid",
      confidence: 0.75,
      reasons: ["image_dominant", "text_present"]
    };
  }
  if (imageDominant && littleOrNoText) {
    return {
      sourceType: "scanned",
      confidence: noText && imageCoverageRatio >= 0.9 ? 0.95 : 0.85,
      reasons: noText ? ["image_dominant", "no_text"] : ["image_dominant", "little_text"]
    };
  }
  if (textLineCount > 0 || imageDrawCount > 0) {
    return {
      sourceType: "digital",
      confidence: textLineCount > 0 ? 0.9 : 0.65,
      reasons: textLineCount > 0 ? ["text_present"] : ["image_not_dominant"]
    };
  }
  return {
    sourceType: "unknown",
    confidence: 0.2,
    reasons: ["no_text_or_image_signal"]
  };
}

function countSourceTypes(pages) {
  const counts = {
    digital: 0,
    scanned: 0,
    hybrid: 0,
    unknown: 0
  };
  for (const page of pages) {
    counts[page.sourceType] += 1;
  }
  return counts;
}

function documentSourceType(counts, pageCount) {
  if (pageCount === 0 || counts.unknown === pageCount) {
    return "unknown";
  }
  if (counts.hybrid > 0 || (counts.digital > 0 && counts.scanned > 0)) {
    return "hybrid";
  }
  if (counts.scanned > 0 && counts.digital === 0) {
    return "scanned";
  }
  if (counts.digital > 0 && counts.scanned === 0) {
    return "digital";
  }
  return "unknown";
}

function averageRoutingConfidence(pages) {
  if (pages.length === 0) {
    return 0;
  }
  const total = pages.reduce((sum, page) => sum + page.routingConfidence, 0);
  return normalizeRatio(total / pages.length);
}

function isHiddenTextLine(line) {
  if (line.hidden === true || line.textRenderMode === 3) {
    return true;
  }
  return (line.spans ?? []).some((span) => span.hidden === true || span.textRenderMode === 3);
}

function maxImageOverlapRatio(line, imageDraws) {
  const lineBox = lineBoundingBox(line);
  if (!lineBox || imageDraws.length === 0) {
    return 0;
  }
  const lineArea = lineBox.width * lineBox.height;
  if (lineArea <= 0) {
    return 0;
  }

  const maxOverlapArea = imageDraws.reduce(
    (max, image) => Math.max(max, rectangleOverlapArea(lineBox, image)),
    0
  );
  return normalizeRatio(Math.min(maxOverlapArea / lineArea, 1));
}

function lineBoundingBox(line) {
  if (![line.x, line.y, line.width, line.height].every(Number.isFinite)) {
    return null;
  }
  return {
    x: line.x,
    y: line.y,
    width: Math.max(0, line.width),
    height: Math.max(0, line.height)
  };
}

function rectangleOverlapArea(left, right) {
  if (![right.x, right.y, right.width, right.height].every(Number.isFinite)) {
    return 0;
  }
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function groupByPage(items) {
  const pages = new Map();
  for (const item of items) {
    const pageIndex = item.pageIndex ?? null;
    const pageItems = pages.get(pageIndex) ?? [];
    pageItems.push(item);
    pages.set(pageIndex, pageItems);
  }
  return pages;
}

function countImageResources(page) {
  return Object.values(page.resources?.xobjects ?? {}).filter((xobject) => xobject.subtype === "Image")
    .length;
}

function summarizeImageDraw(image) {
  return {
    name: image.name,
    objectNumber: image.objectNumber,
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    area: image.area,
    imageWidth: image.imageWidth,
    imageHeight: image.imageHeight,
    imagePixels: image.imagePixels,
    streamIndex: image.streamIndex,
    source: image.source
  };
}

function imageDominanceConfidence({ imageCoverageRatio, imageDrawCount, threshold }) {
  if (imageCoverageRatio === null) {
    return imageDrawCount > 0 ? 0.35 : 0.9;
  }
  if (imageDrawCount === 0) {
    return 0.95;
  }

  const distance = Math.abs(imageCoverageRatio - threshold);
  if (distance >= 0.35) {
    return 0.95;
  }
  if (distance >= 0.2) {
    return 0.85;
  }
  if (distance >= 0.1) {
    return 0.7;
  }
  return 0.55;
}

function normalizeRatio(value) {
  return normalizeNullableNumber(value);
}

function normalizeNullableNumber(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}
