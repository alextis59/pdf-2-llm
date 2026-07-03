const routedOcrSourceTypes = new Set(["scanned", "hybrid"]);
const defaultMinDeskewDegrees = 0.25;
const defaultMaxDeskewDegrees = 15;

export function createOcrPreprocessingPlan({
  adapter = null,
  options = {},
  pages = [],
  rasterPlan = null,
  scanDetection = null
} = {}) {
  const scanPagesByIndex = new Map((scanDetection?.pages ?? []).map((page) => [page.pageIndex, page]));
  const rasterPagesByIndex = new Map((rasterPlan?.pages ?? []).map((page) => [page.pageIndex, page]));
  const routedPages = pages
    .map((page) => ({
      page,
      scanPage: scanPagesByIndex.get(page.pageIndex) ?? null,
      rasterPage: rasterPagesByIndex.get(page.pageIndex) ?? null
    }))
    .filter(({ scanPage }) => routedOcrSourceTypes.has(scanPage?.sourceType));
  const thresholds = {
    minDeskewDegrees: normalizePositiveNumber(options.minDeskewDegrees, defaultMinDeskewDegrees),
    maxDeskewDegrees: normalizePositiveNumber(options.maxDeskewDegrees, defaultMaxDeskewDegrees)
  };

  if (options.enabled === false || adapter?.enabled === false) {
    return createDiagnostics({
      enabled: false,
      status: "disabled",
      thresholds,
      pages: []
    });
  }

  if (adapter?.status === "unsupported") {
    return createDiagnostics({
      enabled: true,
      status: "unsupported",
      thresholds,
      pages: []
    });
  }

  if (routedPages.length === 0) {
    return createDiagnostics({
      enabled: true,
      status: "no-routed-pages",
      thresholds,
      pages: []
    });
  }

  const pagePlans = routedPages.map(({ page, rasterPage, scanPage }) =>
    createPagePlan({
      options,
      page,
      rasterEnabled: rasterPlan?.enabled === true,
      rasterPage,
      scanPage
    })
  );

  return createDiagnostics({
    enabled: true,
    status: planStatus(pagePlans),
    thresholds,
    pages: pagePlans
  });
}

function createDiagnostics({ enabled, pages, status, thresholds }) {
  return {
    enabled,
    status,
    strategy: "metadata-first",
    thresholds,
    pages
  };
}

function createPagePlan({ options, page, rasterEnabled, rasterPage, scanPage }) {
  const pageRotationDegrees = normalizeRotation(page.rotation);
  const rotationCorrectionDegrees = pageRotationDegrees === 0 ? 0 : (360 - pageRotationDegrees) % 360;
  const rasterStatus = rasterPage
    ? rasterPage.status === "skipped-pixel-limit"
      ? "skipped-pixel-limit"
      : "planned"
    : rasterEnabled
      ? "missing"
      : "not-planned";
  const status =
    rasterStatus === "skipped-pixel-limit"
      ? "skipped-pixel-limit"
      : rasterStatus === "planned"
        ? "planned"
        : "metadata-only";
  const operations = [];
  const deferredOperations = [];

  if (rotationCorrectionDegrees !== 0) {
    operations.push("normalize-page-rotation");
  }

  addRasterOperation({
    deferredOperations,
    enabled: options.deskew !== false,
    name: "estimate-deskew",
    operations,
    rasterStatus
  });
  addRasterOperation({
    deferredOperations,
    enabled: options.binarize !== false,
    name: "binarize",
    operations,
    rasterStatus
  });
  addRasterOperation({
    deferredOperations,
    enabled: options.denoise !== false,
    name: "denoise",
    operations,
    rasterStatus
  });

  return {
    pageIndex: page.pageIndex,
    sourceType: scanPage.sourceType,
    status,
    rasterStatus,
    pageRotationDegrees,
    rotationCorrectionDegrees,
    deskewDegrees: 0,
    deskewConfidence: 0,
    operations,
    deferredOperations
  };
}

function addRasterOperation({ deferredOperations, enabled, name, operations, rasterStatus }) {
  if (!enabled) {
    return;
  }
  if (rasterStatus === "planned") {
    operations.push(name);
    return;
  }
  if (rasterStatus !== "skipped-pixel-limit") {
    deferredOperations.push(name);
  }
}

function planStatus(pagePlans) {
  if (pagePlans.every((page) => page.status === "skipped-pixel-limit")) {
    return "skipped";
  }
  if (pagePlans.some((page) => page.status === "planned")) {
    return "planned";
  }
  return "metadata-only";
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeRotation(value) {
  const rotation = Number(value ?? 0);
  if (!Number.isFinite(rotation)) {
    return 0;
  }
  return ((rotation % 360) + 360) % 360;
}
