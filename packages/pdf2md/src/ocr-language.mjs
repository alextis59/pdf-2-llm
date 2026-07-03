const routedOcrSourceTypes = new Set(["scanned", "hybrid"]);
const defaultLanguages = Object.freeze(["eng"]);

export function createOcrLanguageConfig({
  adapter = null,
  options = {},
  scanDetection = null
} = {}) {
  const defaultPageLanguages = normalizeLanguages(adapter?.languages ?? options.languages);
  const modelLanguages = normalizeLanguages(adapter?.modelLoading?.languages ?? defaultPageLanguages);
  const overrides = normalizePageLanguageOverrides(options.pageLanguages);
  const routedPages = (scanDetection?.pages ?? []).filter((page) => routedOcrSourceTypes.has(page.sourceType));

  if (adapter?.enabled === false) {
    return createDiagnostics({
      defaultPageLanguages,
      enabled: false,
      modelLanguages,
      overrides,
      pages: [],
      status: "disabled"
    });
  }

  if (adapter?.status === "unsupported") {
    return createDiagnostics({
      defaultPageLanguages,
      enabled: true,
      modelLanguages,
      overrides,
      pages: [],
      status: "unsupported"
    });
  }

  const pages = routedPages.map((page) => {
    const languages = overrides.byPage.get(page.pageIndex) ?? defaultPageLanguages;
    return {
      pageIndex: page.pageIndex,
      sourceType: page.sourceType,
      languages,
      workerLanguage: workerLanguage(languages),
      modelFiles: modelFiles(languages)
    };
  });

  return createDiagnostics({
    defaultPageLanguages,
    enabled: true,
    modelLanguages,
    overrides,
    pages,
    status: pages.length > 0 ? "configured" : "no-routed-pages"
  });
}

function createDiagnostics({ defaultPageLanguages, enabled, modelLanguages, overrides, pages, status }) {
  return {
    enabled,
    status,
    defaultLanguages: defaultPageLanguages,
    modelLanguages,
    workerLanguage: workerLanguage(defaultPageLanguages),
    pageOverrides: overrides.list,
    pages
  };
}

function normalizePageLanguageOverrides(pageLanguages) {
  const byPage = new Map();
  if (!Array.isArray(pageLanguages)) {
    return { byPage, list: [] };
  }

  for (const override of pageLanguages) {
    if (!override || !Number.isInteger(override.pageIndex)) {
      continue;
    }
    byPage.set(override.pageIndex, normalizeLanguages(override.languages));
  }

  const list = [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pageIndex, languages]) => ({
      pageIndex,
      languages,
      workerLanguage: workerLanguage(languages),
      modelFiles: modelFiles(languages)
    }));
  return { byPage, list };
}

function normalizeLanguages(languages) {
  if (!Array.isArray(languages)) {
    return [...defaultLanguages];
  }
  const normalized = languages
    .filter((language) => typeof language === "string")
    .map((language) => language.trim())
    .filter((language) => language.length > 0);
  return [...new Set(normalized.length > 0 ? normalized : defaultLanguages)];
}

function workerLanguage(languages) {
  return languages.join("+");
}

function modelFiles(languages) {
  return languages.map((language) => `${language}.traineddata`);
}
