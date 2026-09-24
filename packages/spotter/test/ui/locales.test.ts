import { describe, expect, it } from "vitest";
import { en } from "../../src/ui/next/locales/en.ts";
import { createTranslator, isRtl, LOCALES, localeLoader, matchLocale, type Locale } from "../../src/ui/next/locales/index.ts";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("locales", () => {
  it("ships at least 20 locales, including every one the spec lists", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(20);
    for (const l of ["en", "es", "fr", "de", "it", "pt", "pt-BR", "nl", "sv", "da", "nb", "fi", "pl", "cs", "tr", "ru", "uk", "ar", "he", "fa", "hi", "ja", "ko", "zh-CN", "zh-TW", "id", "vi", "th"]) {
      expect(LOCALES).toContain(l);
    }
  });

  for (const locale of LOCALES.filter((l): l is Exclude<Locale, "en"> => l !== "en")) {
    it(`${locale}: every key, no extras, same placeholders, actually translated`, async () => {
      const messages = (await localeLoader(locale)()).default as Record<string, string>;
      const missing = Object.keys(en).filter((k) => !(k in messages));
      const extra = Object.keys(messages).filter((k) => !(k in en));
      expect(missing, `missing in ${locale}`).toEqual([]);
      expect(extra, `unknown keys in ${locale}`).toEqual([]);
      let identical = 0;
      for (const [k, v] of Object.entries(en)) {
        const tr = messages[k]!;
        expect(tr.trim().length, `${locale}.${k} is empty`).toBeGreaterThan(0);
        expect(placeholders(tr), `${locale}.${k} placeholders`).toEqual(placeholders(v));
        if (tr === v) identical++;
      }
      // Loanwords ("Bug", "Feedback", "Email") may match English; wholesale copies may not.
      expect(identical, `${locale} looks untranslated`).toBeLessThan(Object.keys(en).length * 0.12);
    });
  }

  it("maps BCP 47 tags onto shipped locales", () => {
    expect(matchLocale("fr-CA")).toBe("fr");
    expect(matchLocale("pt-BR")).toBe("pt-BR");
    expect(matchLocale("pt_br")).toBe("pt-BR");
    expect(matchLocale("pt-PT")).toBe("pt");
    expect(matchLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(matchLocale("zh-HK")).toBe("zh-TW");
    expect(matchLocale("zh")).toBe("zh-CN");
    expect(matchLocale("no")).toBe("nb");
    expect(matchLocale("nn-NO")).toBe("nb");
    expect(matchLocale("iw")).toBe("he");
    expect(matchLocale("xx")).toBeNull();
    expect(matchLocale("")).toBeNull();
  });

  it("marks right-to-left locales", () => {
    expect(["ar", "he", "fa"].every(isRtl)).toBe(true);
    expect(isRtl("en")).toBe(false);
    expect(isRtl("ur")).toBe(false);
  });

  it("interpolates and lets overrides win", () => {
    const t = createTranslator(en, { "sent.title": "Merci!" });
    expect(t("sent.title")).toBe("Merci!");
    expect(t("sent.bodyNoContact", { ref: "SPT-1" })).toBe("Your reference is SPT-1.");
  });
});
