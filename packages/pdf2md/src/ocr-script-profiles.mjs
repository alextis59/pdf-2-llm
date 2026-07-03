export const defaultOcrLanguages = Object.freeze(["eng"]);

const scriptLanguageProfiles = Object.freeze({
  latin: Object.freeze(["eng"]),
  rtl: Object.freeze(["ara", "heb"]),
  arabic: Object.freeze(["ara"]),
  hebrew: Object.freeze(["heb"]),
  cjk: Object.freeze(["chi_sim", "chi_tra", "jpn", "kor"]),
  chinese: Object.freeze(["chi_sim", "chi_tra"]),
  japanese: Object.freeze(["jpn"]),
  korean: Object.freeze(["kor"]),
  vertical: Object.freeze(["jpn_vert"])
});

export function normalizeLanguageSelection({
  languages,
  scripts,
  fallback = defaultOcrLanguages
} = {}) {
  return uniqueLanguages([
    ...normalizeLanguages(languages, fallback),
    ...languagesForScripts(scripts)
  ]);
}

export function normalizeLanguages(languages, fallback = defaultOcrLanguages) {
  if (!Array.isArray(languages)) {
    return [...fallback];
  }
  const normalized = languages
    .filter((language) => typeof language === "string")
    .map((language) => language.trim())
    .filter((language) => language.length > 0);
  return uniqueLanguages(normalized.length > 0 ? normalized : fallback);
}

export function normalizeScriptHints(scripts) {
  if (!Array.isArray(scripts)) {
    return [];
  }
  return uniqueLanguages(
    scripts
      .filter((script) => typeof script === "string")
      .map((script) => script.trim().toLowerCase())
      .filter((script) => scriptLanguageProfiles[script])
  );
}

export function scriptProfilesForHints(scripts) {
  return normalizeScriptHints(scripts).map((script) => ({
    script,
    languages: [...scriptLanguageProfiles[script]]
  }));
}

export function languagesForScripts(scripts) {
  return uniqueLanguages(scriptProfilesForHints(scripts).flatMap((profile) => profile.languages));
}

export function uniqueLanguages(languages) {
  return [...new Set(languages)];
}
