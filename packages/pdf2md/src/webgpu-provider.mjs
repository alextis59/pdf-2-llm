const defaultMaxBatchPixels = 8_000_000;
const defaultMaxMemoryBytes = 256 * 1024 * 1024;
const bytesPerPixelRgba = 4;
const gpuRoutedSourceTypes = new Set(["scanned", "hybrid"]);

export function createWebGpuExecutionPlan({
  options = {},
  rasterPlan = null,
  scanDetection = null,
  webgpu = null
} = {}) {
  const maxBatchPixels = positiveInteger(options.maxBatchPixels, defaultMaxBatchPixels);
  const maxMemoryBytes = positiveInteger(options.maxMemoryBytes, defaultMaxMemoryBytes);
  const routedPages = routedOcrPages(scanDetection);
  const rasterPagesByIndex = new Map(
    (rasterPlan?.pages ?? []).map((page) => [page.pageIndex, page])
  );

  if (webgpu?.selectedProvider !== "webgpu") {
    return createDiagnostics({
      batches: [],
      maxBatchPixels,
      maxMemoryBytes,
      provider: "cpu",
      routedPages,
      skippedPages: [],
      status: routedPages.length === 0 ? "no-routed-pages" : "cpu-fallback",
      totalEstimatedBytes: 0,
      totalEstimatedPixels: 0,
      fallbackReason: webgpu?.fallbackReason ?? "webgpu-unavailable"
    });
  }

  const pages = routedPages.map((page) => {
    const rasterPage = rasterPagesByIndex.get(page.pageIndex) ?? null;
    const pixelCount = rasterPage?.pixelCount ?? null;
    const estimatedBytes = pixelCount === null ? null : pixelCount * bytesPerPixelRgba;
    const status =
      pixelCount === null
        ? "missing-raster"
        : estimatedBytes > maxMemoryBytes
          ? "exceeds-memory-limit"
          : "planned";
    return {
      pageIndex: page.pageIndex,
      sourceType: page.sourceType,
      rasterStatus: rasterPage?.status ?? "missing",
      pixelCount,
      estimatedBytes,
      status
    };
  });
  const plannedPages = pages.filter((page) => page.status === "planned");
  const skippedPages = pages.filter((page) => page.status !== "planned");
  const batches = createBatches(plannedPages, {
    maxBatchPixels,
    maxMemoryBytes
  });

  return createDiagnostics({
    batches,
    maxBatchPixels,
    maxMemoryBytes,
    provider: "webgpu",
    routedPages,
    skippedPages,
    status: batches.length > 0 ? "planned" : skippedPages.length > 0 ? "skipped" : "no-routed-pages",
    totalEstimatedBytes: plannedPages.reduce((total, page) => total + page.estimatedBytes, 0),
    totalEstimatedPixels: plannedPages.reduce((total, page) => total + page.pixelCount, 0),
    fallbackReason: null
  });
}

function createDiagnostics({
  batches,
  fallbackReason,
  maxBatchPixels,
  maxMemoryBytes,
  provider,
  routedPages,
  skippedPages,
  status,
  totalEstimatedBytes,
  totalEstimatedPixels
}) {
  return {
    enabled: provider === "webgpu",
    provider,
    status,
    fallbackReason,
    workload: "ocr",
    routedPages: routedPages.length,
    plannedPages: batches.reduce((total, batch) => total + batch.pages.length, 0),
    skippedPages: skippedPages.length,
    totalEstimatedPixels,
    totalEstimatedBytes,
    limits: {
      maxBatchPixels,
      maxMemoryBytes,
      bytesPerPixel: bytesPerPixelRgba
    },
    batches,
    skipped: skippedPages
  };
}

function routedOcrPages(scanDetection) {
  return (scanDetection?.pages ?? [])
    .filter((page) => gpuRoutedSourceTypes.has(page.sourceType))
    .map((page) => ({
      pageIndex: page.pageIndex,
      sourceType: page.sourceType
    }));
}

function createBatches(pages, { maxBatchPixels, maxMemoryBytes }) {
  const batches = [];
  let current = emptyBatch();

  for (const page of pages) {
    const wouldExceedLimits =
      current.pages.length > 0 &&
      (current.pixelCount + page.pixelCount > maxBatchPixels ||
        current.estimatedBytes + page.estimatedBytes > maxMemoryBytes);
    if (wouldExceedLimits) {
      batches.push(finalizeBatch(current, batches.length));
      current = emptyBatch();
    }
    current.pages.push({
      pageIndex: page.pageIndex,
      sourceType: page.sourceType,
      pixelCount: page.pixelCount,
      estimatedBytes: page.estimatedBytes
    });
    current.pixelCount += page.pixelCount;
    current.estimatedBytes += page.estimatedBytes;
  }

  if (current.pages.length > 0) {
    batches.push(finalizeBatch(current, batches.length));
  }
  return batches;
}

function emptyBatch() {
  return {
    pages: [],
    pixelCount: 0,
    estimatedBytes: 0
  };
}

function finalizeBatch(batch, index) {
  return {
    batchIndex: index,
    pages: batch.pages,
    pixelCount: batch.pixelCount,
    estimatedBytes: batch.estimatedBytes
  };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
