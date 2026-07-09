import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProviderResults,
  createAcceptedOutputHash,
  createMemoryProfileSummary,
  createThroughputProfileSummary,
  evaluateMemoryLimits,
  splitStartupAndThroughputDurations,
  summarizeDurations,
  summarizeGpuMemoryFromExecution,
  summarizePeakMemory,
  summarizeMemory
} from "../../../scripts/qa/benchmark.mjs";
import { createStartupProfile } from "../../../scripts/qa/startup-benchmark.mjs";
import {
  assertPackageIdentity,
  createPackageSizeReport,
  evaluatePackageSizeBudget,
  findForbiddenPackageFiles
} from "../../../scripts/qa/check-package-size.mjs";
import {
  createModelSizeReport,
  evaluateModelSizeBudget
} from "../../../scripts/qa/check-model-size.mjs";
import {
  createPerformanceRegressionReport,
  evaluatePerformanceRegression,
  findPerformanceInputSelfComparisons
} from "../../../scripts/qa/check-performance-regression.mjs";
import {
  createWasmSizeReport,
  evaluateWasmSizeBudget
} from "../../../scripts/qa/check-wasm-size.mjs";

test("benchmark duration summary reports min max mean and median", () => {
  assert.deepEqual(summarizeDurations([9, 1, 5, 3]), {
    minMs: 1,
    maxMs: 9,
    meanMs: 4.5,
    medianMs: 4
  });
});

test("benchmark throughput profile summarizes selected text cases", () => {
  assert.deepEqual(
    createThroughputProfileSummary(
      [
        {
          id: "text-a",
          gate: "text-mvp",
          kind: "synthetic",
          features: ["born-digital"],
          workload: "conversion",
          providerMode: "cpu",
          pages: 2,
          bytes: 1000,
          outputChars: 500,
          textLines: 10,
          iterations: 3,
          warmup: 1,
          startup: { durationMs: 20 },
          throughput: {
            iterations: 2,
            meanMs: 10,
            medianMs: 10,
            pagesPerSecond: 200
          },
          passed: true
        },
        {
          id: "text-b",
          gate: "text-mvp",
          kind: "synthetic",
          features: ["born-digital"],
          workload: "conversion",
          providerMode: "cpu",
          pages: 1,
          bytes: 300,
          outputChars: 100,
          textLines: 4,
          iterations: 3,
          warmup: 1,
          startup: { durationMs: 12 },
          throughput: {
            iterations: 2,
            meanMs: 20,
            medianMs: 20,
            pagesPerSecond: 50
          },
          passed: true
        }
      ],
      { profileType: "text-throughput", scope: "gate:text-mvp" }
    ),
    {
      profileType: "text-throughput",
      scope: "gate:text-mvp",
      resultCount: 2,
      passed: true,
      totals: {
        pages: 3,
        bytes: 1300,
        outputChars: 600,
        textLines: 14
      },
      rates: {
        pagesPerSecond: {
          min: 50,
          max: 200,
          mean: 125,
          median: 125
        },
        outputCharsPerSecond: {
          min: 5000,
          max: 50000,
          mean: 27500,
          median: 27500
        },
        inputBytesPerSecond: {
          min: 15000,
          max: 100000,
          mean: 57500,
          median: 57500
        }
      },
      cases: [
        {
          id: "text-a",
          gate: "text-mvp",
          kind: "synthetic",
          features: ["born-digital"],
          workload: "conversion",
          providerMode: "cpu",
          pages: 2,
          bytes: 1000,
          outputChars: 500,
          textLines: 10,
          iterations: 3,
          warmup: 1,
          startupMs: 20,
          throughputIterations: 2,
          throughputMeanMs: 10,
          throughputMedianMs: 10,
          pagesPerSecond: 200,
          outputCharsPerSecond: 50000,
          inputBytesPerSecond: 100000,
          passed: true
        },
        {
          id: "text-b",
          gate: "text-mvp",
          kind: "synthetic",
          features: ["born-digital"],
          workload: "conversion",
          providerMode: "cpu",
          pages: 1,
          bytes: 300,
          outputChars: 100,
          textLines: 4,
          iterations: 3,
          warmup: 1,
          startupMs: 12,
          throughputIterations: 2,
          throughputMeanMs: 20,
          throughputMedianMs: 20,
          pagesPerSecond: 50,
          outputCharsPerSecond: 5000,
          inputBytesPerSecond: 15000,
          passed: true
        }
      ]
    }
  );
});

test("startup profile summarizes browser and Node entrypoint startup", () => {
  assert.deepEqual(
    createStartupProfile(
      [
        {
          id: "node-entrypoint",
          runtime: "node",
          entrypoint: "packages/pdf2md/src/node.mjs",
          executionEnvironment: "node-esm-fresh-process",
          iterations: 2,
          warmup: 1,
          outputChars: 100,
          textLines: 3,
          passed: true,
          samples: [
            { importMs: 4, firstConversionMs: 20, totalStartupMs: 24 },
            { importMs: 6, firstConversionMs: 16, totalStartupMs: 22 }
          ]
        },
        {
          id: "browser-entrypoint",
          runtime: "browser",
          entrypoint: "packages/pdf2md/src/browser.mjs",
          executionEnvironment: "node-esm-fresh-process",
          iterations: 2,
          warmup: 1,
          outputChars: 100,
          textLines: 3,
          passed: true,
          samples: [
            { importMs: 8, firstConversionMs: 21, totalStartupMs: 29 },
            { importMs: 10, firstConversionMs: 19, totalStartupMs: 31 }
          ]
        }
      ],
      { scope: "entrypoints" }
    ),
    {
      profileType: "entrypoint-startup",
      scope: "entrypoints",
      resultCount: 2,
      passed: true,
      totals: {
        outputChars: 200,
        textLines: 6
      },
      cases: [
        {
          id: "node-entrypoint",
          runtime: "node",
          entrypoint: "packages/pdf2md/src/node.mjs",
          executionEnvironment: "node-esm-fresh-process",
          iterations: 2,
          warmup: 1,
          importMs: {
            minMs: 4,
            maxMs: 6,
            meanMs: 5,
            medianMs: 5
          },
          firstConversionMs: {
            minMs: 16,
            maxMs: 20,
            meanMs: 18,
            medianMs: 18
          },
          totalStartupMs: {
            minMs: 22,
            maxMs: 24,
            meanMs: 23,
            medianMs: 23
          },
          outputChars: 100,
          textLines: 3,
          passed: true
        },
        {
          id: "browser-entrypoint",
          runtime: "browser",
          entrypoint: "packages/pdf2md/src/browser.mjs",
          executionEnvironment: "node-esm-fresh-process",
          iterations: 2,
          warmup: 1,
          importMs: {
            minMs: 8,
            maxMs: 10,
            meanMs: 9,
            medianMs: 9
          },
          firstConversionMs: {
            minMs: 19,
            maxMs: 21,
            meanMs: 20,
            medianMs: 20
          },
          totalStartupMs: {
            minMs: 29,
            maxMs: 31,
            meanMs: 30,
            medianMs: 30
          },
          outputChars: 100,
          textLines: 3,
          passed: true
        }
      ]
    }
  );
});

test("package size report evaluates packed size budgets", () => {
  const packageInfo = {
    id: "@scope/pkg@1.0.0",
    name: "@scope/pkg",
    version: "1.0.0",
    filename: "scope-pkg-1.0.0.tgz",
    size: 900,
    unpackedSize: 1800,
    entryCount: 3,
    files: [
      { path: "src/index.mjs", size: 1000 },
      { path: "src/worker.mjs", size: 500 },
      { path: "package.json", size: 300 }
    ]
  };
  const budget = {
    maxPackedBytes: 1000,
    maxUnpackedBytes: 1500,
    maxEntryCount: 4
  };

  assert.deepEqual(evaluatePackageSizeBudget(packageInfo, budget), [
    {
      metric: "maxUnpackedBytes",
      actualMetric: "unpackedBytes",
      actual: 1800,
      limit: 1500
    }
  ]);

  const report = createPackageSizeReport(packageInfo, { budget });
  assert.equal(report.passed, false);
  assert.deepEqual(report.budget, budget);
  assert.deepEqual(report.package, {
    id: "@scope/pkg@1.0.0",
    name: "@scope/pkg",
    version: "1.0.0",
    filename: "scope-pkg-1.0.0.tgz",
    packedBytes: 900,
    unpackedBytes: 1800,
    entryCount: 3
  });
  assert.deepEqual(report.largestFiles, [
    { path: "src/index.mjs", bytes: 1000 },
    { path: "src/worker.mjs", bytes: 500 },
    { path: "package.json", bytes: 300 }
  ]);
});

test("package size report rejects repository-only package paths", () => {
  const packageInfo = {
    id: "pdf-2-llm@1.0.0",
    name: "pdf-2-llm",
    version: "1.0.0",
    filename: "pdf-2-llm-1.0.0.tgz",
    size: 1000,
    unpackedSize: 2000,
    entryCount: 4,
    files: [
      { path: ".symphony/workflow.md", size: 100 },
      { path: "docs/index.md", size: 200 },
      { path: "packages/pdf2md/src/index.mjs", size: 300 },
      { path: "package.json", size: 400 }
    ]
  };
  const budget = {
    maxPackedBytes: 2000,
    maxUnpackedBytes: 3000,
    maxEntryCount: 8
  };

  assert.deepEqual(findForbiddenPackageFiles(packageInfo), [
    ".symphony/workflow.md",
    "docs/index.md"
  ]);

  const report = createPackageSizeReport(packageInfo, { budget });
  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.forbiddenPathPrefixes, ["docs/", ".symphony/"]);
  assert.deepEqual(report.forbiddenFiles, [".symphony/workflow.md", "docs/index.md"]);
});

test("package size report pins the public package identity", () => {
  assert.doesNotThrow(() => assertPackageIdentity({ name: "pdf-2-llm" }, "pdf-2-llm"));
  assert.throws(
    () => assertPackageIdentity({ name: "@pdf-2-llm/pdf2md" }, "pdf-2-llm"),
    /measured @pdf-2-llm\/pdf2md; expected pdf-2-llm/
  );
});

test("WASM size report evaluates artifact byte budgets", () => {
  const wasmInfo = {
    path: "packages/pdf2md/src/wasm/pdf2md_core.wasm",
    bytes: 270000
  };
  const budget = {
    maxBytes: 262144
  };

  assert.deepEqual(evaluateWasmSizeBudget(wasmInfo, budget), [
    {
      metric: "maxBytes",
      actualMetric: "bytes",
      actual: 270000,
      limit: 262144
    }
  ]);

  const report = createWasmSizeReport(wasmInfo, { budget });
  assert.equal(report.passed, false);
  assert.deepEqual(report.wasm, wasmInfo);
  assert.deepEqual(report.budget, budget);
});

test("model size report evaluates bundled and lazy model budgets", () => {
  const report = createModelSizeReport(
    {
      packageInfo: {
        id: "@scope/pkg@1.0.0",
        name: "@scope/pkg",
        version: "1.0.0",
        filename: "scope-pkg-1.0.0.tgz",
        files: [
          { path: "src/index.mjs", size: 500 },
          { path: "src/models/layout.onnx", size: 2048 },
          { path: "src/models/readme.txt", size: 50 }
        ]
      },
      repositoryModelFiles: [
        { path: "models/ocr/eng.traineddata", bytes: 1024 },
        { path: "models/ocr/jpn.traineddata", bytes: 2048 }
      ],
      declaredLazyModelFiles: [
        {
          path: "eng.traineddata",
          bytes: null,
          sources: ["corpus/reports/ocr-throughput-benchmark.json"]
        },
        {
          path: "jpn.traineddata",
          bytes: null,
          sources: ["corpus/reports/ocr-throughput-benchmark.json"]
        }
      ],
      modelRoots: ["models"],
      benchmarkReports: ["corpus/reports/ocr-throughput-benchmark.json"]
    },
    {
      budget: {
        maxPackagedModelBytes: 1024,
        maxPackagedModelFiles: 1,
        maxRepositoryModelBytes: 4096,
        maxRepositoryModelFiles: 2,
        maxDeclaredLazyModelFiles: 1
      }
    }
  );

  assert.equal(report.package.packagedModelBytes, 2048);
  assert.equal(report.package.packagedModelFileCount, 1);
  assert.deepEqual(report.package.modelFiles, [{ path: "src/models/layout.onnx", bytes: 2048 }]);
  assert.equal(report.repository.modelBytes, 3072);
  assert.equal(report.repository.modelFileCount, 2);
  assert.equal(report.declaredLazyModels.count, 2);
  assert.deepEqual(evaluateModelSizeBudget(report, report.budget), [
    {
      metric: "maxPackagedModelBytes",
      actualMetric: "packagedModelBytes",
      actual: 2048,
      limit: 1024
    },
    {
      metric: "maxDeclaredLazyModelFiles",
      actualMetric: "declaredLazyModelFileCount",
      actual: 2,
      limit: 1
    }
  ]);
  assert.equal(report.passed, false);
});

test("performance regression report evaluates throughput startup and memory budgets", () => {
  const currentReports = {
    text: throughputReport("text-throughput", "text-a", 1),
    ocr: throughputReport("ocr-throughput", "ocr-a", 40),
    startup: startupReport("node-entrypoint", 90),
    memory: memoryReport("manual-a", 120)
  };
  const baselineReports = {
    text: throughputReport("text-throughput", "text-a", 100),
    ocr: throughputReport("ocr-throughput", "ocr-a", 100),
    startup: startupReport("node-entrypoint", 10),
    memory: memoryReport("manual-a", 100)
  };
  const budget = {
    minPagesPerSecondRatio: 0.2,
    minPagesPerSecond: 5,
    maxStartupMeanRatio: 5,
    maxStartupMeanMs: 100,
    maxMemoryPeakDeltaRatio: 2,
    maxMemoryPeakDeltaBytes: 300
  };

  const checks = evaluatePerformanceRegression({ currentReports, baselineReports }, budget);
  assert.deepEqual(
    checks.filter((check) => !check.passed).map((check) => ({
      profile: check.profile,
      id: check.id,
      metric: check.metric,
      actual: check.actual,
      threshold: check.threshold
    })),
    [
      {
        profile: "text-throughput",
        id: "text-a",
        metric: "pagesPerSecond",
        actual: 1,
        threshold: 20
      },
      {
        profile: "entrypoint-startup",
        id: "node-entrypoint",
        metric: "totalStartupMeanMs",
        actual: 90,
        threshold: 50
      }
    ]
  );

  const report = createPerformanceRegressionReport(
    { currentReports, baselineReports, inputs: { currentText: "current.json" } },
    { budget }
  );
  assert.equal(report.passed, false);
  assert.equal(report.violations.length, 2);
  assert.equal(report.inputs.currentText, "current.json");
});

test("performance regression inputs reject current report self-comparisons", () => {
  assert.deepEqual(
    findPerformanceInputSelfComparisons(
      {
        currentText: ".temp/qa/text.json",
        baselineText: "corpus/reports/text.json",
        currentOcr: "corpus/reports/ocr.json",
        baselineOcr: "corpus/reports/ocr.json",
        currentStartup: ".temp/qa/startup.json",
        baselineStartup: "corpus/reports/startup.json",
        currentMemory: ".temp/qa/memory.json",
        baselineMemory: "corpus/reports/memory.json"
      },
      "/repo"
    ),
    [
      {
        profile: "ocr-throughput",
        current: "corpus/reports/ocr.json",
        baseline: "corpus/reports/ocr.json"
      }
    ]
  );
});

test("benchmark memory summary reports deltas", () => {
  assert.deepEqual(
    summarizeMemory(
      { rss: 100, heapUsed: 10, external: 5, arrayBuffers: 3 },
      { rss: 160, heapUsed: 7, external: 8, arrayBuffers: 11 }
    ),
    {
      rssDeltaBytes: 60,
      heapUsedDeltaBytes: -3,
      externalDeltaBytes: 3,
      arrayBuffersDeltaBytes: 8
    }
  );
});

test("benchmark peak memory summary reports absolute and delta peaks", () => {
  assert.deepEqual(
    summarizePeakMemory(
      { rss: 100, heapUsed: 10, external: 5, arrayBuffers: 3 },
      [
        { rss: 120, heapUsed: 8, external: 12, arrayBuffers: 3 },
        { rss: 90, heapUsed: 16, external: 7, arrayBuffers: 20 }
      ]
    ),
    {
      rssPeakBytes: 120,
      heapUsedPeakBytes: 16,
      externalPeakBytes: 12,
      arrayBuffersPeakBytes: 20,
      rssPeakDeltaBytes: 20,
      heapUsedPeakDeltaBytes: 6
    }
  );
});

function throughputReport(profileType, id, pagesPerSecond) {
  return {
    throughputProfile: {
      profileType,
      passed: true,
      cases: [
        {
          id,
          pagesPerSecond,
          passed: true
        }
      ]
    }
  };
}

function startupReport(id, totalStartupMeanMs) {
  return {
    startupProfile: {
      passed: true,
      cases: [
        {
          id,
          totalStartupMs: {
            meanMs: totalStartupMeanMs
          },
          passed: true
        }
      ]
    }
  };
}

function memoryReport(id, rssPeakDeltaBytes) {
  return {
    memoryProfile: {
      passed: true,
      cases: [
        {
          id,
          rssPeakDeltaBytes,
          passed: true
        }
      ]
    }
  };
}

test("benchmark startup and throughput durations are tracked separately", () => {
  assert.deepEqual(splitStartupAndThroughputDurations([12, 8, 10]), {
    startupMs: 12,
    throughputDurations: [8, 10]
  });
  assert.deepEqual(splitStartupAndThroughputDurations([12]), {
    startupMs: 12,
    throughputDurations: [12]
  });
});

test("benchmark GPU memory summary reports planned WebGPU memory", () => {
  assert.deepEqual(
    summarizeGpuMemoryFromExecution({
      provider: "webgpu",
      totalEstimatedBytes: 60,
      limits: { maxMemoryBytes: 100 },
      plannedPages: 2,
      skippedPages: 1,
      batches: [{ estimatedBytes: 40 }, { estimatedBytes: 20 }]
    }),
    {
      provider: "webgpu",
      source: "webgpu-execution-plan",
      estimatedBytes: 60,
      maxBatchEstimatedBytes: 40,
      limitBytes: 100,
      plannedPages: 2,
      skippedPages: 1
    }
  );
});

test("accepted output hash covers the stable public conversion result", () => {
  const cpuResult = {
    markdown: "ABCD",
    sourceMap: { version: "1", mappings: [{ pageIndex: 0, outputStart: 0 }] },
    assets: [{ id: "table-1", content: "a,b\n1,2\n" }],
    ir: { schemaVersion: "1", pages: [{ pageIndex: 0, elements: [] }] },
    warnings: [{ code: "sample.warning", message: "Sample warning", details: { pageIndex: 0 } }],
    diagnostics: {
      schemaVersion: "1",
      options: { ocrEnabled: false, webgpuRequired: false, webgpuPreferred: false },
      timing: { elapsedMs: 10 },
      acceleration: { webgpu: { selectedProvider: "cpu", fallbackReason: "not-requested" } },
      extraction: { textLines: 1 }
    },
    confidence: { overall: 0.9 }
  };
  const webgpuResult = structuredClone(cpuResult);
  webgpuResult.diagnostics.timing.elapsedMs = 50;
  webgpuResult.diagnostics.options.webgpuPreferred = true;
  webgpuResult.diagnostics.acceleration.webgpu = {
    selectedProvider: "webgpu",
    fallbackReason: null,
    preprocessing: { speedupRatio: 1.4 }
  };

  const expectedHash = createAcceptedOutputHash(cpuResult);
  assert.equal(createAcceptedOutputHash(webgpuResult), expectedHash);

  const correctnessMutations = [
    ["same-length Markdown", (result) => (result.markdown = "WXYZ")],
    ["source map", (result) => (result.sourceMap.mappings[0].outputStart = 1)],
    ["assets", (result) => (result.assets[0].content = "a,b\n2,1\n")],
    ["document IR", (result) => result.ir.pages[0].elements.push({ type: "paragraph" })],
    ["warnings", (result) => (result.warnings[0].message = "Changed warning")],
    ["diagnostics", (result) => (result.diagnostics.extraction.textLines = 2)],
    ["confidence", (result) => (result.confidence.overall = 0.8)]
  ];
  for (const [label, mutate] of correctnessMutations) {
    const changed = structuredClone(cpuResult);
    mutate(changed);
    assert.notEqual(createAcceptedOutputHash(changed), expectedHash, label);
  }
});

test("benchmark provider comparison reports parity and speed ratio", () => {
  assert.deepEqual(
    compareProviderResults([
      {
        id: "sample",
        workload: "ocr",
        providerMode: "cpu",
        outputChars: 100,
        textLines: 2,
        warnings: [],
        acceptedOutputHash: "sha256:same",
        pagesPerSecond: 10,
        startup: { durationMs: 20 },
        modelLoad: { durationMs: 0 },
        peakMemory: { rssPeakBytes: 100 },
        acceleration: { selectedProvider: "cpu", fallbackReason: null },
        gpuMemory: { estimatedBytes: 0 }
      },
      {
        id: "sample",
        workload: "ocr",
        providerMode: "webgpu-preferred",
        outputChars: 100,
        textLines: 2,
        warnings: [],
        acceptedOutputHash: "sha256:same",
        pagesPerSecond: 15,
        startup: { durationMs: 18 },
        modelLoad: { durationMs: 0 },
        peakMemory: { rssPeakBytes: 120 },
        acceleration: {
          selectedProvider: "cpu",
          fallbackReason: "node-stable-gpu-path-unavailable"
        },
        gpuMemory: { estimatedBytes: 0 }
      }
    ]),
    [
      {
        id: "sample",
        workload: "ocr",
        cpuSelectedProvider: "cpu",
        webgpuSelectedProvider: "cpu",
        webgpuFallbackReason: "node-stable-gpu-path-unavailable",
        cpuAcceptedOutputHash: "sha256:same",
        webgpuAcceptedOutputHash: "sha256:same",
        equivalentAcceptedOutput: true,
        speedupMetric: "pages-per-second",
        speedupRatio: 1.5,
        pagesPerSecondRatio: 1.5,
        webgpuPreprocessingSpeedupRatio: null,
        startupDeltaMs: -2,
        modelLoadDeltaMs: 0,
        rssPeakDeltaBytes: 20,
        gpuEstimatedBytes: 0
      }
    ]
  );
});

test("benchmark provider comparison prefers WebGPU preprocessing speed ratio", () => {
  const [comparison] = compareProviderResults([
    {
      id: "sample",
      workload: "ocr",
      providerMode: "cpu",
      outputChars: 100,
      textLines: 2,
      warnings: [],
      acceptedOutputHash: "sha256:same",
      pagesPerSecond: 10,
      startup: { durationMs: 20 },
      modelLoad: { durationMs: 0 },
      peakMemory: { rssPeakBytes: 100 },
      acceleration: { selectedProvider: "cpu", fallbackReason: null },
      gpuMemory: { estimatedBytes: 0 }
    },
    {
      id: "sample",
      workload: "ocr",
      providerMode: "webgpu-preferred",
      outputChars: 100,
      textLines: 2,
      warnings: [],
      acceptedOutputHash: "sha256:same",
      pagesPerSecond: 9,
      startup: { durationMs: 18 },
      modelLoad: { durationMs: 0 },
      peakMemory: { rssPeakBytes: 120 },
      acceleration: {
        selectedProvider: "webgpu",
        fallbackReason: null,
        preprocessing: {
          speedupRatio: 1.4
        }
      },
      gpuMemory: { estimatedBytes: 1024 }
    }
  ]);

  assert.equal(comparison.speedupMetric, "webgpu-preprocessing");
  assert.equal(comparison.speedupRatio, 1.4);
  assert.equal(comparison.pagesPerSecondRatio, 0.9);
  assert.equal(comparison.webgpuPreprocessingSpeedupRatio, 1.4);
});

test("benchmark provider comparison rejects matching summaries with different public outputs", () => {
  const common = {
    id: "sample",
    workload: "ocr",
    outputChars: 100,
    textLines: 2,
    warnings: [],
    pagesPerSecond: 10,
    startup: { durationMs: 20 },
    modelLoad: { durationMs: 0 },
    peakMemory: { rssPeakBytes: 100 },
    acceleration: { selectedProvider: "cpu", fallbackReason: null },
    gpuMemory: { estimatedBytes: 0 }
  };
  const [comparison] = compareProviderResults([
    { ...common, providerMode: "cpu", acceptedOutputHash: "sha256:cpu" },
    { ...common, providerMode: "webgpu-preferred", acceptedOutputHash: "sha256:webgpu" }
  ]);

  assert.equal(comparison.equivalentAcceptedOutput, false);
  assert.equal(comparison.cpuAcceptedOutputHash, "sha256:cpu");
  assert.equal(comparison.webgpuAcceptedOutputHash, "sha256:webgpu");
});

test("benchmark memory profile summarizes memory-gated long documents", () => {
  assert.deepEqual(
    createMemoryProfileSummary(
      [
        {
          id: "long-manual",
          gate: "layout-v1",
          kind: "long-document",
          features: ["long-document", "government-report"],
          workload: "conversion",
          providerMode: "cpu",
          bytes: 4000,
          iterations: 1,
          warmup: 0,
          pages: 4,
          memory: {
            rssDeltaBytes: 800,
            heapUsedDeltaBytes: 120,
            externalDeltaBytes: 40,
            arrayBuffersDeltaBytes: 8
          },
          peakMemory: {
            rssPeakBytes: 2000,
            heapUsedPeakBytes: 600,
            rssPeakDeltaBytes: 1000,
            heapUsedPeakDeltaBytes: 200
          },
          memoryLimits: {
            maxRssDeltaBytes: 1000,
            maxHeapUsedDeltaBytes: 400
          },
          memoryLimitViolations: [],
          passed: true
        },
        {
          id: "short-smoke",
          pages: 1,
          memory: { rssDeltaBytes: 50, heapUsedDeltaBytes: 10 },
          peakMemory: { rssPeakBytes: 500, heapUsedPeakBytes: 100 },
          memoryLimits: {
            maxRssDeltaBytes: null,
            maxHeapUsedDeltaBytes: null
          },
          memoryLimitViolations: [],
          passed: true
        }
      ],
      { scope: "memory-limit-gated" }
    ),
    {
      profileType: "long-memory",
      scope: "memory-limit-gated",
      resultCount: 1,
      passed: true,
      totals: {
        pages: 4,
        bytes: 4000
      },
      peaks: {
        rssDeltaBytes: 800,
        heapUsedDeltaBytes: 120,
        rssPeakBytes: 2000,
        heapUsedPeakBytes: 600,
        rssPeakDeltaBytes: 1000,
        heapUsedPeakDeltaBytes: 200
      },
      cases: [
        {
          id: "long-manual",
          gate: "layout-v1",
          kind: "long-document",
          features: ["long-document", "government-report"],
          workload: "conversion",
          providerMode: "cpu",
          pages: 4,
          bytes: 4000,
          iterations: 1,
          warmup: 0,
          rssDeltaBytes: 800,
          heapUsedDeltaBytes: 120,
          externalDeltaBytes: 40,
          arrayBuffersDeltaBytes: 8,
          rssPeakBytes: 2000,
          heapUsedPeakBytes: 600,
          rssPeakDeltaBytes: 1000,
          heapUsedPeakDeltaBytes: 200,
          rssDeltaBytesPerPage: 200,
          heapUsedDeltaBytesPerPage: 30,
          rssPeakDeltaBytesPerPage: 250,
          heapUsedPeakDeltaBytesPerPage: 50,
          limits: {
            maxRssDeltaBytes: 1000,
            maxHeapUsedDeltaBytes: 400
          },
          violations: [],
          passed: true
        }
      ]
    }
  );
});

test("benchmark memory limit evaluator reports exceeded thresholds", () => {
  assert.deepEqual(
    evaluateMemoryLimits(
      { rssDeltaBytes: 120, heapUsedDeltaBytes: 40 },
      { maxRssDeltaBytes: 100, maxHeapUsedDeltaBytes: 50 }
    ),
    [
      {
        metric: "maxRssDeltaBytes",
        actualMetric: "rssDeltaBytes",
        actual: 120,
        limit: 100
      }
    ]
  );
});

test("benchmark memory limit evaluator ignores absent thresholds", () => {
  assert.deepEqual(
    evaluateMemoryLimits(
      { rssDeltaBytes: 120, heapUsedDeltaBytes: 40 },
      { maxRssDeltaBytes: null, maxHeapUsedDeltaBytes: null }
    ),
    []
  );
});
