/**
 * What the floating trigger needs to render correctly on first paint:
 * resolved theme, trigger CSS and the localized label. Loaded after idle as
 * its own chunk, so none of it is in the initial bundle.
 */
import type { Appearance } from "../../../core/schema.ts";
import { hasCss, setCss } from "../internal/host.ts";
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

export async function loadTriggerRuntime(opts: {
  appearance?: Appearance;
  locale?: string;
  localization?: Record<string, string>;
  nonce?: string;
  onScheme?: (scheme: "light" | "dark") => void;
}): Promise<TriggerRuntime> {
  const unstyled = opts.appearance?.mode === "unstyled";
  let scheme: "light" | "dark" = "light";
  let stop = () => {};
  if (!unstyled) {
    if (!hasCss("trigger")) setCss("trigger", TRIGGER_CSS, opts.nonce);
    scheme = installTheme(opts.appearance, opts.nonce);
    if ((opts.appearance?.theme ?? "auto") === "auto") {
      stop = watchScheme(() => {
        const next = installTheme(opts.appearance, opts.nonce);
        opts.onScheme?.(next);
      });
    }
  }
  const locale = detectLocale(opts.locale);
  const messages = await loadMessages(locale);
  return {
    scheme,
    locale,
    dir: isRtl(locale) ? "rtl" : "ltr",
    t: createTranslator(messages, opts.localization),
    dispose: stop,
  };
}
