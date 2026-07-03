const defaultImageCoverageThreshold = 0.5;

export function createScanDetection(pages = [], options = {}) {
  const textLinesByPage = countByPage(options.textLines ?? []);
  const imageDrawsByPage = groupByPage(options.imageDraws ?? []);
  const imageCoverageThreshold =
    Number.isFinite(options.imageCoverageThreshold) && options.imageCoverageThreshold > 0
      ? options.imageCoverageThreshold
      : defaultImageCoverageThreshold;

  const pageDiagnostics = pages.map((page) =>
    createPageScanDiagnostics(page, {
      imageCoverageThreshold,
      imageDraws: imageDrawsByPage.get(page.pageIndex) ?? [],
      textLineCount: textLinesByPage.get(page.pageIndex) ?? 0
    })
  );

  return {
    thresholds: {
      imageCoverageRatio: imageCoverageThreshold
    },
    imageDominantPages: pageDiagnostics.filter((page) => page.imageDominant).length,
    pages: pageDiagnostics
  };
}

function createPageScanDiagnostics(page, options) {
  const imageDraws = options.imageDraws.filter((image) => Number.isFinite(image.area) && image.area > 0);
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

  return {
    pageIndex: page.pageIndex,
    textLineCount: options.textLineCount,
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

function countByPage(items) {
  const counts = new Map();
  for (const item of items) {
    const pageIndex = item.pageIndex ?? null;
    counts.set(pageIndex, (counts.get(pageIndex) ?? 0) + 1);
  }
  return counts;
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
