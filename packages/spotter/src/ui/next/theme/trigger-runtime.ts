/**
 * What the floating trigger needs to render correctly on first paint:
 * resolved theme, trigger CSS and the localized label. Loaded after idle as
 * its own chunk, so none of it is in the initial bundle.
 */
import type { Appearance } from "../../../core/schema.ts";
import { getUiRoot, hasCss, setCss } from "../internal/host.ts";
import { createTranslator, detectLocale, isRtl, loadMessages, type Translate } from "../locales/index.ts";
import { themeStylesheet, watchScheme } from "./runtime.ts";
import { TRIGGER_CSS } from "./trigger-css.ts";

export interface TriggerRuntime {
  scheme: "light" | "dark";
  locale: string;
  dir: "ltr" | "rtl";
  t: Translate;
  dispose(): void;
}

/** Install (or refresh) the theme sheet; call again when appearance changes. */
export function installTheme(appearance: Appearance | undefined, nonce: string | undefined): "light" | "dark" {
  const { css, theme } = themeStylesheet(appearance);
  setCss("theme", css, nonce);
  return theme.scheme;
}

export interface RuntimeOptions {
  appearance?: Appearance;
  locale?: string;
  localization?: Record<string, string>;
  nonce?: string;
}

let shared: Promise<TriggerRuntime> | null = null;

/**
 * The page-wide runtime, created once (trigger and panel share it). Also
 * creates the UI root and stamps `dir`, `lang` and `data-scheme` on it.
 */
export function ensureRuntime(opts: RuntimeOptions): Promise<TriggerRuntime> {
  shared ??= loadTriggerRuntime(opts);
  return shared;
}

async function loadTriggerRuntime(opts: RuntimeOptions): Promise<TriggerRuntime> {
  const unstyled = opts.appearance?.mode === "unstyled";
  const root = getUiRoot({ unstyled, nonce: opts.nonce });
  let scheme: "light" | "dark" = "light";
  let stop = () => {};
  if (!unstyled) {
    if (!hasCss("trigger")) setCss("trigger", TRIGGER_CSS, opts.nonce);
    scheme = installTheme(opts.appearance, opts.nonce);
    if ((opts.appearance?.theme ?? "auto") === "auto") {
      stop = watchScheme(() => {
        const next = installTheme(opts.appearance, opts.nonce);
        root.container.setAttribute("data-scheme", next);
      });
    }
  }
  const locale = detectLocale(opts.locale);
  const messages = await loadMessages(locale);
  const dir = isRtl(locale) ? "rtl" : "ltr";
  root.container.setAttribute("dir", dir);
  root.container.setAttribute("lang", locale);
  root.container.setAttribute("data-scheme", scheme);
  return {
    scheme,
    locale,
    dir,
    t: createTranslator(messages, opts.localization),
    dispose: stop,
  };
}
