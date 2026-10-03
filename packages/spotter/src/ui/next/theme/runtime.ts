/**
 * Theme resolution against the live page: which scheme the host is in, and
 * what inherit mode reads from it. Loaded at idle with the trigger (never in
 * the initial bundle) and re-run when the host flips theme.
 *
 * Scheme ("auto"): a host-declared theme wins — `data-theme` / `data-mode` /
 * `class="dark"` / `color-scheme` on `<html>` or `<body>` — then the actual
 * page background, then `prefers-color-scheme`. Checking the painted
 * background first means a light-only site shown to a dark-OS visitor gets a
 * light widget, which is what "native" means.
 */
import type { Appearance } from "../../../core/schema.ts";
import { isDark, parseColor } from "./color.ts";
import { resolveTheme, themeCss, type Inherited, type ResolvedTheme, type Scheme } from "./tokens.ts";

const ACCENT_PROPS = ["--primary", "--accent", "--brand", "--color-primary", "--color-accent", "--brand-color", "--theme-color"];

function hostDeclaredScheme(): Scheme | null {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const attr = (el.getAttribute("data-theme") ?? el.getAttribute("data-mode") ?? el.getAttribute("data-color-scheme") ?? "").toLowerCase();
    if (attr.includes("dark")) return "dark";
    if (attr.includes("light")) return "light";
    if (el.classList.contains("dark")) return "dark";
    if (el.classList.contains("light")) return "light";
    const cs = el.style.colorScheme?.toLowerCase();
    if (cs === "dark" || cs === "light") return cs;
  }
  return null;
}

function paintedBackground(): string | null {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    const c = parseColor(bg);
    if (c && c.a > 0.5) return bg;
  }
  return null;
}

export function detectScheme(theme: Appearance["theme"] = "auto"): Scheme {
  if (theme === "light" || theme === "dark") return theme;
  const declared = hostDeclaredScheme();
  if (declared) return declared;
  const dark = isDark(paintedBackground());
  if (dark !== null) return dark ? "dark" : "light";
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Read the host's font, body text colour and accent custom property. */
export function readInherited(): Inherited {
  const out: Inherited = {};
  try {
    const body = getComputedStyle(document.body);
    if (body.fontFamily) out.fontFamily = body.fontFamily;
    if (body.color) out.color = body.color;
    const root = getComputedStyle(document.documentElement);
    for (const p of ACCENT_PROPS) {
      const v = (root.getPropertyValue(p) || body.getPropertyValue(p)).trim();
      if (v) {
        out.accent = v;
        break;
      }
    }
  } catch {
    /* detached document in tests */
  }
  return out;
}

export function computeTheme(appearance: Appearance | undefined): ResolvedTheme {
  const scheme = detectScheme(appearance?.theme);
  const inherit = (appearance?.mode ?? "inherit") === "inherit";
  return resolveTheme(appearance, scheme, inherit ? readInherited() : null);
}

export function themeStylesheet(appearance: Appearance | undefined): { css: string; theme: ResolvedTheme } {
  const theme = computeTheme(appearance);
  return { css: themeCss(theme), theme };
}

/** What on `<html>` / `<body>` can declare or paint a scheme — attribute and inline-style reads only, no style recalc. */
function schemeInputs(): string {
  let key = "";
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    key += `${el.getAttribute("class")}|${el.getAttribute("data-theme")}|${el.getAttribute("data-mode")}|${el.getAttribute("data-color-scheme")}|`;
    key += `${el.style.colorScheme}|${el.style.backgroundColor}|${el.style.background}#`;
  }
  return key;
}

/**
 * Call `fn` when the host's scheme may have changed (OS setting, theme toggle).
 * Attribute churn that can't change it (a scroll lock's `overflow` / padding
 * on `<body>`, an unrelated inline style) is ignored, and real changes are
 * coalesced and handled after the next paint, never inside the host's own
 * interaction.
 */
export function watchScheme(fn: () => void): () => void {
  let mq: MediaQueryList | null = null;
  try {
    mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", fn);
  } catch {
    mq = null;
  }
  let last = schemeInputs();
  let pending = false;
  let stopped = false;
  const mo = new MutationObserver(() => {
    if (pending) return;
    const key = schemeInputs();
    if (key === last) return;
    last = key;
    pending = true;
    requestAnimationFrame(() =>
      setTimeout(() => {
        pending = false;
        if (!stopped) fn();
      }),
    );
  });
  const opts = { attributes: true, attributeFilter: ["class", "data-theme", "data-mode", "data-color-scheme", "style"] };
  mo.observe(document.documentElement, opts);
  if (document.body) mo.observe(document.body, opts);
  return () => {
    stopped = true;
    mq?.removeEventListener("change", fn);
    mo.disconnect();
  };
}
