const internalRasterRenderer = Object.freeze({
  id: "internal-page-geometry",
  kind: "scoped-internal",
  dependency: null,
  environments: ["browser", "node"],
  output: "raster-plan",
  status: "selected",
  notes:
    "Uses parsed page geometry as the stable rasterization seam; pixel rendering is implemented incrementally behind this adapter without retaining page pixel buffers."
});

export const defaultRasterDpi = 300;
export const defaultThumbnailDpi = 36;
export const defaultMaxImagePixels = 100_000_000;

export function selectRasterRenderer(options = {}) {
  const requested = options.renderer ?? internalRasterRenderer.id;
  if (requested !== internalRasterRenderer.id) {
    return {
      ...internalRasterRenderer,
      status: "unsupported",
      requested
    };
  }

  return {
    ...internalRasterRenderer,
    requested
  };
}

export function createRasterPlan(pages = [], options = {}) {
  const enabled = options.enabled === true;
  const renderer = selectRasterRenderer(options);
  const dpi = normalizeDpi(options.dpi ?? defaultRasterDpi);
  const thumbnailDpi = normalizeDpi(options.thumbnailDpi ?? defaultThumbnailDpi);
  const maxPixels = normalizeMaxPixels(options.maxPixels ?? defaultMaxImagePixels);
  const plannedPages = enabled
    ? pages.map((page) => createRasterPagePlan(page, { dpi, thumbnailDpi, maxPixels }))
    : [];

  return {
    enabled,
    dpi,
    thumbnailDpi,
    maxPixels,
    renderer,
    retention: createRasterRetentionPolicy(),
    limitedPages: plannedPages.filter((page) => page.exceedsPixelLimit).length,
    limitedThumbnails: plannedPages.filter((page) => page.thumbnail.exceedsPixelLimit).length,
    pages: plannedPages
  };
}

function createRasterRetentionPolicy() {
  return {
    strategy: "metadata-only",
    pagePixelsRetained: false,
    thumbnailPixelsRetained: false,
    retainedBytes: 0
  };
}

function createRasterPagePlan(page, options) {
  const { dpi, thumbnailDpi, maxPixels } = options;
  const sourceBox = page.cropBox ? "cropBox" : page.mediaBox ? "mediaBox" : "unknown";
  const boxPt = page.cropBox ?? page.mediaBox ?? null;
  const sourceWidthPt = page.widthPt ?? null;
  const sourceHeightPt = page.heightPt ?? null;
  const rotation = normalizeRotation(page.rotation);
  const quarterTurn = rotation === 90 || rotation === 270;
  const widthPt = quarterTurn ? sourceHeightPt : sourceWidthPt;
  const heightPt = quarterTurn ? sourceWidthPt : sourceHeightPt;
  const target = createRasterTarget(widthPt, heightPt, dpi, maxPixels);
  return {
    pageIndex: page.pageIndex,
    status: target.status,
    sourceBox,
    boxPt,
    sourceWidthPt,
    sourceHeightPt,
    widthPt,
    heightPt,
    ...target,
    thumbnail: createRasterTarget(widthPt, heightPt, thumbnailDpi, maxPixels),
    rotation,
    quarterTurn,
    userUnit: page.userUnit ?? 1
  };
}

function createRasterTarget(widthPt, heightPt, dpi, maxPixels) {
  const scale = dpi / 72;
  const widthPx = pointsToPixels(widthPt, dpi);
  const heightPx = pointsToPixels(heightPt, dpi);
  const pixelCount = widthPx === null || heightPx === null ? null : widthPx * heightPx;
  const exceedsPixelLimit = pixelCount !== null && pixelCount > maxPixels;
  return {
    status: exceedsPixelLimit ? "skipped-pixel-limit" : "planned",
    dpi,
    scale,
    widthPx,
    heightPx,
    pixelCount,
    maxPixels,
    exceedsPixelLimit
  };
}

function normalizeDpi(value) {
  const dpi = Number(value);
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError("raster dpi must be a positive finite number");
  }
  return dpi;
}

function normalizeMaxPixels(value) {
  const maxPixels = Number(value);
  if (!Number.isFinite(maxPixels) || maxPixels < 1) {
    throw new RangeError("security.maxImagePixels must be a positive finite number");
  }
  return Math.floor(maxPixels);
}

function pointsToPixels(points, dpi) {
  if (!Number.isFinite(points)) {
    return null;
  }
  return Math.max(1, Math.ceil((points * dpi) / 72 - 1e-9));
}

function normalizeRotation(value) {
  const rotation = Number(value ?? 0);
  if (!Number.isFinite(rotation)) {
    return 0;
  }
  return ((rotation % 360) + 360) % 360;
}
