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

  if (!enabled) {
    return {
      enabled: false,
      requested,
      status: "disabled",
      languages,
      adapter: cpuAdapter
    };
  }

  if (requested !== cpuAdapter.id) {
    return {
      enabled: true,
      requested,
      status: "unsupported",
      languages,
      adapter: null
    };
  }

  return {
    enabled: true,
    requested,
    status: "selected",
    languages,
    adapter: cpuAdapter
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
  return normalized.length > 0 ? normalized : [...defaultLanguages];
}
