/**
 * Minimal colour parsing and WCAG contrast. Used to pick readable text on a
 * host-provided accent (inherit mode, `colorPrimary`) and by the contrast
 * test over the shipped tokens. Formats a browser can hand back from
 * `getComputedStyle` and that people write in config: hex, rgb(a), hsl(a),
 * and shadcn-style bare HSL triplets (`222 47% 11%`). Anything else (oklch,
 * `var()`) returns null and callers keep their default.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expand = hex.length <= 4 ? hex.split("").map((c) => c + c).join("") : hex;
    if (expand.length !== 6 && expand.length !== 8) return null;
    const n = (i: number) => parseInt(expand.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: expand.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  const body = fn ? (fn[2] as string) : /^[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/.test(s) ? s : null;
  if (body === null) return null;
  const kind = fn ? (fn[1] as string).slice(0, 3) : "hsl";
  const parts = body.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const alpha = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
  if (kind === "rgb") {
    const ch = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const [r, g, b] = [ch(parts[0] as string), ch(parts[1] as string), ch(parts[2] as string)];
    if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alpha };
  }
  const h = parseFloat(parts[0] as string);
  const sat = parseFloat(parts[1] as string) / 100;
  const l = parseFloat(parts[2] as string) / 100;
  if (![h, sat, l].every(Number.isFinite)) return null;
  return { ...hslToRgb(h, sat, l), a: alpha };
}

function parseAlpha(p: string): number {
  const v = p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
}

const clamp255 = (v: number) => Math.min(Math.max(Math.round(v), 0), 255);

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return { r: clamp255(l * 255), g: clamp255(l * 255), b: clamp255(l * 255) };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const t = (x: number) => {
    let v = x;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return { r: clamp255(t(hh + 1 / 3) * 255), g: clamp255(t(hh) * 255), b: clamp255(t(hh - 1 / 3) * 255) };
}

export function toHex(c: Rgba): string {
  const h = (v: number) => clamp255(v).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** WCAG 2.x relative luminance. */
export function luminance(c: Rgba): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** Composite `fg` (possibly translucent) over an opaque `bg`. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

export function contrastRatio(a: string | Rgba, b: string | Rgba): number {
  const ca = typeof a === "string" ? parseColor(a) : a;
  const cb = typeof b === "string" ? parseColor(b) : b;
  if (!ca || !cb) return 0;
  const bg = cb.a < 1 ? over(cb, { r: 255, g: 255, b: 255, a: 1 }) : cb;
  const fg = ca.a < 1 ? over(ca, bg) : ca;
  const la = luminance(fg);
  const lb = luminance(bg);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black-ish or white text, whichever reads better on `bg`. */
export function readableOn(bg: string, dark = "#18181b", light = "#ffffff"): string {
  return contrastRatio(dark, bg) >= contrastRatio(light, bg) ? dark : light;
}

export function isDark(color: string | null | undefined): boolean | null {
  const c = parseColor(color);
  if (!c || c.a < 0.5) return null;
  return luminance(c) < 0.2;
}

/** Normalise a colour for CSS output: bare HSL triplets become `hsl(...)`; others pass through. */
export function cssColor(input: string): string {
  const s = input.trim();
  if (/^[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%/.test(s)) return `hsl(${s})`;
  return s;
}
