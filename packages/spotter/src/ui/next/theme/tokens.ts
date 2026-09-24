/**
 * Design tokens and their resolution into CSS custom properties.
 *
 * Neutral by design (the "Clerk standard"): zinc greys, a near-black primary
 * that sits on any brand, no Trusplex colours or fonts. Inherit mode swaps in
 * the host's font, text colour and accent, and every contrast-sensitive pair
 * is re-checked so an inherited accent can never make a button unreadable.
 *
 * `test/ui/contrast.test.ts` asserts ≥ 4.5:1 for every text pair in every
 * preset × scheme.
 */
import type { Appearance } from "../../../core/schema.ts";
import { contrastRatio, cssColor, parseColor, readableOn } from "./color.ts";

export type Scheme = "light" | "dark";
export type Preset = NonNullable<Appearance["preset"]>;

export interface ColorTokens {
  bg: string;
  /** Inputs, chips, secondary surfaces. */
  surface: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  danger: string;
  dangerSurface: string;
  success: string;
  successSurface: string;
  warning: string;
  /** Backdrop behind the annotation view. */
  overlay: string;
  ring: string;
}

export const SCHEMES: Record<Scheme, ColorTokens> = {
  light: {
    bg: "#ffffff",
    surface: "#f6f6f7",
    surfaceHover: "#ededef",
    border: "#e4e4e7",
    borderStrong: "#cfcfd4",
    text: "#18181b",
    textMuted: "#5d5d66",
    primary: "#18181b",
    primaryHover: "#303036",
    primaryText: "#ffffff",
    danger: "#c4262e",
    dangerSurface: "#fdf0f0",
    success: "#18794e",
    successSurface: "#ecf8f1",
    warning: "#9a5b00",
    overlay: "rgba(9, 9, 11, 0.72)",
    ring: "#2563eb",
  },
  dark: {
    bg: "#1b1b1f",
    surface: "#26262b",
    surfaceHover: "#2f2f35",
    border: "#34343b",
    borderStrong: "#46464e",
    text: "#f4f4f5",
    textMuted: "#a8a8b3",
    primary: "#f4f4f5",
    primaryHover: "#dcdce0",
    primaryText: "#18181b",
    danger: "#ff7a7a",
    dangerSurface: "#3a1f22",
    success: "#4cc38a",
    successSurface: "#1b2e25",
    warning: "#f1b555",
    overlay: "rgba(0, 0, 0, 0.78)",
    ring: "#6ea8ff",
  },
};

export interface ShapeTokens {
  radiusPanel: string;
  radiusControl: string;
  radiusChip: string;
  radiusTrigger: string;
  shadowPanel: string;
  shadowTrigger: string;
  borderWidth: string;
}

export const PRESETS: Record<Preset, ShapeTokens> = {
  default: {
    radiusPanel: "14px",
    radiusControl: "8px",
    radiusChip: "999px",
    radiusTrigger: "999px",
    shadowPanel: "0 0 0 1px rgba(0,0,0,.04), 0 16px 40px -8px rgba(0,0,0,.18), 0 4px 12px -2px rgba(0,0,0,.08)",
    shadowTrigger: "0 1px 2px rgba(0,0,0,.12), 0 6px 16px -4px rgba(0,0,0,.24)",
    borderWidth: "1px",
  },
  minimal: {
    radiusPanel: "8px",
    radiusControl: "6px",
    radiusChip: "6px",
    radiusTrigger: "8px",
    shadowPanel: "0 8px 24px -6px rgba(0,0,0,.14)",
    shadowTrigger: "0 2px 8px -2px rgba(0,0,0,.2)",
    borderWidth: "1px",
  },
  rounded: {
    radiusPanel: "24px",
    radiusControl: "14px",
    radiusChip: "999px",
    radiusTrigger: "999px",
    shadowPanel: "0 0 0 1px rgba(0,0,0,.03), 0 24px 56px -12px rgba(0,0,0,.22), 0 6px 16px -4px rgba(0,0,0,.08)",
    shadowTrigger: "0 2px 4px rgba(0,0,0,.1), 0 10px 24px -6px rgba(0,0,0,.28)",
    borderWidth: "1px",
  },
  sharp: {
    radiusPanel: "2px",
    radiusControl: "2px",
    radiusChip: "2px",
    radiusTrigger: "2px",
    shadowPanel: "0 12px 32px -8px rgba(0,0,0,.2)",
    shadowTrigger: "0 4px 12px -2px rgba(0,0,0,.24)",
    borderWidth: "1px",
  },
};

export const DEFAULT_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

/** What inherit mode read from the host page (see `inherit.ts`). */
export interface Inherited {
  fontFamily?: string;
  color?: string;
  accent?: string;
}

export interface ResolvedTheme {
  scheme: Scheme;
  preset: Preset;
  vars: Record<string, string>;
}

/**
 * Resolve appearance + inherited host values into `--sp-*` variables.
 * Order: preset/scheme defaults < inherited host values < `appearance.variables`.
 */
export function resolveTheme(appearance: Appearance | undefined, scheme: Scheme, inherited: Inherited | null): ResolvedTheme {
  const preset: Preset = appearance?.preset ?? "default";
  const base = { ...SCHEMES[scheme] };
  const shape = PRESETS[preset] ?? PRESETS.default;
  const v = appearance?.variables ?? {};
  let font = DEFAULT_FONT;

  if (inherited && (appearance?.mode ?? "inherit") === "inherit") {
    if (inherited.fontFamily && !/^(serif|"?Times New Roman"?.*)$/i.test(inherited.fontFamily.trim())) {
      // A host with no font set reports the UA default serif; keep the system stack then.
      font = inherited.fontFamily;
    }
    if (inherited.color && contrastRatio(inherited.color, base.bg) >= 7) base.text = inherited.color;
    if (inherited.accent) applyPrimary(base, inherited.accent);
  }
  if (v.colorBackground) {
    base.bg = v.colorBackground;
    // Derive surfaces from the chosen background so inputs don't look pasted on.
    const dark = (parseColor(v.colorBackground) && readableOn(v.colorBackground) === "#ffffff") || false;
    base.surface = `color-mix(in srgb, ${v.colorBackground} ${dark ? "92%" : "96%"}, ${dark ? "#fff" : "#000"})`;
    base.surfaceHover = `color-mix(in srgb, ${v.colorBackground} ${dark ? "86%" : "92%"}, ${dark ? "#fff" : "#000"})`;
  }
  if (v.colorText) {
    base.text = v.colorText;
    base.textMuted = `color-mix(in srgb, ${v.colorText} 70%, ${base.bg})`;
  }
  if (v.colorPrimary) applyPrimary(base, v.colorPrimary, true);
  if (v.colorDanger) base.danger = v.colorDanger;
  if (v.fontFamily) font = v.fontFamily;

  const unit = v.spacingUnit ?? (appearance?.layout?.density === "compact" ? "0.875rem" : "1rem");
  const radius = v.borderRadius;
  const vars: Record<string, string> = {
    "--sp-font": font,
    "--sp-unit": unit,
    "--sp-panel-width": `${appearance?.layout?.panelWidth ?? 400}px`,
    "--sp-radius-panel": radius ? `calc(${radius} * 1.5)` : shape.radiusPanel,
    "--sp-radius": radius ?? shape.radiusControl,
    "--sp-radius-chip": radius && preset !== "rounded" && preset !== "default" ? radius : shape.radiusChip,
    "--sp-radius-trigger": shape.radiusTrigger,
    // Shadows vanish on dark pages; a hairline highlight keeps the panel's edge.
    "--sp-shadow-panel":
      scheme === "dark" ? `inset 0 0 0 1px rgba(255,255,255,.06), 0 20px 48px -8px rgba(0,0,0,.6)` : shape.shadowPanel,
    "--sp-shadow-trigger": shape.shadowTrigger,
    "--sp-border-width": shape.borderWidth,
  };
  for (const [k, value] of Object.entries(base)) vars[`--sp-${kebab(k)}`] = value;
  return { scheme, preset, vars };
}

/**
 * Use `color` as the primary if it can carry readable text; pick black or
 * white for that text. An accent too close to the background still colours
 * the button, but links and the focus ring fall back to the text colour.
 */
function applyPrimary(t: ColorTokens, color: string, explicit = false): void {
  const c = cssColor(color);
  const parsed = parseColor(c);
  if (!parsed) {
    if (explicit) t.primary = c; // Trust an explicit unparseable value (oklch, var()).
    return;
  }
  const text = readableOn(c);
  if (contrastRatio(text, c) < 4.5 && !explicit) return;
  t.primary = c;
  t.primaryText = text;
  t.primaryHover = `color-mix(in srgb, ${c} 88%, ${text})`;
  if (contrastRatio(c, t.bg) >= 3) t.ring = c;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Serialise variables as a `:host` rule for a constructed stylesheet (CSP-safe: no style attributes). */
export function themeCss(theme: ResolvedTheme, selector = ":host"): string {
  const body = Object.entries(theme.vars)
    .map(([k, v]) => `${k}:${v.replace(/[;{}<>]/g, "")};`)
    .join("");
  return `${selector}{${body}color-scheme:${theme.scheme};}`;
}
