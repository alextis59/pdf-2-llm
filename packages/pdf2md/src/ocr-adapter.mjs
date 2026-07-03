const defaultLanguages = Object.freeze(["eng"]);
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
  const languages = normalizeLanguages(options.languages);
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

function normalizeLanguages(languages) {
  if (!Array.isArray(languages)) {
    return [...defaultLanguages];
  }
  const normalized = languages
    .filter((language) => typeof language === "string")
    .map((language) => language.trim())
    .filter((language) => language.length > 0);
  return uniqueLanguages(normalized.length > 0 ? normalized : defaultLanguages);
}

function collectModelLanguages(defaultPageLanguages, pageLanguages) {
  const languages = [...defaultPageLanguages];
  if (Array.isArray(pageLanguages)) {
    for (const pageLanguage of pageLanguages) {
      languages.push(...normalizeLanguages(pageLanguage?.languages));
    }
  }
  return uniqueLanguages(languages);
}

function uniqueLanguages(languages) {
  return [...new Set(languages)];
}
