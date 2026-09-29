import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/theme/color.ts";
import { SCHEMES, createTheme, defaultTheme, themeCss, type ColorTokens, type Scheme } from "../src/theme/tokens.ts";

/** Text/background pairs the kit actually renders. */
const TEXT_PAIRS: [fg: keyof ColorTokens, bg: keyof ColorTokens][] = [
  ["text", "bg"],
  ["text", "canvas"],
  ["text", "surface"],
  ["text", "surfaceHover"],
  ["textMuted", "bg"],
  ["textMuted", "canvas"],
  ["textMuted", "surface"],
  ["primaryText", "primary"],
  ["primaryText", "primaryHover"],
  ["primarySoftText", "primarySoft"],
  ["danger", "bg"],
  ["danger", "dangerSurface"],
  ["success", "bg"],
  ["success", "successSurface"],
  ["warning", "bg"],
  ["warning", "warningSurface"],
  ["info", "bg"],
  ["info", "infoSurface"],
];

const v = (theme: Record<string, string>, token: string) =>
  theme[`--tui-${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`]!;

describe("the default tokens", () => {
  for (const scheme of Object.keys(SCHEMES) as Scheme[]) {
    it(`${scheme}: every text pair is at least 4.5:1`, () => {
      const t = SCHEMES[scheme];
      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrastRatio(t[fg], t[bg]);
        expect(ratio, `${fg} ${t[fg]} on ${bg} ${t[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${scheme}: the focus ring stands out (3:1)`, () => {
      expect(contrastRatio(SCHEMES[scheme].ring, SCHEMES[scheme].bg)).toBeGreaterThanOrEqual(3);
    });
  }

  it("ship in styles.css exactly as the theme module resolves them", () => {
    // Formatting-insensitive: whitespace and `0.5` vs `.5` don't count (the file is Prettier-formatted).
    const norm = (css: string) => css.replace(/\s+/g, "").replace(/(^|[^\d])0\./g, "$1.");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(norm(css)).toContain(norm(themeCss(defaultTheme, { weak: true })));
  });
});

describe("createTheme", () => {
  it("gives a brand primary readable text, a hover and the focus ring", () => {
    const light = createTheme({ primary: "#8B4447" }).light;
    expect(v(light, "primary")).toBe("#8B4447");
    expect(v(light, "primaryText")).toBe("#ffffff");
    expect(contrastRatio(v(light, "primaryText"), "#8B4447")).toBeGreaterThanOrEqual(4.5);
    expect(v(light, "ring")).toBe("#8B4447");
    expect(v(light, "primaryHover")).toContain("color-mix");
  });

  it("puts dark text on a light primary and keeps the ring when the primary is too faint", () => {
    const light = createTheme({ primary: "#EFC7B7" }).light;
    expect(v(light, "primaryText")).toBe("#18181b");
    expect(v(light, "ring")).toBe(SCHEMES.light.ring);
    // Too faint to be text on white: soft text falls back to the text colour.
    expect(v(light, "primarySoftText")).toBe(SCHEMES.light.text);
  });

  it("applies per-scheme overrides after the primary, and can drop the dark scheme", () => {
    const theme = createTheme({ primary: "#8B4447", light: { canvas: "#F9F3ED", ring: "#123456" }, dark: false });
    expect(v(theme.light, "canvas")).toBe("#F9F3ED");
    expect(v(theme.light, "ring")).toBe("#123456");
    expect(theme.dark).toBeNull();
  });

  it("takes shape presets and type, and uses the body font for headings unless told otherwise", () => {
    const theme = createTheme({ preset: "rounded", type: { font: "Mulish, sans-serif" } });
    expect(v(theme.light, "radiusButton")).toBe("999px");
    expect(v(theme.light, "fontDisplay")).toBe("Mulish, sans-serif");
    const serif = createTheme({ type: { font: "Mulish", fontDisplay: "Cormorant" } });
    expect(v(serif.light, "fontDisplay")).toBe("Cormorant");
  });

  it("serialises to CSS with a system-preference and a pinned dark scheme", () => {
    const css = themeCss(createTheme({ primary: "#8B4447" }));
    expect(css).toMatch(/^:root \{/);
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n:root:not([data-theme="light"]) {');
    expect(css).toContain('\n[data-theme="dark"] {');
    expect(css).toContain('\n[data-theme="light"] {');
    expect(themeCss(createTheme(), { dark: "attribute" })).not.toContain("@media");
    // Values can't break out of the declaration.
    expect(themeCss(createTheme({ light: { text: "red;} body{display:none" } }))).not.toContain("} body{");
  });
});
