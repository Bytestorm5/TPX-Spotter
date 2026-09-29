/**
 * Design tokens and themes.
 *
 * The defaults are the Spotter widget's: neutral zinc greys and a
 * near-black primary that sit on any brand, with every text pair at 4.5:1
 * or better in both schemes (`test/contrast.test.ts`). A theme overrides any
 * of them; a primary colour you pass is given readable text, a hover shade
 * and — when it stands out enough from the background — the focus ring, the
 * same way the widget adopts a host's accent.
 *
 * Every token is a CSS custom property, `--tui-<kebab-name>`, so an app can
 * also theme the kit in plain CSS. `src/styles.css` carries the defaults at
 * zero specificity: any `:root { --tui-… }` an app writes wins.
 */
import { contrastRatio, cssColor, parseColor, readableOn } from "./color.ts";

export type Scheme = "light" | "dark";

export interface ColorTokens {
  /** The page behind everything. */
  canvas: string;
  /** Cards, dialogs, inputs. */
  bg: string;
  /** Chips, secondary surfaces, hover fills. */
  surface: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  /** Tinted fill for soft buttons, accent badges and selected rows. */
  primarySoft: string;
  primarySoftText: string;
  danger: string;
  dangerSurface: string;
  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  info: string;
  infoSurface: string;
  /** Backdrop behind dialogs. */
  overlay: string;
  ring: string;
}

export const SCHEMES: Record<Scheme, ColorTokens> = {
  light: {
    canvas: "#fafafa",
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
    primarySoft: "#ededef",
    primarySoftText: "#18181b",
    danger: "#c4262e",
    dangerSurface: "#fdf0f0",
    success: "#18794e",
    successSurface: "#ecf8f1",
    warning: "#9a5b00",
    warningSurface: "#fdf4e3",
    info: "#1d5fd1",
    infoSurface: "#edf3fd",
    overlay: "rgba(9, 9, 11, 0.45)",
    ring: "#2563eb",
  },
  dark: {
    canvas: "#111113",
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
    primarySoft: "#2f2f35",
    primarySoftText: "#f4f4f5",
    danger: "#ff7a7a",
    dangerSurface: "#3a1f22",
    success: "#4cc38a",
    successSurface: "#1b2e25",
    warning: "#f1b555",
    warningSurface: "#3a2e12",
    info: "#6ea8ff",
    infoSurface: "#17233a",
    overlay: "rgba(0, 0, 0, 0.65)",
    ring: "#6ea8ff",
  },
};

export interface ShapeTokens {
  /** Inputs, selects, small surfaces. */
  radius: string;
  radiusButton: string;
  radiusChip: string;
  radiusCard: string;
  radiusPanel: string;
  shadowControl: string;
  shadowCard: string;
  shadowPanel: string;
  borderWidth: string;
}

export type Preset = "default" | "minimal" | "rounded" | "sharp";

export const PRESETS: Record<Preset, ShapeTokens> = {
  default: {
    radius: "8px",
    radiusButton: "8px",
    radiusChip: "999px",
    radiusCard: "12px",
    radiusPanel: "14px",
    shadowControl: "0 1px 2px rgba(0,0,0,.04)",
    shadowCard: "0 1px 2px rgba(0,0,0,.04), 0 1px 3px rgba(0,0,0,.04)",
    shadowPanel: "0 0 0 1px rgba(0,0,0,.04), 0 16px 40px -8px rgba(0,0,0,.18), 0 4px 12px -2px rgba(0,0,0,.08)",
    borderWidth: "1px",
  },
  minimal: {
    radius: "6px",
    radiusButton: "6px",
    radiusChip: "6px",
    radiusCard: "8px",
    radiusPanel: "8px",
    shadowControl: "none",
    shadowCard: "none",
    shadowPanel: "0 8px 24px -6px rgba(0,0,0,.14)",
    borderWidth: "1px",
  },
  rounded: {
    radius: "14px",
    radiusButton: "999px",
    radiusChip: "999px",
    radiusCard: "20px",
    radiusPanel: "24px",
    shadowControl: "0 1px 2px rgba(0,0,0,.04)",
    shadowCard: "0 2px 6px rgba(0,0,0,.06)",
    shadowPanel: "0 0 0 1px rgba(0,0,0,.03), 0 24px 56px -12px rgba(0,0,0,.22), 0 6px 16px -4px rgba(0,0,0,.08)",
    borderWidth: "1px",
  },
  sharp: {
    radius: "2px",
    radiusButton: "2px",
    radiusChip: "2px",
    radiusCard: "2px",
    radiusPanel: "2px",
    shadowControl: "none",
    shadowCard: "none",
    shadowPanel: "0 12px 32px -8px rgba(0,0,0,.2)",
    borderWidth: "1px",
  },
};

export interface TypeTokens {
  font: string;
  /** Headings (card and dialog titles). Defaults to `font`. */
  fontDisplay: string;
  fontMono: string;
  fontSize: string;
  fontSizeSm: string;
  fontSizeXs: string;
  weightMedium: string;
  weightStrong: string;
  controlHeight: string;
  controlHeightSm: string;
  controlHeightLg: string;
}

export const DEFAULT_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

export const TYPE: TypeTokens = {
  font: DEFAULT_FONT,
  fontDisplay: DEFAULT_FONT,
  fontMono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "14px",
  fontSizeSm: "13px",
  fontSizeXs: "12px",
  weightMedium: "500",
  weightStrong: "600",
  controlHeight: "38px",
  controlHeightSm: "30px",
  controlHeightLg: "46px",
};

export interface ThemeOptions {
  /** Shape preset. Default `default`. */
  preset?: Preset;
  /** A brand colour for both schemes; given readable text, a hover shade and the focus ring. */
  primary?: string;
  /** Per-scheme colour overrides, applied after `primary`. */
  light?: Partial<ColorTokens>;
  /** `false`: the theme has no dark scheme (the light one applies everywhere). */
  dark?: Partial<ColorTokens> | false;
  shape?: Partial<ShapeTokens>;
  type?: Partial<TypeTokens>;
}

export interface Theme {
  light: Record<string, string>;
  dark: Record<string, string> | null;
}

/** Resolve options into `--tui-*` variables per scheme. */
export function createTheme(options: ThemeOptions = {}): Theme {
  const shape = { ...PRESETS[options.preset ?? "default"], ...options.shape };
  const type = { ...TYPE, ...options.type };
  if (options.type?.font && !options.type.fontDisplay) type.fontDisplay = options.type.font;
  const resolve = (scheme: Scheme, over: Partial<ColorTokens> | undefined): Record<string, string> => {
    const colors = { ...SCHEMES[scheme] };
    if (options.primary) applyPrimary(colors, options.primary, scheme);
    if (over?.primary && !over.primaryText) applyPrimary(colors, over.primary, scheme);
    Object.assign(colors, over);
    return toVars({ ...colors, ...shape, ...type });
  };
  return {
    light: resolve("light", options.light),
    dark: options.dark === false ? null : resolve("dark", options.dark),
  };
}

/** The kit's own defaults (what `styles.css` ships). */
export const defaultTheme: Theme = createTheme();

/**
 * Use `color` as the primary with readable text on it, a hover shade and a
 * soft tint. The focus ring follows it only when it stands out (≥ 3:1) from
 * the background; otherwise the scheme's ring stays.
 */
export function applyPrimary(t: ColorTokens, color: string, scheme: Scheme = "light"): void {
  const c = cssColor(color);
  t.primary = c;
  if (!parseColor(c)) return; // oklch(), var(): trust it, keep the scheme's derived values
  const text = readableOn(c);
  t.primaryText = text;
  t.primaryHover = `color-mix(in srgb, ${c} 86%, ${text === "#ffffff" ? "#000" : "#fff"})`;
  t.primarySoft = `color-mix(in srgb, ${c} ${scheme === "dark" ? "22%" : "10%"}, ${t.bg})`;
  t.primarySoftText = contrastRatio(c, t.bg) >= 4.5 ? c : t.text;
  if (contrastRatio(c, t.bg) >= 3) t.ring = c;
}

export function toVars(tokens: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) vars[`--tui-${kebab(k)}`] = v;
  return vars;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function block(selector: string, vars: Record<string, string>, scheme: Scheme): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v.replace(/[;{}<>]/g, "")};`)
    .join("\n");
  return `${selector} {\n${body}\n  color-scheme: ${scheme};\n}`;
}

export interface ThemeCssOptions {
  /** Where the variables go. Default `:root`. */
  selector?: string;
  /**
   * How the dark scheme switches on: `media` (the system preference, unless
   * `data-theme="light"` pins light; `data-theme="dark"` pins dark) or
   * `attribute` (only `data-theme="dark"`). Either attribute works on the
   * root or on any element, for a subtree in the other scheme. Default `media`.
   */
  dark?: "media" | "attribute";
  /** Wrap every selector in `:where()`, so any rule an app writes overrides these. Default false. */
  weak?: boolean;
}

/** Serialise a theme as CSS, for a stylesheet or a `<style>` tag. */
export function themeCss(theme: Theme, options: ThemeCssOptions = {}): string {
  const sel = options.selector ?? ":root";
  const w = (s: string) => (options.weak ? `:where(${s})` : s);
  const out = [block(w(sel), theme.light, "light")];
  if (theme.dark) {
    // `data-theme` works on the root or on any subtree (a dark sidebar, a preview pane).
    const pinned = sel === ":root" ? '[data-theme="dark"]' : `[data-theme="dark"] ${sel}, ${sel}[data-theme="dark"]`;
    const light = sel === ":root" ? '[data-theme="light"]' : `[data-theme="light"] ${sel}, ${sel}[data-theme="light"]`;
    if ((options.dark ?? "media") === "media") {
      const auto = sel === ":root" ? ':root:not([data-theme="light"])' : `${sel}:not([data-theme="light"])`;
      out.push(`@media (prefers-color-scheme: dark) {\n${block(w(auto), theme.dark, "dark")}\n}`);
      // A light subtree inside a dark page (or a system-dark root) pins light again.
      out.push(block(w(light), theme.light, "light"));
    }
    out.push(block(w(pinned), theme.dark, "dark"));
  }
  return out.join("\n");
}

/** A theme scheme as an inline `style` object (a themed subtree without a stylesheet). */
export function themeStyle(theme: Theme, scheme: Scheme = "light"): Record<string, string> {
  return { ...((scheme === "dark" ? theme.dark : null) ?? theme.light), colorScheme: scheme };
}
