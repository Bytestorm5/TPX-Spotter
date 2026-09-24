/**
 * Locale detection — tiny and dependency-free so the loader can decide the
 * locale (and text direction) without carrying any strings.
 *
 * Detection order: explicit `locale` > `<html lang>` (the language the
 * reporter is reading) > `navigator.languages` > English.
 */
export const LOCALES = [
  "en", "es", "fr", "de", "it", "pt", "pt-BR", "nl", "sv", "da", "nb", "fi", "pl", "cs",
  "tr", "ru", "uk", "ar", "he", "fa", "hi", "ja", "ko", "zh-CN", "zh-TW", "id", "vi", "th",
] as const;
export type Locale = (typeof LOCALES)[number];

export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "he", "fa"]);

/**
 * Map any BCP 47 tag onto a shipped locale: exact match, then well-known
 * regional variants (`zh-Hant`/`zh-HK` → zh-TW, `no`/`nn` → nb, `iw` → he),
 * then the base language.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const t = tag.trim().replace(/_/g, "-");
  if (!t) return null;
  const lower = t.toLowerCase();
  const exact = LOCALES.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const [lang = "", ...rest] = lower.split("-");
  const region = rest.join("-");
  if (lang === "zh") {
    return /hant|tw|hk|mo/.test(region) ? "zh-TW" : "zh-CN";
  }
  if (lang === "pt") return region === "br" ? "pt-BR" : "pt";
  if (lang === "no" || lang === "nn" || lang === "nb") return "nb";
  if (lang === "iw") return "he";
  if (lang === "in") return "id";
  const base = LOCALES.find((l) => l.toLowerCase() === lang);
  return base ?? null;
}

export function detectLocale(explicit?: string): Locale {
  const fromExplicit = matchLocale(explicit);
  if (fromExplicit) return fromExplicit;
  if (typeof document !== "undefined") {
    const fromHtml = matchLocale(document.documentElement.getAttribute("lang"));
    if (fromHtml) return fromHtml;
  }
  if (typeof navigator !== "undefined") {
    for (const l of navigator.languages ?? [navigator.language]) {
      const m = matchLocale(l);
      if (m) return m;
    }
  }
  return "en";
}

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.has(locale.split("-")[0] ?? locale);
}
