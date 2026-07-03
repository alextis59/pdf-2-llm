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

  return {
    enabled,
    renderer,
    pages: enabled ? pages.map(createRasterPagePlan) : []
  };
}

function createRasterPagePlan(page) {
  const sourceBox = page.cropBox ? "cropBox" : page.mediaBox ? "mediaBox" : "unknown";
  return {
    pageIndex: page.pageIndex,
    status: "planned",
    sourceBox,
    widthPt: page.widthPt ?? null,
    heightPt: page.heightPt ?? null,
    rotation: page.rotation ?? 0,
    userUnit: page.userUnit ?? 1
  };
}
