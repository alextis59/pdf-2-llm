const internalRasterRenderer = Object.freeze({
  id: "internal-page-geometry",
  kind: "scoped-internal",
  dependency: null,
  environments: ["browser", "node"],
  output: "raster-plan",
  status: "selected",
  notes:
    "Uses parsed page geometry as the stable rasterization seam; pixel rendering is implemented incrementally behind this adapter."
});

export const defaultRasterDpi = 300;

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

  return {
    enabled,
    dpi,
    renderer,
    pages: enabled ? pages.map((page) => createRasterPagePlan(page, dpi)) : []
  };
}

function createRasterPagePlan(page, dpi) {
  const sourceBox = page.cropBox ? "cropBox" : page.mediaBox ? "mediaBox" : "unknown";
  const scale = dpi / 72;
  const widthPx = pointsToPixels(page.widthPt, dpi);
  const heightPx = pointsToPixels(page.heightPt, dpi);
  return {
    pageIndex: page.pageIndex,
    status: "planned",
    sourceBox,
    widthPt: page.widthPt ?? null,
    heightPt: page.heightPt ?? null,
    dpi,
    scale,
    widthPx,
    heightPx,
    pixelCount: widthPx === null || heightPx === null ? null : widthPx * heightPx,
    rotation: page.rotation ?? 0,
    userUnit: page.userUnit ?? 1
  };
}

function normalizeDpi(value) {
  const dpi = Number(value);
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError("raster dpi must be a positive finite number");
  }
  return dpi;
}

function pointsToPixels(points, dpi) {
  if (!Number.isFinite(points)) {
    return null;
  }
  return Math.max(1, Math.ceil((points * dpi) / 72 - 1e-9));
}
