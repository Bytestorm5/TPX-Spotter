import { describe, expect, it } from "vitest";
import { contrastRatio, cssColor, isDark, parseColor, readableOn } from "../../src/ui/next/theme/color.ts";
import { PRESETS, resolveTheme, SCHEMES, type Preset, type Scheme } from "../../src/ui/next/theme/tokens.ts";

/** Text/background pairs the UI actually renders. */
const TEXT_PAIRS: [fg: string, bg: string][] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surfaceHover"],
  ["textMuted", "bg"],
  ["textMuted", "surface"],
  ["primaryText", "primary"],
  ["primaryText", "primaryHover"],
  ["danger", "bg"],
  ["danger", "dangerSurface"],
  ["success", "bg"],
  ["success", "successSurface"],
  ["warning", "bg"],
  ["ring", "surface"],
];

describe("WCAG contrast in every preset × scheme", () => {
  for (const preset of Object.keys(PRESETS) as Preset[]) {
    for (const scheme of Object.keys(SCHEMES) as Scheme[]) {
      it(`${preset} / ${scheme}: text pairs ≥ 4.5:1`, () => {
        const { vars } = resolveTheme({ preset }, scheme, null);
        for (const [fg, bg] of TEXT_PAIRS) {
          const f = vars[`--sp-${fg.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`]!;
          const b = vars[`--sp-${bg.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`]!;
          const ratio = contrastRatio(f, b);
          expect(ratio, `${fg} ${f} on ${bg} ${b} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it(`${preset} / ${scheme}: focus ring and borders are visible (≥ 3:1 for the ring)`, () => {
        const { vars } = resolveTheme({ preset }, scheme, null);
        expect(contrastRatio(vars["--sp-ring"]!, vars["--sp-bg"]!)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it("test-mode ribbon text is readable in both schemes", () => {
    expect(contrastRatio("#7a4b00", "#fff4d6")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f6d38b", "#3a2e12")).toBeGreaterThanOrEqual(4.5);
  });

  it("trigger defaults (before theme loads) are readable", () => {
    expect(contrastRatio("#ffffff", "#18181b")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("inherit mode keeps contrast", () => {
  it("adopts a readable host accent with the right text colour", () => {
    const light = resolveTheme(undefined, "light", { accent: "#7c3aed" }).vars;
    expect(light["--sp-primary"]).toBe("#7c3aed");
    expect(contrastRatio(light["--sp-primary-text"]!, light["--sp-primary"]!)).toBeGreaterThanOrEqual(4.5);
    const yellow = resolveTheme(undefined, "light", { accent: "#facc15" }).vars;
    expect(yellow["--sp-primary-text"]).toBe("#18181b");
  });

  it("understands shadcn-style bare HSL accents", () => {
    const v = resolveTheme(undefined, "light", { accent: "222.2 47.4% 11.2%" }).vars;
    expect(v["--sp-primary"]).toBe("hsl(222.2 47.4% 11.2%)");
    expect(v["--sp-primary-text"]).toBe("#ffffff");
  });

  it("ignores an inherited text colour that would be low-contrast", () => {
    expect(resolveTheme(undefined, "light", { color: "rgb(160, 160, 160)" }).vars["--sp-text"]).toBe(SCHEMES.light.text);
    expect(resolveTheme(undefined, "light", { color: "rgb(20, 20, 60)" }).vars["--sp-text"]).toBe("rgb(20, 20, 60)");
  });

  it("keeps the ring legible when the accent is too pale for it", () => {
    const v = resolveTheme(undefined, "light", { accent: "#fde68a" }).vars;
    expect(contrastRatio(v["--sp-ring"]!, v["--sp-bg"]!)).toBeGreaterThanOrEqual(3);
  });

  it("uses the host font but not the UA serif default", () => {
    expect(resolveTheme(undefined, "light", { fontFamily: "Inter, sans-serif" }).vars["--sp-font"]).toBe("Inter, sans-serif");
    expect(resolveTheme(undefined, "light", { fontFamily: '"Times New Roman"' }).vars["--sp-font"]).not.toContain("Times");
    expect(resolveTheme({ mode: "styled" }, "light", { fontFamily: "Inter" }).vars["--sp-font"]).not.toBe("Inter");
  });

  it("explicit variables win over inherited ones", () => {
    const v = resolveTheme({ variables: { colorPrimary: "#0f766e", fontFamily: "Geist" } }, "light", { accent: "#7c3aed", fontFamily: "Inter" }).vars;
    expect(v["--sp-primary"]).toBe("#0f766e");
    expect(v["--sp-font"]).toBe("Geist");
  });
});

describe("colour parsing", () => {
  it("parses hex, rgb(a), hsl(a) and bare hsl", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#11223380")?.a).toBeCloseTo(0.5, 1);
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor("rgba(1 2 3 / 50%)")?.a).toBe(0.5);
    expect(parseColor("hsl(0, 100%, 50%)")).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseColor("210 40% 98%")).not.toBeNull();
    expect(parseColor("oklch(0.6 0.2 30)")).toBeNull();
    expect(parseColor("var(--x)")).toBeNull();
  });
  it("computes the WCAG ratio", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(isDark("rgb(10,10,10)")).toBe(true);
    expect(isDark("rgba(0,0,0,0)")).toBeNull();
    expect(cssColor("222 47% 11%")).toBe("hsl(222 47% 11%)");
  });
});
