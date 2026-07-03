import {
  normalizeLanguageSelection,
  uniqueLanguages
} from "./ocr-script-profiles.mjs";

const cpuAdapter = Object.freeze({
  id: "tesseract.js",
  kind: "cpu",
  packageName: "tesseract.js",
  version: "7.0.0",
  license: "Apache-2.0",
  runtimes: ["browser", "node", "worker"],
  output: "ocr-plan",
  notes: "Selected CPU OCR adapter; model loading and recognition are wired in later OCR phases."
});

export function selectOcrAdapter(options = {}) {
  const enabled = options.enabled !== false;
  const requested = options.adapter ?? cpuAdapter.id;
  const languages = normalizeLanguageSelection({
    languages: options.languages,
    scripts: options.scripts
  });
  const modelLanguages = collectModelLanguages(languages, options.pageLanguages);
  const modelLoading = createModelLoadingPlan(modelLanguages, options);

  if (!enabled) {
    return {
      enabled: false,
      requested,
      status: "disabled",
      languages,
      modelLoading,
      adapter: cpuAdapter
    };
  }

  if (requested !== cpuAdapter.id) {
    return {
      enabled: true,
      requested,
      status: "unsupported",
      languages,
      modelLoading,
      adapter: null
    };
  }

  return {
    enabled: true,
    requested,
    status: "selected",
    languages,
    modelLoading,
    adapter: cpuAdapter
  };
}

function createModelLoadingPlan(languages, options) {
  const cacheEnabled = options.cache?.enabled !== false;
  const cacheStrategy = cacheEnabled ? options.cache?.strategy ?? "adapter-default" : "none";
  return {
    strategy: "lazy",
    trigger: "routed-scanned-or-hybrid-pages",
    workerLifecycle: "reuse-worker-per-language-set",
    source: options.modelBaseUrl ?? "adapter-default",
    languages,
    modelFiles: languages.map((language) => `${language}.traineddata`),
    cache: {
      enabled: cacheEnabled,
      strategy: cacheStrategy,
      directory: options.cache?.directory ?? null,
      keyPrefix: `${cpuAdapter.id}:${cpuAdapter.version}`,
      browser: cacheEnabled ? "adapter-default-indexeddb" : "disabled",
      node: cacheEnabled ? "adapter-default-filesystem" : "disabled"
    }
  };
}

function collectModelLanguages(defaultPageLanguages, pageLanguages) {
  const languages = [...defaultPageLanguages];
  if (Array.isArray(pageLanguages)) {
    for (const pageLanguage of pageLanguages) {
      languages.push(
        ...normalizeLanguageSelection({
          languages: pageLanguage?.languages,
          scripts: pageLanguage?.scripts,
          fallback: pageLanguage?.scripts ? [] : undefined
        })
      );
    }
  }
  return uniqueLanguages(languages);
}
