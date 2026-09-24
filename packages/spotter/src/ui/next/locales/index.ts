/**
 * Message catalogues and formatting. Loaded with the panel chunk, never by
 * the loader: English is inline here, every other locale is its own dynamic
 * `import()` chunk fetched only when that locale is detected.
 */
import { en, type MessageKey, type Messages } from "./en.ts";
import type { Locale } from "./detect.ts";

export { en, type MessageKey, type Messages };
export { LOCALES, RTL_LOCALES, detectLocale, isRtl, matchLocale, type Locale } from "./detect.ts";

/** Static import expressions so every bundler can split them. */
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: Messages }>> = {
  es: () => import("./es.ts"),
  fr: () => import("./fr.ts"),
  de: () => import("./de.ts"),
  it: () => import("./it.ts"),
  pt: () => import("./pt.ts"),
  "pt-BR": () => import("./pt-BR.ts"),
  nl: () => import("./nl.ts"),
  sv: () => import("./sv.ts"),
  da: () => import("./da.ts"),
  nb: () => import("./nb.ts"),
  fi: () => import("./fi.ts"),
  pl: () => import("./pl.ts"),
  cs: () => import("./cs.ts"),
  tr: () => import("./tr.ts"),
  ru: () => import("./ru.ts"),
  uk: () => import("./uk.ts"),
  ar: () => import("./ar.ts"),
  he: () => import("./he.ts"),
  fa: () => import("./fa.ts"),
  hi: () => import("./hi.ts"),
  ja: () => import("./ja.ts"),
  ko: () => import("./ko.ts"),
  "zh-CN": () => import("./zh-CN.ts"),
  "zh-TW": () => import("./zh-TW.ts"),
  id: () => import("./id.ts"),
  vi: () => import("./vi.ts"),
  th: () => import("./th.ts"),
};

export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === "en") return en;
  try {
    return (await LOADERS[locale]()).default;
  } catch {
    return en; // A failed chunk load must never block reporting.
  }
}

/** Test/SSR helper: all loaders, for the completeness test. */
export function localeLoader(locale: Exclude<Locale, "en">): () => Promise<{ default: Messages }> {
  return LOADERS[locale];
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Build `t()`: overrides beat the locale, which beats English. */
export function createTranslator(messages: Messages, overrides?: Record<string, string>): Translate {
  return (key, vars) => {
    let s = overrides?.[key] ?? messages[key] ?? en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    }
    return s;
  };
}

