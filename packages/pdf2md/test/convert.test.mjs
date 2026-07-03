import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { convertPdfToMarkdown, warningCodes } from "../src/index.mjs";
import { convertPdfToMarkdown as convertPdfToMarkdownFromNode } from "../src/node.mjs";
import { convertPdfToMarkdown as convertPdfToMarkdownFromBrowser } from "../src/browser.mjs";
import { binarizeRgbaCpu } from "../src/webgpu-preprocess.mjs";

const fixturePath = new URL("../../../corpus/generated/synthetic-simple-text.pdf", import.meta.url);
const twoColumnFixturePath = new URL(
  "../../../corpus/generated/synthetic-two-column.pdf",
  import.meta.url
);
const footnoteFixturePath = new URL(
  "../../../corpus/generated/synthetic-footnote.pdf",
  import.meta.url
);
const headerFooterFixturePath = new URL(
  "../../../corpus/generated/synthetic-header-footer.pdf",
  import.meta.url
);
const vectorFigureFixturePath = new URL(
  "../../../corpus/generated/synthetic-vector-figure.pdf",
  import.meta.url
);
const visibleTableFixturePath = new URL(
  "../../../corpus/generated/synthetic-visible-table.pdf",
  import.meta.url
);
const rotatedPageFixturePath = new URL(
  "../../../corpus/generated/synthetic-rotated-page.pdf",
  import.meta.url
);
const croppedPageFixturePath = new URL(
  "../../../corpus/generated/synthetic-cropped-page.pdf",
  import.meta.url
);

test("convertPdfToMarkdown returns the scaffold contract for a corpus PDF", async () => {
  const bytes = await readFile(fixturePath);
  const progress = [];
  const result = await convertPdfToMarkdown(bytes, {
    ocr: { enabled: false },
    onProgress(event) {
      progress.push(event.stage);
    }
  });

  assert.match(result.markdown, /^# Synthetic Simple Text/);
  assert.equal(result.ir.schemaVersion, "0.1.0");
  assert.equal(result.ir.sourceType, "digital");
  assert.equal(result.ir.pages.length, 1);
  assert.equal(result.ir.pages[0].widthPt, 612);
  assert.equal(result.ir.pages[0].heightPt, 792);
  assert.equal(result.sourceMap.schemaVersion, "0.1.0");
  assert.equal(result.sourceMap.target, "markdown");
  assert.equal(result.sourceMap.entries[0].kind, "heading");
  assert.match(
    result.markdown.slice(
      result.sourceMap.entries[0].markdownStart,
      result.sourceMap.entries[0].markdownEnd
    ),
    /^# Synthetic Simple Text/
  );
  assert.equal(result.sourceMap.entries[0].regions[0].pageIndex, 0);
  assert.equal(result.diagnostics.input.bytes, bytes.byteLength);
  assert.equal(result.diagnostics.input.pdfVersion, "1.4");
  assert.equal(result.diagnostics.input.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.diagnostics.options.ocrEnabled, false);
  assert.equal(result.diagnostics.options.ocrAdapter, "tesseract.js");
  assert.equal(result.diagnostics.options.ocrAdapterStatus, "disabled");
  assert.deepEqual(result.diagnostics.options.ocrLanguages, ["eng"]);
  assert.equal(result.diagnostics.extraction.ocr.enabled, false);
  assert.equal(result.diagnostics.extraction.ocr.status, "disabled");
  assert.equal(result.diagnostics.extraction.ocr.adapter.id, "tesseract.js");
  assert.equal(result.diagnostics.extraction.ocr.adapter.version, "7.0.0");
  assert.equal(result.diagnostics.extraction.ocr.adapter.license, "Apache-2.0");
  assert.equal(result.diagnostics.extraction.layout.pages[0].kind, "single-column");
  assert.equal(result.confidence.layout, 0.35);
  assert.deepEqual(progress, ["start", "complete"]);
  assert.ok(result.warnings.some((warning) => warning.code === warningCodes.HeuristicTextExtraction));
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === warningCodes.OcrDisabled && warning.message === "OCR is disabled by options."
    )
  );
});

test("convertPdfToMarkdown supports path input", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname);
  assert.equal(result.diagnostics.input.source.type, "path");
  assert.equal(result.diagnostics.input.pdfVersion, "1.4");
});

test("convertPdfToMarkdown selects the CPU OCR adapter", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname, {
    ocr: {
      adapter: "tesseract.js",
      languages: ["eng", "fra"],
      modelBaseUrl: "/models/tesseract",
      cache: {
        enabled: true,
        strategy: "adapter-default",
        directory: ".cache/pdf2md-ocr"
      }
    }
  });

  assert.equal(result.diagnostics.options.ocrEnabled, true);
  assert.equal(result.diagnostics.options.ocrAdapter, "tesseract.js");
  assert.equal(result.diagnostics.options.ocrAdapterStatus, "selected");
  assert.deepEqual(result.diagnostics.options.ocrLanguages, ["eng", "fra"]);
  assert.deepEqual(result.diagnostics.extraction.ocr, {
    enabled: true,
    requested: "tesseract.js",
    status: "selected",
    languages: ["eng", "fra"],
    language: {
      enabled: true,
      status: "no-routed-pages",
      defaultLanguages: ["eng", "fra"],
      modelLanguages: ["eng", "fra"],
      workerLanguage: "eng+fra",
      pageOverrides: [],
      pages: []
    },
    modelLoading: {
      strategy: "lazy",
      trigger: "routed-scanned-or-hybrid-pages",
      workerLifecycle: "reuse-worker-per-language-set",
      source: "/models/tesseract",
      languages: ["eng", "fra"],
      modelFiles: ["eng.traineddata", "fra.traineddata"],
      cache: {
        enabled: true,
        strategy: "adapter-default",
        directory: ".cache/pdf2md-ocr",
        keyPrefix: "tesseract.js:7.0.0",
        browser: "adapter-default-indexeddb",
        node: "adapter-default-filesystem"
      }
    },
    preprocessing: {
      enabled: true,
      status: "no-routed-pages",
      strategy: "metadata-first",
      thresholds: {
        minDeskewDegrees: 0.25,
        maxDeskewDegrees: 15
      },
      pages: []
    },
    reconciliation: {
      status: "completed",
      strategy: "page-source-selection",
      selectedPdfTextLines: 3,
      selectedOcrTextLines: 0,
      suppressedPdfTextLines: 0,
      suppressedOcrTextLines: 0,
      pages: [
        {
          pageIndex: 0,
          sourceType: "digital",
          selected: "pdf",
          reason: "digital-page-pdf",
          pdfTextLines: 3,
          ocrTextLines: 0,
          pdfVisibleTextLines: 3,
          pdfHiddenTextLines: 0,
          pdfHiddenImageAlignedTextLines: 0,
          pdfHiddenImageUnalignedTextLines: 0,
          pdfVisibleGeometryAligned: true,
          selectedPdfTextLines: 3,
          selectedOcrTextLines: 0,
          suppressedPdfTextLines: 0,
          suppressedOcrTextLines: 0
        }
      ]
    },
    sidecars: {
      enabled: false,
      assets: 0,
      pages: []
    },
    textBoxes: {
      enabled: true,
      status: "no-routed-pages",
      source: "none",
      routedPages: 0,
      completedPages: 0,
      totalBoxes: 0,
      averageConfidence: null,
      pages: []
    },
    adapter: {
      id: "tesseract.js",
      kind: "cpu",
      packageName: "tesseract.js",
      version: "7.0.0",
      license: "Apache-2.0",
      runtimes: ["browser", "node", "worker"],
      output: "ocr-plan",
      notes: "Selected CPU OCR adapter; model loading and recognition are wired in later OCR phases."
    }
  });
});

test("convertPdfToMarkdown reports WebGPU CPU fallback diagnostics by default", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname);

  assert.equal(result.diagnostics.options.webgpuRequired, false);
  assert.equal(result.diagnostics.options.webgpuPreferred, false);
  assert.equal(result.diagnostics.acceleration.webgpu.enabled, false);
  assert.equal(result.diagnostics.acceleration.webgpu.requested, "disabled");
  assert.equal(result.diagnostics.acceleration.webgpu.status, "disabled");
  assert.equal(result.diagnostics.acceleration.webgpu.selectedProvider, "cpu");
  assert.equal(result.diagnostics.acceleration.webgpu.fallbackReason, "not-requested");
  assert.equal(result.diagnostics.acceleration.webgpu.execution.provider, "cpu");
  assert.equal(result.diagnostics.acceleration.webgpu.execution.status, "no-routed-pages");
  assert.equal(result.diagnostics.acceleration.webgpu.execution.routedPages, 0);
});

test("convertPdfToMarkdown preserves OCR outputs when WebGPU falls back to CPU", async () => {
  const bytes = createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 });
  const createOptions = (webgpu) => ({
    webgpu,
    ocr: {
      results: [
        {
          pageIndex: 0,
          coordinateSpace: "page",
          lines: [
            {
              text: "Provider parity OCR text",
              confidence: 94,
              x: 72,
              y: 720,
              width: 170,
              height: 12
            }
          ]
        }
      ]
    }
  });

  const cpuResult = await convertPdfToMarkdown(bytes, createOptions(undefined));
  const fallbackResult = await convertPdfToMarkdown(bytes, createOptions({ preferred: true }));

  assert.equal(fallbackResult.diagnostics.acceleration.webgpu.selectedProvider, "cpu");
  assert.equal(fallbackResult.diagnostics.acceleration.webgpu.fallbackReason, "node-stable-gpu-path-unavailable");
  assert.deepEqual(fallbackResult.diagnostics.acceleration.webgpu.execution.output, {
    format: "ocr-result-pages",
    source: "options.ocr.results",
    normalizedBy: "ocr-text",
    coordinateSpaces: ["page", "raster"],
    compatibleWith: "cpu"
  });
  assert.equal(fallbackResult.markdown, cpuResult.markdown);
  assert.deepEqual(fallbackResult.sourceMap, cpuResult.sourceMap);
  assert.deepEqual(fallbackResult.ir, cpuResult.ir);
  assert.deepEqual(fallbackResult.assets, cpuResult.assets);
});

test("convertPdfToMarkdown routes WebGPU OCR preprocessing with a supplied device and runner", async () => {
  const bytes = createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 });
  const calls = [];
  const result = await convertPdfToMarkdown(bytes, {
    raster: {
      enabled: true,
      dpi: 72
    },
    webgpu: {
      preferred: true,
      device: {
        label: "supplied test device"
      },
      preprocessing: {
        maxSamplePixelsPerPage: 16,
        runner: {
          async run(rgba, options) {
            calls.push(options.page.pageIndex);
            return binarizeRgbaCpu(rgba, { threshold: options.threshold });
          }
        }
      }
    }
  });

  assert.deepEqual(calls, [0]);
  assert.equal(result.diagnostics.acceleration.webgpu.selectedProvider, "webgpu");
  assert.equal(result.diagnostics.acceleration.webgpu.device.source, "supplied");
  assert.equal(result.diagnostics.acceleration.webgpu.execution.provider, "webgpu");
  assert.equal(result.diagnostics.acceleration.webgpu.preprocessing.status, "completed");
  assert.equal(result.diagnostics.acceleration.webgpu.preprocessing.processedPages, 1);
  assert.equal(result.diagnostics.acceleration.webgpu.preprocessing.totalSamplePixels, 16);
  assert.equal(result.diagnostics.acceleration.webgpu.preprocessing.parity, true);
});

test("convertPdfToMarkdown records OCR page language overrides", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 }),
    {
      ocr: {
        languages: ["eng"],
        pageLanguages: [
          {
            pageIndex: 0,
            languages: ["fra", "deu"]
          }
        ]
      }
    }
  );

  assert.deepEqual(result.diagnostics.extraction.ocr.language, {
    enabled: true,
    status: "configured",
    defaultLanguages: ["eng"],
    modelLanguages: ["eng", "fra", "deu"],
    workerLanguage: "eng",
    pageOverrides: [
      {
        pageIndex: 0,
        languages: ["fra", "deu"],
        workerLanguage: "fra+deu",
        modelFiles: ["fra.traineddata", "deu.traineddata"]
      }
    ],
    pages: [
      {
        pageIndex: 0,
        sourceType: "scanned",
        languages: ["fra", "deu"],
        workerLanguage: "fra+deu",
        modelFiles: ["fra.traineddata", "deu.traineddata"]
      }
    ]
  });
  assert.deepEqual(result.diagnostics.extraction.ocr.modelLoading.languages, [
    "eng",
    "fra",
    "deu"
  ]);
  assert.deepEqual(result.diagnostics.extraction.ocr.modelLoading.modelFiles, [
    "eng.traineddata",
    "fra.traineddata",
    "deu.traineddata"
  ]);
});

test("convertPdfToMarkdown expands OCR script hints into language packs", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 }),
    {
      ocr: {
        scripts: ["japanese", "vertical"],
        pageLanguages: [
          {
            pageIndex: 0,
            scripts: ["rtl"]
          }
        ]
      }
    }
  );

  assert.deepEqual(result.diagnostics.extraction.ocr.languages, ["eng", "jpn", "jpn_vert"]);
  assert.deepEqual(result.diagnostics.extraction.ocr.modelLoading.languages, [
    "eng",
    "jpn",
    "jpn_vert",
    "ara",
    "heb"
  ]);
  assert.deepEqual(result.diagnostics.extraction.ocr.language.pages, [
    {
      pageIndex: 0,
      sourceType: "scanned",
      languages: ["ara", "heb"],
      workerLanguage: "ara+heb",
      modelFiles: ["ara.traineddata", "heb.traineddata"]
    }
  ]);
});

test("convertPdfToMarkdown can emit Markdown page anchors", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname, {
    markdown: { pageAnchors: true }
  });

  assert.match(result.markdown, /^<a id="page-1"><\/a>\n\n# Synthetic Simple Text/);
  assert.equal(result.diagnostics.options.pageAnchors, true);
});

test("convertPdfToMarkdown can preserve configured running titles", async () => {
  const result = await convertPdfToMarkdown(headerFooterFixturePath.pathname, {
    markdown: { preserveRunningTitles: true }
  });

  assert.match(result.markdown, /^Running Header\n\n# Header Footer Fixture/);
  assert.match(result.markdown, /Running Header\n\nSecond page body\./);
  assert.doesNotMatch(result.markdown, /Page Footer/);
  assert.equal(result.diagnostics.options.preserveRunningTitles, true);
});

test("convertPdfToMarkdown exposes the selected scoped raster path when enabled", async () => {
  const result = await convertPdfToMarkdown(fixturePath.pathname, {
    raster: { enabled: true, dpi: 144, thumbnailDpi: 72 }
  });

  assert.equal(result.diagnostics.options.rasterEnabled, true);
  assert.equal(result.diagnostics.options.rasterRenderer, "internal-page-geometry");
  assert.equal(result.diagnostics.options.rasterDpi, 144);
  assert.equal(result.diagnostics.options.rasterThumbnailDpi, 72);
  assert.equal(result.diagnostics.options.maxImagePixels, 100_000_000);
  assert.equal(result.diagnostics.extraction.raster.enabled, true);
  assert.equal(result.diagnostics.extraction.raster.dpi, 144);
  assert.equal(result.diagnostics.extraction.raster.thumbnailDpi, 72);
  assert.equal(result.diagnostics.extraction.raster.maxPixels, 100_000_000);
  assert.equal(result.diagnostics.extraction.raster.limitedPages, 0);
  assert.equal(result.diagnostics.extraction.raster.limitedThumbnails, 0);
  assert.equal(result.diagnostics.extraction.raster.renderer.id, "internal-page-geometry");
  assert.equal(result.diagnostics.extraction.raster.renderer.dependency, null);
  assert.equal(result.diagnostics.extraction.raster.renderer.status, "selected");
  assert.deepEqual(result.diagnostics.extraction.raster.retention, {
    strategy: "metadata-only",
    pagePixelsRetained: false,
    thumbnailPixelsRetained: false,
    retainedBytes: 0
  });
  assert.deepEqual(result.diagnostics.extraction.raster.pages, [
    {
      pageIndex: 0,
      status: "planned",
      sourceBox: "mediaBox",
      boxPt: [0, 0, 612, 792],
      sourceWidthPt: 612,
      sourceHeightPt: 792,
      widthPt: 612,
      heightPt: 792,
      dpi: 144,
      scale: 2,
      widthPx: 1224,
      heightPx: 1584,
      pixelCount: 1938816,
      maxPixels: 100_000_000,
      exceedsPixelLimit: false,
      thumbnail: {
        status: "planned",
        dpi: 72,
        scale: 1,
        widthPx: 612,
        heightPx: 792,
        pixelCount: 484704,
        maxPixels: 100_000_000,
        exceedsPixelLimit: false
      },
      rotation: 0,
      quarterTurn: false,
      userUnit: 1
    }
  ]);
});

test("convertPdfToMarkdown raster diagnostics cover rotated and cropped generated pages", async () => {
  const rotated = await convertPdfToMarkdown(rotatedPageFixturePath.pathname, {
    raster: { enabled: true, dpi: 72 }
  });
  const cropped = await convertPdfToMarkdown(croppedPageFixturePath.pathname, {
    raster: { enabled: true, dpi: 72 }
  });

  assert.deepEqual(pickRasterFixtureFields(rotated.diagnostics.extraction.raster.pages[0]), {
    sourceBox: "mediaBox",
    boxPt: [0, 0, 612, 792],
    sourceWidthPt: 612,
    sourceHeightPt: 792,
    widthPt: 792,
    heightPt: 612,
    widthPx: 792,
    heightPx: 612,
    rotation: 90,
    quarterTurn: true,
    thumbnail: {
      widthPx: 396,
      heightPx: 306
    }
  });
  assert.deepEqual(pickRasterFixtureFields(cropped.diagnostics.extraction.raster.pages[0]), {
    sourceBox: "cropBox",
    boxPt: [36, 300, 576, 756],
    sourceWidthPt: 540,
    sourceHeightPt: 456,
    widthPt: 540,
    heightPt: 456,
    widthPx: 540,
    heightPx: 456,
    rotation: 0,
    quarterTurn: false,
    thumbnail: {
      widthPx: 270,
      heightPx: 228
    }
  });
});

test("convertPdfToMarkdown reports image-dominant scan detection diagnostics", async () => {
  const fullPage = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 })
  );
  const smallImage = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 72, y: 600, widthPt: 72, heightPt: 72 })
  );

  assert.equal(fullPage.ir.sourceType, "scanned");
  assert.equal(fullPage.ir.pages[0].sourceType, "scanned");
  assert.equal(fullPage.diagnostics.extraction.scanDetection.sourceType, "scanned");
  assert.deepEqual(fullPage.diagnostics.extraction.scanDetection.sourceTypeCounts, {
    digital: 0,
    scanned: 1,
    hybrid: 0,
    unknown: 0
  });
  assert.equal(fullPage.diagnostics.extraction.scanDetection.routingConfidence, 0.95);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.thresholds.imageCoverageRatio, 0.5);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.thresholds.minTextLines, 3);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.thresholds.minTextAreaRatio, 0.01);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.thresholds.minHiddenTextLines, 1);
  assert.equal(
    fullPage.diagnostics.extraction.scanDetection.thresholds.minHiddenTextImageOverlapRatio,
    0.5
  );
  assert.equal(fullPage.diagnostics.extraction.scanDetection.imageDominantPages, 1);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.littleOrNoTextPages, 1);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.hiddenOcrOverlayPages, 0);
  assert.equal(fullPage.diagnostics.extraction.scanDetection.hiddenTextImageMismatchPages, 0);
  assert.deepEqual(fullPage.diagnostics.extraction.scanDetection.pages[0], {
    pageIndex: 0,
    sourceType: "scanned",
    routingConfidence: 0.95,
    routingReasons: ["image_dominant", "no_text"],
    textLineCount: 0,
    textArea: 0,
    textAreaRatio: 0,
    noText: true,
    littleText: false,
    littleOrNoText: true,
    hiddenTextLineCount: 0,
    hiddenTextArea: 0,
    hiddenTextAreaRatio: 0,
    hiddenOcrOverlayLikely: false,
    hiddenTextImageMismatchLineCount: 0,
    hiddenTextImageMismatchLikely: false,
    imageResourceCount: 1,
    imageDrawCount: 1,
    pageArea: 484704,
    totalImageArea: 484704,
    maxImageArea: 484704,
    imageCoverageRatio: 1,
    maxImageCoverageRatio: 1,
    imageDominant: true,
    imageDominanceConfidence: 0.95,
    imageDraws: [
      {
        name: "ImScan",
        objectNumber: 6,
        x: 0,
        y: 0,
        width: 612,
        height: 792,
        area: 484704,
        imageWidth: 2550,
        imageHeight: 3300,
        imagePixels: 8415000,
        streamIndex: 0,
        source: "xobject-do"
      }
    ]
  });
  assert.equal(smallImage.diagnostics.extraction.scanDetection.imageDominantPages, 0);
  assert.equal(smallImage.diagnostics.extraction.scanDetection.pages[0].imageDominant, false);
  assert.equal(smallImage.diagnostics.extraction.scanDetection.pages[0].imageCoverageRatio, 0.010695);
});

test("convertPdfToMarkdown reports little and no-text scan detection diagnostics", async () => {
  const tinyText = await convertPdfToMarkdown(
    createSinglePageTextPdf([textOperation(72, 720, 12, "Tiny")])
  );
  const normalText = await convertPdfToMarkdown(fixturePath.pathname);

  assert.equal(tinyText.diagnostics.extraction.scanDetection.littleOrNoTextPages, 1);
  assert.equal(tinyText.diagnostics.extraction.scanDetection.pages[0].textLineCount, 1);
  assert.equal(tinyText.diagnostics.extraction.scanDetection.pages[0].textArea, 288);
  assert.equal(tinyText.diagnostics.extraction.scanDetection.pages[0].textAreaRatio, 0.000594);
  assert.equal(tinyText.diagnostics.extraction.scanDetection.pages[0].noText, false);
  assert.equal(tinyText.diagnostics.extraction.scanDetection.pages[0].littleText, true);
  assert.equal(tinyText.diagnostics.extraction.scanDetection.pages[0].littleOrNoText, true);
  assert.equal(normalText.ir.sourceType, "digital");
  assert.equal(normalText.ir.pages[0].sourceType, "digital");
  assert.equal(normalText.diagnostics.extraction.scanDetection.littleOrNoTextPages, 0);
  assert.equal(normalText.diagnostics.extraction.scanDetection.pages[0].sourceType, "digital");
  assert.equal(normalText.diagnostics.extraction.scanDetection.pages[0].routingConfidence, 0.9);
  assert.deepEqual(normalText.diagnostics.extraction.scanDetection.pages[0].routingReasons, [
    "text_present"
  ]);
  assert.equal(normalText.diagnostics.extraction.scanDetection.pages[0].noText, false);
  assert.equal(normalText.diagnostics.extraction.scanDetection.pages[0].littleText, false);
  assert.equal(normalText.diagnostics.extraction.scanDetection.pages[0].littleOrNoText, false);
});

test("convertPdfToMarkdown reports hidden OCR overlay scan diagnostics", async () => {
  const hiddenOverlay = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 612,
      heightPt: 792,
      textOperations: [invisibleTextOperation(72, 720, 12, "OCR")]
    })
  );
  const visibleOverlay = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 612,
      heightPt: 792,
      textOperations: [textOperation(72, 720, 12, "OCR")]
    })
  );
  const hiddenPage = hiddenOverlay.diagnostics.extraction.scanDetection.pages[0];
  const visiblePage = visibleOverlay.diagnostics.extraction.scanDetection.pages[0];

  assert.equal(hiddenOverlay.ir.sourceType, "hybrid");
  assert.equal(hiddenOverlay.ir.pages[0].sourceType, "hybrid");
  assert.equal(hiddenOverlay.diagnostics.extraction.scanDetection.sourceType, "hybrid");
  assert.equal(hiddenOverlay.diagnostics.extraction.scanDetection.hiddenOcrOverlayPages, 1);
  assert.equal(hiddenPage.sourceType, "hybrid");
  assert.equal(hiddenPage.routingConfidence, 0.9);
  assert.deepEqual(hiddenPage.routingReasons, ["image_dominant", "hidden_ocr_overlay"]);
  assert.equal(hiddenPage.imageDominant, true);
  assert.equal(hiddenPage.hiddenTextLineCount, 1);
  assert.equal(hiddenPage.hiddenTextArea, 216);
  assert.equal(hiddenPage.hiddenTextAreaRatio, 0.000446);
  assert.equal(hiddenPage.hiddenOcrOverlayLikely, true);
  assert.equal(hiddenPage.hiddenTextImageMismatchLineCount, 0);
  assert.equal(hiddenPage.hiddenTextImageMismatchLikely, false);
  assert.equal(visibleOverlay.diagnostics.extraction.scanDetection.hiddenOcrOverlayPages, 0);
  assert.equal(visiblePage.hiddenTextLineCount, 0);
  assert.equal(visiblePage.hiddenOcrOverlayLikely, false);
  assert.equal(visiblePage.hiddenTextImageMismatchLikely, false);
});

test("convertPdfToMarkdown reports hidden text and visible image geometry mismatches", async () => {
  const mismatch = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 400,
      heightPt: 792,
      textOperations: [invisibleTextOperation(500, 720, 12, "OCR")]
    })
  );
  const page = mismatch.diagnostics.extraction.scanDetection.pages[0];

  assert.equal(mismatch.diagnostics.extraction.scanDetection.hiddenTextImageMismatchPages, 1);
  assert.equal(mismatch.ir.sourceType, "hybrid");
  assert.equal(page.sourceType, "hybrid");
  assert.equal(page.routingConfidence, 0.6);
  assert.deepEqual(page.routingReasons, [
    "image_dominant",
    "hidden_ocr_overlay",
    "hidden_text_image_mismatch"
  ]);
  assert.equal(page.imageDominant, true);
  assert.equal(page.imageCoverageRatio, 0.653595);
  assert.equal(page.hiddenOcrOverlayLikely, true);
  assert.equal(page.hiddenTextImageMismatchLineCount, 1);
  assert.equal(page.hiddenTextImageMismatchLikely, true);
});

test("convertPdfToMarkdown emits OCR text boxes with confidence for routed scan pages", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 }),
    {
      ocr: {
        adapter: "tesseract.js",
        debugSidecars: true,
        results: [
          {
            pageIndex: 0,
            language: "eng",
            coordinateSpace: "page",
            lines: [
              {
                text: "Scanned OCR line",
                confidence: 93,
                x: 72,
                y: 700,
                width: 180,
                height: 12
              },
              {
                text: "OCR body text",
                confidence: 0.82,
                x: 72,
                y: 680,
                width: 128,
                height: 12
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(result.ir.sourceType, "scanned");
  assert.equal(result.diagnostics.extraction.mode, "ocr");
  assert.equal(result.diagnostics.extraction.textLines, 2);
  assert.equal(result.diagnostics.options.ocrDebugSidecars, true);
  assert.deepEqual(result.diagnostics.extraction.ocr.textBoxes, {
    enabled: true,
    status: "completed",
    source: "options.ocr.results",
    routedPages: 1,
    completedPages: 1,
    totalBoxes: 2,
    averageConfidence: 0.875,
    pages: [
      {
        pageIndex: 0,
        sourceType: "scanned",
        status: "completed",
        coordinateSpace: "page",
        language: "eng",
        boxes: 2,
        averageConfidence: 0.875
      }
    ]
  });
  const expectedOcrSidecarContent = JSON.stringify(
    {
      pageIndex: 0,
      boxes: [
        {
          text: "Scanned OCR line",
          confidence: 0.93,
          x: 72,
          y: 700,
          width: 180,
          height: 12,
          direction: "ltr",
          language: "eng",
          coordinateSpace: "page"
        },
        {
          text: "OCR body text",
          confidence: 0.82,
          x: 72,
          y: 680,
          width: 128,
          height: 12,
          direction: "ltr",
          language: "eng",
          coordinateSpace: "page"
        }
      ]
    },
    null,
    2
  );
  assert.deepEqual(result.diagnostics.extraction.ocr.sidecars, {
    enabled: true,
    assets: 1,
    pages: [
      {
        pageIndex: 0,
        assetId: "ocr-page-1-json",
        boxes: 2
      }
    ]
  });
  assert.deepEqual(result.assets, [
    {
      id: "ocr-page-1-json",
      kind: "ocr-debug-json",
      path: "assets/ocr-page-1-json.json",
      mediaType: "application/json",
      content: expectedOcrSidecarContent,
      pageIndex: 0
    }
  ]);
  assert.deepEqual(result.ir.assets, result.assets);
  assert.match(result.markdown, /Scanned OCR line/);
  assert.equal(result.sourceMap.entries[0].regions[0].source, "ocr");
  assert.deepEqual(result.ir.pages[0].elements, [
    {
      type: "text",
      spans: [
        {
          text: "Scanned OCR line",
          x: 72,
          y: 700,
          width: 180,
          height: 12,
          direction: "ltr",
          confidence: 0.93,
          source: "ocr"
        }
      ]
    },
    {
      type: "text",
      spans: [
        {
          text: "OCR body text",
          x: 72,
          y: 680,
          width: 128,
          height: 12,
          direction: "ltr",
          confidence: 0.82,
          source: "ocr"
        }
      ]
    }
  ]);
});

test("convertPdfToMarkdown reconciles searchable hybrid pages without OCR duplicates", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 612,
      heightPt: 792,
      textOperations: [
        textOperation(72, 720, 12, "PDF layer text"),
        textOperation(72, 700, 12, "Second PDF layer line"),
        textOperation(72, 680, 12, "Third PDF layer line")
      ]
    }),
    {
      ocr: {
        results: [
          {
            pageIndex: 0,
            coordinateSpace: "page",
            lines: [
              {
                text: "OCR duplicate text",
                confidence: 92,
                x: 72,
                y: 720,
                width: 130,
                height: 12
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(result.ir.sourceType, "hybrid");
  assert.equal(result.diagnostics.extraction.mode, "parsed-content-streams");
  assert.equal(result.diagnostics.extraction.textLines, 3);
  assert.match(result.markdown, /PDF layer text/);
  assert.doesNotMatch(result.markdown, /OCR duplicate text/);
  assert.deepEqual(result.diagnostics.extraction.ocr.reconciliation, {
    status: "completed",
    strategy: "page-source-selection",
    selectedPdfTextLines: 3,
    selectedOcrTextLines: 0,
    suppressedPdfTextLines: 0,
    suppressedOcrTextLines: 1,
    pages: [
      {
        pageIndex: 0,
        sourceType: "hybrid",
        selected: "pdf",
        reason: "pdf-visible-geometry-aligned",
        pdfTextLines: 3,
        ocrTextLines: 1,
        pdfVisibleTextLines: 3,
        pdfHiddenTextLines: 0,
        pdfHiddenImageAlignedTextLines: 0,
        pdfHiddenImageUnalignedTextLines: 0,
        pdfVisibleGeometryAligned: true,
        selectedPdfTextLines: 3,
        selectedOcrTextLines: 0,
        suppressedPdfTextLines: 0,
        suppressedOcrTextLines: 1
      }
    ]
  });
});

test("convertPdfToMarkdown prefers aligned hidden PDF text over OCR duplicates", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 612,
      heightPt: 792,
      textOperations: [invisibleTextOperation(72, 720, 12, "Aligned hidden layer")]
    }),
    {
      ocr: {
        results: [
          {
            pageIndex: 0,
            coordinateSpace: "page",
            lines: [
              {
                text: "OCR duplicate layer",
                confidence: 91,
                x: 72,
                y: 720,
                width: 130,
                height: 12
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(result.ir.sourceType, "hybrid");
  assert.equal(result.diagnostics.extraction.scanDetection.hiddenTextImageMismatchPages, 0);
  assert.match(result.markdown, /Aligned hidden layer/);
  assert.doesNotMatch(result.markdown, /OCR duplicate layer/);
  assert.deepEqual(result.diagnostics.extraction.ocr.reconciliation.pages[0], {
    pageIndex: 0,
    sourceType: "hybrid",
    selected: "pdf",
    reason: "pdf-visible-geometry-aligned",
    pdfTextLines: 1,
    ocrTextLines: 1,
    pdfVisibleTextLines: 0,
    pdfHiddenTextLines: 1,
    pdfHiddenImageAlignedTextLines: 1,
    pdfHiddenImageUnalignedTextLines: 0,
    pdfVisibleGeometryAligned: true,
    selectedPdfTextLines: 1,
    selectedOcrTextLines: 0,
    suppressedPdfTextLines: 0,
    suppressedOcrTextLines: 1
  });
});

test("convertPdfToMarkdown reconciles hidden text mismatch hybrid pages to OCR", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 400,
      heightPt: 792,
      textOperations: [invisibleTextOperation(520, 720, 12, "Bad hidden layer")]
    }),
    {
      ocr: {
        results: [
          {
            pageIndex: 0,
            coordinateSpace: "page",
            lines: [
              {
                text: "Correct visible text",
                confidence: 94,
                x: 72,
                y: 700,
                width: 150,
                height: 12
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(result.ir.sourceType, "hybrid");
  assert.equal(result.diagnostics.extraction.mode, "ocr");
  assert.equal(result.diagnostics.extraction.scanDetection.hiddenTextImageMismatchPages, 1);
  assert.match(result.markdown, /Correct visible text/);
  assert.doesNotMatch(result.markdown, /Bad hidden layer/);
  assert.deepEqual(result.diagnostics.extraction.ocr.reconciliation, {
    status: "completed",
    strategy: "page-source-selection",
    selectedPdfTextLines: 0,
    selectedOcrTextLines: 1,
    suppressedPdfTextLines: 1,
    suppressedOcrTextLines: 0,
    pages: [
      {
        pageIndex: 0,
        sourceType: "hybrid",
        selected: "ocr",
        reason: "pdf-visible-geometry-mismatch",
        pdfTextLines: 1,
        ocrTextLines: 1,
        pdfVisibleTextLines: 0,
        pdfHiddenTextLines: 1,
        pdfHiddenImageAlignedTextLines: 0,
        pdfHiddenImageUnalignedTextLines: 1,
        pdfVisibleGeometryAligned: false,
        selectedPdfTextLines: 0,
        selectedOcrTextLines: 1,
        suppressedPdfTextLines: 1,
        suppressedOcrTextLines: 0
      }
    ]
  });
});

test("convertPdfToMarkdown chooses reliable searchable scan text per region", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({
      x: 0,
      y: 0,
      widthPt: 400,
      heightPt: 792,
      textOperations: [
        invisibleTextOperation(72, 720, 12, "Aligned hidden region"),
        invisibleTextOperation(520, 680, 12, "Bad hidden region")
      ]
    }),
    {
      ocr: {
        results: [
          {
            pageIndex: 0,
            coordinateSpace: "page",
            lines: [
              {
                text: "OCR duplicate region",
                confidence: 91,
                x: 72,
                y: 720,
                width: 140,
                height: 12
              },
              {
                text: "Correct OCR fallback",
                confidence: 94,
                x: 72,
                y: 680,
                width: 160,
                height: 12
              }
            ]
          }
        ]
      }
    }
  );

  assert.equal(result.ir.sourceType, "hybrid");
  assert.match(result.markdown, /Aligned hidden region/);
  assert.match(result.markdown, /Correct OCR fallback/);
  assert.doesNotMatch(result.markdown, /Bad hidden region/);
  assert.doesNotMatch(result.markdown, /OCR duplicate region/);
  assert.deepEqual(result.diagnostics.extraction.ocr.reconciliation, {
    status: "completed",
    strategy: "page-source-selection",
    selectedPdfTextLines: 1,
    selectedOcrTextLines: 1,
    suppressedPdfTextLines: 1,
    suppressedOcrTextLines: 1,
    pages: [
      {
        pageIndex: 0,
        sourceType: "hybrid",
        selected: "combined",
        reason: "hybrid-region-source-selection",
        pdfTextLines: 2,
        ocrTextLines: 2,
        pdfVisibleTextLines: 0,
        pdfHiddenTextLines: 2,
        pdfHiddenImageAlignedTextLines: 1,
        pdfHiddenImageUnalignedTextLines: 1,
        pdfVisibleGeometryAligned: false,
        selectedPdfTextLines: 1,
        selectedOcrTextLines: 1,
        suppressedPdfTextLines: 1,
        suppressedOcrTextLines: 1
      }
    ]
  });
});

test("convertPdfToMarkdown records OCR preprocessing for rotated scan pages", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792, rotation: 90 }),
    {
      raster: {
        enabled: true,
        dpi: 144
      }
    }
  );

  assert.equal(result.ir.sourceType, "scanned");
  assert.deepEqual(result.diagnostics.extraction.ocr.preprocessing, {
    enabled: true,
    status: "planned",
    strategy: "metadata-first",
    thresholds: {
      minDeskewDegrees: 0.25,
      maxDeskewDegrees: 15
    },
    pages: [
      {
        pageIndex: 0,
        sourceType: "scanned",
        status: "planned",
        rasterStatus: "planned",
        pageRotationDegrees: 90,
        rotationCorrectionDegrees: 270,
        deskewDegrees: 0,
        deskewConfidence: 0,
        operations: ["normalize-page-rotation", "estimate-deskew", "binarize", "denoise"],
        deferredOperations: []
      }
    ]
  });
});

test("browser and Node entrypoints convert a scanned OCR fixture", async () => {
  const bytes = createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 });
  const createOptions = () => ({
    ocr: {
      results: [
        {
          pageIndex: 0,
          coordinateSpace: "page",
          lines: [
            {
              text: "Runtime OCR fixture text",
              confidence: 96,
              x: 72,
              y: 720,
              width: 180,
              height: 12
            }
          ]
        }
      ]
    }
  });

  const nodeResult = await convertPdfToMarkdownFromNode(new Uint8Array(bytes), createOptions());
  const browserResult = await convertPdfToMarkdownFromBrowser(new Uint8Array(bytes), createOptions());

  for (const result of [nodeResult, browserResult]) {
    assert.equal(result.ir.sourceType, "scanned");
    assert.equal(result.ir.pages[0].sourceType, "scanned");
    assert.equal(result.diagnostics.extraction.mode, "ocr");
    assert.equal(result.diagnostics.extraction.ocr.reconciliation.selectedOcrTextLines, 1);
    assert.equal(result.diagnostics.extraction.ocr.textBoxes.completedPages, 1);
    assert.match(result.markdown, /Runtime OCR fixture text/);
  }
  assert.equal(browserResult.markdown, nodeResult.markdown);
});

test("CLI emits JSON scaffold output", () => {
  const cliPath = new URL("../src/cli.mjs", import.meta.url);
  const run = spawnSync(process.execPath, [cliPath.pathname, fixturePath.pathname, "--json"], {
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.diagnostics.input.pdfVersion, "1.4");
  assert.ok(
    result.warnings.some((warning) => warning.code === warningCodes.HeuristicTextExtraction)
  );
});

test("convertPdfToMarkdown warns when content stream order may be uncertain", async () => {
  const result = await convertPdfToMarkdown(twoColumnFixturePath.pathname);
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.TextOrderingUncertain
  );

  assert.ok(warning);
  assert.equal(warning.details.pageIndex, 0);
  assert.match(warning.details.previous.text, /Left column continues/);
  assert.match(warning.details.current.text, /Right column starts/);
  assert.equal(result.diagnostics.extraction.layout.pages[0].kind, "multi-column");
  assert.deepEqual(
    result.diagnostics.extraction.layout.pages[0].columns.map((column) => column.index),
    [0, 1]
  );
});

test("convertPdfToMarkdown reports footnote layout regions", async () => {
  const result = await convertPdfToMarkdown(footnoteFixturePath.pathname);
  const page = result.diagnostics.extraction.layout.pages[0];

  assert.equal(page.footnotes.length, 1);
  assert.equal(page.footnotes[0].kind, "footnote");
  assert.match(result.markdown, /1\. Footnote text belongs after the paragraph\./);
});

test("convertPdfToMarkdown emits equation blocks with diagnostics and source maps", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageTextPdf([
      textOperation(72, 720, 22, "Equation Fixture"),
      textOperation(72, 690, 12, "A short lead-in."),
      textOperation(168, 660, 12, "E = m c^2"),
      textOperation(72, 620, 12, "After the equation.")
    ])
  );

  assert.equal(
    result.markdown,
    "# Equation Fixture\n\nA short lead-in.\n\n$$\nE = m c^2\n$$\n\nAfter the equation.\n"
  );
  assert.deepEqual(
    result.sourceMap.entries.map((entry) => entry.kind),
    ["heading", "paragraph", "equation", "paragraph"]
  );
  assert.equal(result.sourceMap.entries[2].regions.length, 1);
  assert.equal(result.sourceMap.entries[2].regions[0].pageIndex, 0);
  assert.equal(result.sourceMap.entries[2].regions[0].source, "content-stream");
  assert.deepEqual(result.diagnostics.extraction.equations, {
    total: 1,
    unicodeEquations: 0,
    textEquations: 1,
    imageEquations: 0,
    formulaOcr: {
      enabled: false,
      status: "not-configured"
    },
    equations: [
      {
        equationIndex: 0,
        pageIndex: 0,
        source: "content-stream",
        text: "E = m c^2",
        latex: null,
        lineCount: 1,
        containsUnicodeMath: false,
        x: result.diagnostics.extraction.equations.equations[0].x,
        y: result.diagnostics.extraction.equations.equations[0].y,
        width: result.diagnostics.extraction.equations.equations[0].width,
        height: result.diagnostics.extraction.equations.equations[0].height
      }
    ]
  });
  assert.deepEqual(result.ir.pages[0].elements, [
    {
      type: "equation",
      text: "E = m c^2",
      x: result.diagnostics.extraction.equations.equations[0].x,
      y: result.diagnostics.extraction.equations.equations[0].y,
      width: result.diagnostics.extraction.equations.equations[0].width,
      height: result.diagnostics.extraction.equations.equations[0].height
    }
  ]);
});

test("convertPdfToMarkdown preserves low-confidence OCR equations as image assets", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 }),
    {
      ocr: {
        adapter: "tesseract.js",
        results: [
          {
            pageIndex: 0,
            language: "eng",
            coordinateSpace: "page",
            lines: [
              {
                text: "Equation Scan Fixture",
                confidence: 93,
                x: 72,
                y: 720,
                width: 210,
                height: 22
              },
              {
                text: "A short lead-in.",
                confidence: 91,
                x: 72,
                y: 690,
                width: 120,
                height: 12
              },
              {
                text: "E = m c^2",
                confidence: 42,
                x: 168,
                y: 660,
                width: 170,
                height: 12
              },
              {
                text: "After the equation.",
                confidence: 94,
                x: 72,
                y: 620,
                width: 130,
                height: 12
              }
            ]
          }
        ]
      },
      equations: {
        imageFallbackConfidence: 0.75
      }
    }
  );

  assert.equal(
    result.markdown,
    "# Equation Scan Fixture\n\nA short lead-in.\n\n![Equation 1](assets/document-page-1-equation-1.png)\n\nAfter the equation.\n"
  );
  assert.deepEqual(result.assets, [
    {
      id: "document-page-1-equation-1",
      kind: "equation-preview",
      path: "assets/document-page-1-equation-1.png",
      mediaType: "image/png",
      pageIndex: 0
    }
  ]);
  assert.deepEqual(result.diagnostics.extraction.equations, {
    total: 1,
    unicodeEquations: 0,
    textEquations: 0,
    imageEquations: 1,
    formulaOcr: {
      enabled: false,
      status: "not-configured"
    },
    equations: [
      {
        equationIndex: 0,
        pageIndex: 0,
        source: "ocr",
        text: "E = m c^2",
        latex: null,
        lineCount: 1,
        containsUnicodeMath: false,
        x: 168,
        y: 660,
        width: 170,
        height: 12,
        output: "image",
        assetId: "document-page-1-equation-1",
        assetPath: "assets/document-page-1-equation-1.png",
        assetMediaType: "image/png",
        confidence: 0.42,
        fallbackReason: "low-ocr-confidence",
        fallbackThreshold: 0.75
      }
    ]
  });
  assert.deepEqual(
    result.warnings.find((warning) => warning.code === warningCodes.EquationLowOcrConfidence),
    {
      code: warningCodes.EquationLowOcrConfidence,
      message: "Equation OCR confidence was low; the equation was preserved as an image asset.",
      details: {
        equationIndex: 0,
        pageIndex: 0,
        assetId: "document-page-1-equation-1",
        confidence: 0.42,
        threshold: 0.75,
        reason: "low-ocr-confidence"
      }
    }
  );
  assert.deepEqual(
    result.ir.pages[0].elements.find((element) => element.type === "equation"),
    {
      type: "equation",
      text: "E = m c^2",
      assetId: "document-page-1-equation-1",
      x: 168,
      y: 660,
      width: 170,
      height: 12
    }
  );
});

test("convertPdfToMarkdown applies optional formula OCR LaTeX", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageImagePdf({ x: 0, y: 0, widthPt: 612, heightPt: 792 }),
    {
      ocr: {
        adapter: "tesseract.js",
        results: [
          {
            pageIndex: 0,
            language: "eng",
            coordinateSpace: "page",
            lines: [
              {
                text: "Equation Scan Fixture",
                confidence: 93,
                x: 72,
                y: 720,
                width: 210,
                height: 22
              },
              {
                text: "A short lead-in.",
                confidence: 91,
                x: 72,
                y: 690,
                width: 120,
                height: 12
              },
              {
                text: "E = m c^2",
                confidence: 42,
                x: 168,
                y: 660,
                width: 170,
                height: 12
              },
              {
                text: "After the equation.",
                confidence: 94,
                x: 72,
                y: 620,
                width: 130,
                height: 12
              }
            ]
          }
        ]
      },
      equations: {
        imageFallbackConfidence: 0.75,
        formulaOcr: {
          results: [
            {
              equationIndex: 0,
              latex: "E = mc^{2}",
              confidence: 88
            }
          ]
        }
      }
    }
  );

  assert.equal(
    result.markdown,
    "# Equation Scan Fixture\n\nA short lead-in.\n\n$$\nE = mc^{2}\n$$\n\nAfter the equation.\n"
  );
  assert.deepEqual(result.assets, []);
  assert.ok(
    !result.warnings.some((warning) => warning.code === warningCodes.EquationLowOcrConfidence)
  );
  assert.deepEqual(result.diagnostics.extraction.equations, {
    total: 1,
    unicodeEquations: 0,
    textEquations: 1,
    imageEquations: 0,
    formulaOcr: {
      enabled: true,
      status: "selected"
    },
    equations: [
      {
        equationIndex: 0,
        pageIndex: 0,
        source: "ocr",
        text: "E = m c^2",
        latex: "E = mc^{2}",
        lineCount: 1,
        containsUnicodeMath: false,
        x: 168,
        y: 660,
        width: 170,
        height: 12,
        formulaOcrSource: "options.equations.formulaOcr.results",
        formulaOcrConfidence: 0.88
      }
    ]
  });
  assert.deepEqual(
    result.ir.pages[0].elements.find((element) => element.type === "equation"),
    {
      type: "equation",
      text: "E = m c^2",
      latex: "E = mc^{2}",
      x: 168,
      y: 660,
      width: 170,
      height: 12
    }
  );
});

test("convertPdfToMarkdown reports figure caption layout regions", async () => {
  const result = await convertPdfToMarkdown(vectorFigureFixturePath.pathname);
  const page = result.diagnostics.extraction.layout.pages[0];

  assert.equal(page.captions.length, 1);
  assert.equal(page.captions[0].kind, "caption");
  assert.equal(page.captions[0].target, "figure");
  assert.equal(
    result.markdown,
    "# Vector Figure Fixture\n\n![Figure 1](assets/synthetic-vector-figure-page-1-figure-1.png)\n\nFigure 1. A generated vector box.\n"
  );
  assert.deepEqual(result.assets, [
    {
      id: "synthetic-vector-figure-page-1-figure-1",
      kind: "figure-preview",
      path: "assets/synthetic-vector-figure-page-1-figure-1.png",
      mediaType: "image/png",
      pageIndex: 0
    }
  ]);
  assert.deepEqual(result.ir.pages[0].elements, [
    {
      type: "figure",
      caption: "Figure 1. A generated vector box.",
      assetId: "synthetic-vector-figure-page-1-figure-1",
      x: 120,
      y: 520,
      width: 240,
      height: 120
    }
  ]);
  assert.deepEqual(result.diagnostics.extraction.figures, {
    total: 1,
    vectorFigures: 1,
    imageFigures: 0,
    figures: [
      {
        figureIndex: 0,
        pageIndex: 0,
        figureNumber: 1,
        captionNumber: "1",
        caption: "Figure 1. A generated vector box.",
        assetId: "synthetic-vector-figure-page-1-figure-1",
        assetPath: "assets/synthetic-vector-figure-page-1-figure-1.png",
        assetMediaType: "image/png",
        kind: "vector",
        x: 120,
        y: 520,
        width: 240,
        height: 120,
        visualElements: 4,
        pageWidthPt: 612,
        pageHeightPt: 792
      }
    ]
  });
  assert.deepEqual(
    result.warnings.find((warning) => warning.code === warningCodes.FigureLowSemanticContent),
    {
      code: warningCodes.FigureLowSemanticContent,
      message: "Figure was preserved as a visual asset; semantic chart or diagram data was not inferred.",
      details: {
        figureIndex: 0,
        pageIndex: 0,
        assetId: "synthetic-vector-figure-page-1-figure-1",
        kind: "vector",
        caption: "Figure 1. A generated vector box.",
        reason: "visual-preview-only"
      }
    }
  );
  const figureSource = result.sourceMap.entries.find((entry) => entry.kind === "figure");
  assert.deepEqual(figureSource, {
    markdownStart: 25,
    markdownEnd: 88,
    kind: "figure",
    regions: [
      {
        pageIndex: 0,
        x: 120,
        y: 520,
        width: 240,
        height: 120,
        source: "pdf-vector"
      }
    ]
  });
});

test("convertPdfToMarkdown preserves tagged figure alt text", async () => {
  const result = await convertPdfToMarkdown(createTaggedFigureAltPdf());

  assert.equal(
    result.markdown,
    "# Tagged Figure Alt Fixture\n\n![Flow diagram showing intake and review](assets/document-page-1-figure-1.png)\n\nFigure 1. Flow diagram.\n"
  );
  assert.deepEqual(result.assets, [
    {
      id: "document-page-1-figure-1",
      kind: "figure-preview",
      path: "assets/document-page-1-figure-1.png",
      mediaType: "image/png",
      pageIndex: 0,
      altText: "Flow diagram showing intake and review",
      altTextSource: "tagged-pdf"
    }
  ]);
  assert.deepEqual(result.ir.pages[0].elements, [
    {
      type: "figure",
      caption: "Figure 1. Flow diagram.",
      assetId: "document-page-1-figure-1",
      altText: "Flow diagram showing intake and review",
      altTextSource: "tagged-pdf",
      x: 120,
      y: 520,
      width: 240,
      height: 120
    }
  ]);
  assert.deepEqual(result.diagnostics.extraction.figures.figures[0], {
    figureIndex: 0,
    pageIndex: 0,
    figureNumber: 1,
    captionNumber: "1",
    caption: "Figure 1. Flow diagram.",
    assetId: "document-page-1-figure-1",
    assetPath: "assets/document-page-1-figure-1.png",
    assetMediaType: "image/png",
    kind: "vector",
    x: 120,
    y: 520,
    width: 240,
    height: 120,
    visualElements: 4,
    pageWidthPt: 612,
    pageHeightPt: 792,
    altText: "Flow diagram showing intake and review",
    altTextSource: "tagged-pdf"
  });
});

test("convertPdfToMarkdown extracts form, annotation, attachment, and signature metadata", async () => {
  const result = await convertPdfToMarkdown(createInteractiveDocumentPdf(), {
    attachments: {
      extract: true
    }
  });

  assert.match(result.markdown, /^# Interactive Document Fixture/);
  assert.equal(result.diagnostics.extraction.forms.present, true);
  assert.equal(result.diagnostics.extraction.forms.total, 4);
  assert.equal(result.diagnostics.extraction.forms.filled, 3);
  assert.equal(result.diagnostics.extraction.forms.checkboxes, 1);
  assert.equal(result.diagnostics.extraction.forms.radioButtons, 1);
  assert.deepEqual(result.diagnostics.extraction.forms.xfa, {
    present: true,
    status: "unsupported",
    reason: "XFA packets are detected but not parsed."
  });

  const fields = Object.fromEntries(
    result.diagnostics.extraction.forms.fields.map((field) => [field.name, field])
  );
  assert.deepEqual(pickFormField(fields.full_name), {
    name: "full_name",
    label: "Full name",
    fieldType: "text",
    rawFieldType: "Tx",
    value: "Ada Lovelace",
    valueSource: "V",
    pageIndex: 0,
    x: 72,
    y: 650,
    width: 228,
    height: 20
  });
  assert.deepEqual(pickFormField(fields.subscribe), {
    name: "subscribe",
    label: "Subscribe to updates",
    fieldType: "button",
    rawFieldType: "Btn",
    value: "Yes",
    valueSource: "V",
    pageIndex: 0,
    x: 72,
    y: 610,
    width: 20,
    height: 20,
    buttonType: "checkbox",
    state: "Yes",
    checked: true
  });
  assert.deepEqual(pickFormField(fields.plan), {
    name: "plan",
    label: "Plan choice",
    fieldType: "button",
    rawFieldType: "Btn",
    value: "pro",
    valueSource: "V",
    pageIndex: 0,
    x: 72,
    y: 570,
    width: 20,
    height: 20,
    buttonType: "radio",
    state: "pro",
    selectedValue: "pro"
  });

  assert.equal(fields.approval_signature.fieldType, "signature");
  assert.equal(fields.approval_signature.value, null);
  assert.equal(fields.approval_signature.signature.name, "Signer One");
  assert.equal(fields.approval_signature.signature.reason, "Approved");
  assert.deepEqual(result.diagnostics.extraction.signatures, {
    total: 1,
    validationStatus: "not-validated",
    signatures: [
      {
        signatureIndex: 0,
        fieldName: "approval_signature",
        label: "Approval signature",
        objectNumber: 11,
        generationNumber: 0,
        pageIndex: 0,
        validationStatus: "not-validated",
        valueObjectNumber: 15,
        valueGenerationNumber: 0,
        filter: "Adobe.PPKLite",
        subFilter: "adbe.pkcs7.detached",
        name: "Signer One",
        reason: "Approved",
        date: "D:20260702000000+02'00'",
        byteRange: null
      }
    ]
  });

  assert.deepEqual(result.diagnostics.extraction.annotations, {
    total: 2,
    links: 1,
    texts: 1,
    annotations: [
      {
        annotationIndex: 0,
        pageIndex: 0,
        objectNumber: 9,
        generationNumber: 0,
        subtype: "Link",
        uri: "https://example.com/form",
        actionType: "URI",
        x: 72,
        y: 520,
        width: 160,
        height: 20
      },
      {
        annotationIndex: 1,
        pageIndex: 0,
        objectNumber: 10,
        generationNumber: 0,
        subtype: "Text",
        contents: "Reviewer note",
        title: "QA",
        x: 72,
        y: 480,
        width: 20,
        height: 20
      }
    ],
    pages: [
      {
        pageIndex: 0,
        total: 2,
        links: 1,
        texts: 1
      }
    ]
  });

  assert.deepEqual(result.diagnostics.extraction.attachments, {
    total: 1,
    extractedSidecars: 1,
    files: [
      {
        attachmentIndex: 0,
        name: "report.txt",
        fileName: "report.txt",
        description: "Report attachment",
        objectNumber: 12,
        generationNumber: 0,
        embeddedFileObjectNumber: 16,
        embeddedFileGenerationNumber: 0,
        size: 16,
        mediaType: "text/plain",
        assetId: "attachment-1-report-txt",
        assetPath: "assets/attachments/report.txt",
        extracted: true
      }
    ]
  });
  assert.deepEqual(result.assets, [
    {
      id: "attachment-1-report-txt",
      kind: "attachment",
      path: "assets/attachments/report.txt",
      mediaType: "text/plain",
      content: "YXR0YWNoZWQgcmVwb3J0Cg==",
      encoding: "base64",
      pageIndex: null
    }
  ]);
  assert.deepEqual(result.ir.pages[0].elements, [
    {
      type: "form-field",
      name: "full_name",
      label: "Full name",
      value: "Ada Lovelace",
      fieldType: "text",
      x: 72,
      y: 650,
      width: 228,
      height: 20
    },
    {
      type: "form-field",
      name: "subscribe",
      label: "Subscribe to updates",
      value: "Yes",
      fieldType: "button",
      buttonType: "checkbox",
      checked: true,
      x: 72,
      y: 610,
      width: 20,
      height: 20
    },
    {
      type: "form-field",
      name: "plan",
      label: "Plan choice",
      value: "pro",
      fieldType: "button",
      buttonType: "radio",
      selectedValue: "pro",
      x: 72,
      y: 570,
      width: 20,
      height: 20
    },
    {
      type: "form-field",
      name: "approval_signature",
      label: "Approval signature",
      fieldType: "signature",
      x: 72,
      y: 440,
      width: 228,
      height: 30
    },
    {
      type: "annotation",
      subtype: "Link",
      contents: "https://example.com/form",
      uri: "https://example.com/form",
      x: 72,
      y: 520,
      width: 160,
      height: 20
    },
    {
      type: "annotation",
      subtype: "Text",
      contents: "Reviewer note",
      x: 72,
      y: 480,
      width: 20,
      height: 20
    }
  ]);
});

test("convertPdfToMarkdown reports visible table ruling-line diagnostics", async () => {
  const result = await convertPdfToMarkdown(visibleTableFixturePath.pathname);
  const rulingLines = result.diagnostics.extraction.rulingLines;
  const rulingGrids = result.diagnostics.extraction.rulingGrids;
  const rulingTables = result.diagnostics.extraction.rulingTables;

  assert.equal(result.confidence.tables, 0.95);
  assert.ok(!result.warnings.some((warning) => warning.code === warningCodes.TableLowConfidence));
  assert.deepEqual(result.diagnostics.extraction.lowConfidenceTables, []);
  assert.deepEqual(result.diagnostics.extraction.tables, [
    {
      tableIndex: 0,
      source: "ruling-grid",
      pageIndex: 0,
      rows: 3,
      columns: 3,
      output: "gfm",
      confidence: 0.95,
      hasSpans: false,
      numericColumns: [1, 2],
      sourceLines: 9
    }
  ]);
  assert.deepEqual(result.assets, [
    {
      id: "table-page-1-1-csv",
      kind: "table-csv",
      path: "assets/table-page-1-1-csv.csv",
      mediaType: "text/csv",
      content: "Quarter,Revenue,Cost\nQ1,100,50\nQ2,120,60\n",
      pageIndex: 0,
      tableIndex: 0
    }
  ]);
  assert.deepEqual(result.ir.assets, result.assets);
  assert.equal(rulingLines.total, 8);
  assert.equal(rulingLines.horizontal, 4);
  assert.equal(rulingLines.vertical, 4);
  assert.deepEqual(rulingLines.pages, [
    {
      pageIndex: 0,
      total: 8,
      horizontal: 4,
      vertical: 4
    }
  ]);
  assert.equal(rulingGrids.total, 1);
  assert.equal(rulingGrids.complete, 1);
  assert.deepEqual(rulingGrids.pages, [
    {
      pageIndex: 0,
      total: 1,
      complete: 1,
      grids: [
        {
          rows: 3,
          columns: 3,
          cells: 9,
          x1: 72,
          y1: 610,
          x2: 432,
          y2: 700,
          complete: true
        }
      ]
    }
  ]);
  assert.equal(rulingTables.total, 1);
  assert.equal(rulingTables.assignedTextLines, 9);
  assert.equal(rulingTables.nonEmptyCells, 9);
  assert.equal(rulingTables.rowSpans, 0);
  assert.equal(rulingTables.columnSpans, 0);
  assert.equal(rulingTables.coveredCells, 0);
  assert.equal(rulingTables.csvSidecars, 1);
  assert.deepEqual(rulingTables.pages, [
    {
      pageIndex: 0,
      total: 1,
      assignedTextLines: 9,
      nonEmptyCells: 9,
      rowSpans: 0,
      columnSpans: 0,
      coveredCells: 0,
      csvSidecars: 1,
      tables: [
        {
          rows: 3,
          columns: 3,
          assignedTextLines: 9,
          nonEmptyCells: 9,
          rowSpans: 0,
          columnSpans: 0,
          coveredCells: 0,
          hasSpans: false,
          csvSidecarAssetId: "table-page-1-1-csv",
          cells: [
            { rowIndex: 0, columnIndex: 0, text: "Quarter", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 0, columnIndex: 1, text: "Revenue", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 0, columnIndex: 2, text: "Cost", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 1, columnIndex: 0, text: "Q1", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 1, columnIndex: 1, text: "100", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 1, columnIndex: 2, text: "50", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 2, columnIndex: 0, text: "Q2", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 2, columnIndex: 1, text: "120", lineCount: 1, rowSpan: 1, columnSpan: 1 },
            { rowIndex: 2, columnIndex: 2, text: "60", lineCount: 1, rowSpan: 1, columnSpan: 1 }
          ]
        }
      ]
    }
  ]);
});

test("convertPdfToMarkdown warns and preserves low-confidence table candidates as text", async () => {
  const result = await convertPdfToMarkdown(
    createSinglePageTextPdf([
      textOperation(72, 720, 22, "Ambiguous Rows"),
      textOperation(72, 670, 12, "Name"),
      textOperation(220, 670, 12, "Status"),
      textOperation(72, 650, 12, "Alpha"),
      textOperation(220, 650, 12, "Active"),
      textOperation(72, 630, 12, "Beta"),
      textOperation(220, 630, 12, "Pending")
    ])
  );
  const warning = result.warnings.find(
    (item) => item.code === warningCodes.TableLowConfidence
  );

  assert.equal(
    result.markdown,
    "# Ambiguous Rows\n\nName\n\nStatus\n\nAlpha\n\nActive\n\nBeta\n\nPending\n"
  );
  assert.deepEqual(result.diagnostics.extraction.tables, []);
  assert.deepEqual(result.diagnostics.extraction.lowConfidenceTables, [
    {
      tableIndex: 0,
      source: "borderless-heuristic",
      pageIndex: 0,
      rows: 3,
      columns: 2,
      confidence: 0.45,
      reason: "no-numeric-body-column",
      sourceLines: 6
    }
  ]);
  assert.ok(warning);
  assert.equal(warning.details.reason, "no-numeric-body-column");
  assert.equal(warning.details.confidence, 0.45);
});

test("convertPdfToMarkdown can disable table CSV sidecars", async () => {
  const result = await convertPdfToMarkdown(visibleTableFixturePath.pathname, {
    tables: { csvSidecars: false }
  });

  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.ir.assets, []);
  assert.equal(result.diagnostics.options.tableCsvSidecars, false);
  assert.equal(result.diagnostics.extraction.rulingTables.csvSidecars, 0);
  assert.equal(
    result.diagnostics.extraction.rulingTables.pages[0].tables[0].csvSidecarAssetId,
    null
  );
});

test("text MVP matches expected markdown for simple generated fixtures", async () => {
  const cases = [
    "synthetic-simple-text",
    "synthetic-headings-lists"
  ];

  for (const id of cases) {
    const pdf = new URL(`../../../corpus/generated/${id}.pdf`, import.meta.url);
    const expected = await readFile(new URL(`../../../corpus/expected/${id}.md`, import.meta.url), "utf8");
    const result = await convertPdfToMarkdown(pdf.pathname);
    assert.equal(result.markdown, expected);
  }
});

function pdfString(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function textOperation(x, y, size, value) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET`;
}

function invisibleTextOperation(x, y, size, value) {
  return `BT /F1 ${size} Tf 3 Tr ${x} ${y} Td (${pdfString(value)}) Tj ET`;
}

function streamObject(content, dictionary = "") {
  const bytes = Buffer.from(content, "binary");
  const prefix = dictionary ? `${dictionary} ` : "";
  return `<< ${prefix}/Length ${bytes.byteLength} >>\nstream\n${bytes.toString("binary")}\nendstream`;
}

function createSinglePageTextPdf(operations) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    streamObject(`${operations.join("\n")}\n`)
  ];
  return createPdf(objects);
}

function createSinglePageImagePdf({ x, y, widthPt, heightPt, rotation = 0, textOperations = [] }) {
  const operations = [
    `q ${widthPt} 0 0 ${heightPt} ${x} ${y} cm /ImScan Do Q`,
    ...textOperations
  ];
  const rotationEntry = rotation ? `/Rotate ${rotation} ` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${rotationEntry}/Resources << /Font << /F1 3 0 R >> /XObject << /ImScan 6 0 R >> >> /Contents 5 0 R >>`,
    streamObject(`${operations.join("\n")}\n`),
    streamObject(
      "abc",
      "/Type /XObject /Subtype /Image /Width 2550 /Height 3300 /ColorSpace /DeviceRGB /BitsPerComponent 8"
    )
  ];
  return createPdf(objects);
}

function createTaggedFigureAltPdf() {
  const operations = [
    textOperation(72, 740, 20, "Tagged Figure Alt Fixture"),
    "/Figure << /MCID 0 >> BDC",
    "120 520 240 120 re S",
    "EMC",
    textOperation(120, 480, 12, "Figure 1. Flow diagram.")
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /StructParents 0 >>",
    streamObject(`${operations.join("\n")}\n`),
    "<< /Type /StructTreeRoot /K 7 0 R >>",
    "<< /Type /StructElem /S /Document /K 8 0 R >>",
    "<< /Type /StructElem /S /Figure /P 7 0 R /Alt (Flow diagram showing intake and review) /K << /Type /MCR /Pg 4 0 R /MCID 0 >> >>"
  ];
  return createPdf(objects);
}

function createInteractiveDocumentPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R /Names << /EmbeddedFiles << /Names [(report.txt) 12 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R 8 0 R 14 0 R 9 0 R 10 0 R 11 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    streamObject(`${textOperation(72, 720, 22, "Interactive Document Fixture")}\n`),
    "<< /Fields [7 0 R 8 0 R 14 0 R 11 0 R] /XFA (xfa packet) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (full_name) /TU (Full name) /V (Ada Lovelace) /Rect [72 650 300 670] /P 3 0 R >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (subscribe) /TU (Subscribe to updates) /V /Yes /AS /Yes /Rect [72 610 92 630] /P 3 0 R >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 520 232 540] /A << /S /URI /URI (https://example.com/form) >> >>",
    "<< /Type /Annot /Subtype /Text /Rect [72 480 92 500] /T (QA) /Contents (Reviewer note) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Sig /T (approval_signature) /TU (Approval signature) /V 15 0 R /Rect [72 440 300 470] /P 3 0 R >>",
    "<< /Type /Filespec /F (report.txt) /UF (report.txt) /Desc (Report attachment) /EF << /F 16 0 R >> >>",
    "(xfa packet)",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 32768 /T (plan) /TU (Plan choice) /V /pro /AS /pro /Rect [72 570 92 590] /P 3 0 R >>",
    "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Signer One) /Reason (Approved) /M (D:20260702000000+02'00') >>",
    streamObject("attached report\n", "/Type /EmbeddedFile /Subtype /text#2Fplain /Params << /Size 16 >>")
  ];
  return createPdf(objects);
}

function createPdf(objects) {
  let body = "%PDF-1.4\n% pdf-2-llm test fixture\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(body, "binary");
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f\n";
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n\n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, "binary");
}

function pickFormField(field) {
  return {
    name: field.name,
    label: field.label,
    fieldType: field.fieldType,
    rawFieldType: field.rawFieldType,
    value: field.value,
    valueSource: field.valueSource,
    pageIndex: field.pageIndex,
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height,
    ...(field.buttonType ? { buttonType: field.buttonType } : {}),
    ...(field.state ? { state: field.state } : {}),
    ...(field.checked !== undefined ? { checked: field.checked } : {}),
    ...(field.selectedValue ? { selectedValue: field.selectedValue } : {})
  };
}

function pickRasterFixtureFields(page) {
  return {
    sourceBox: page.sourceBox,
    boxPt: page.boxPt,
    sourceWidthPt: page.sourceWidthPt,
    sourceHeightPt: page.sourceHeightPt,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    widthPx: page.widthPx,
    heightPx: page.heightPx,
    rotation: page.rotation,
    quarterTurn: page.quarterTurn,
    thumbnail: {
      widthPx: page.thumbnail.widthPx,
      heightPx: page.thumbnail.heightPx
    }
  };
}

test("table MVP matches expected markdown for generated table fixtures", async () => {
  const cases = [
    "synthetic-visible-table",
    "synthetic-split-across-page-table",
    "synthetic-table-with-note",
    "synthetic-complex-spanned-table",
    "synthetic-borderless-table"
  ];

  for (const id of cases) {
    const pdf = new URL(`../../../corpus/generated/${id}.pdf`, import.meta.url);
    const expected = await readFile(new URL(`../../../corpus/expected/${id}.md`, import.meta.url), "utf8");
    const result = await convertPdfToMarkdown(pdf.pathname);
    assert.equal(result.markdown, expected);
  }
});

test("layout MVP matches expected markdown for generated layout fixtures", async () => {
  const cases = [
    "synthetic-two-column",
    "synthetic-header-footer",
    "synthetic-footnote"
  ];

  for (const id of cases) {
    const pdf = new URL(`../../../corpus/generated/${id}.pdf`, import.meta.url);
    const expected = await readFile(new URL(`../../../corpus/expected/${id}.md`, import.meta.url), "utf8");
    const result = await convertPdfToMarkdown(pdf.pathname);
    assert.equal(result.markdown, expected);
  }
});
