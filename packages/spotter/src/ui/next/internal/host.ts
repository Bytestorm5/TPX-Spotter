/**
 * The widget's DOM home: one `<div data-spotter-ui>` at the end of `<body>`
 * with an open shadow root, so host CSS can't leak in and ours can't leak
 * out. `data-spotter-ui` also tells screenshot and replay capture to leave it
 * out. Created lazily (after idle), never at import time.
 *
 * Styles go in as constructable stylesheets (`adoptedStyleSheets`), which a
 * strict CSP allows without `'unsafe-inline'`; where those are missing a
 * `<style nonce>` is used. Unstyled mode renders into the light DOM with no
 * CSS at all, so Tailwind or the host's own classes reach every part.
 */

import { peekUiRoot, setUiRoot, type UiRoot } from "./root-ref.ts";

export { peekUiRoot, type UiRoot };

const sheets = new Map<string, CSSStyleSheet | HTMLStyleElement>();

/**
 * `:host` resets win over any page rule (important declarations from the
 * inner context beat the outer one), so `body > div { padding: 2rem }` or
 * `* { color: red !important }` can't touch the host.
 */
const HOST_RESET = ":host{all:initial!important;display:contents!important}";

export function getUiRoot(options: { unstyled?: boolean; nonce?: string } = {}): UiRoot {
  const existing = peekUiRoot();
  if (existing) return existing;
  const host = document.createElement("div");
  host.setAttribute("data-spotter-ui", "");
  document.body.appendChild(host);
  let shadow: ShadowRoot | null = null;
  let container: HTMLElement;
  if (options.unstyled || typeof host.attachShadow !== "function") {
    container = host;
  } else {
    shadow = host.attachShadow({ mode: "open" });
    container = document.createElement("div");
    container.className = "sp-root";
    shadow.appendChild(container);
  }
  setUiRoot({ host, shadow, container });
  sheets.clear();
  if (shadow) setCss("reset", HOST_RESET, options.nonce);
  return root;
}

function supportsAdopted(shadow: ShadowRoot): boolean {
  try {
    return "adoptedStyleSheets" in shadow && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype;
  } catch {
    return false;
  }
}

/**
 * Install or replace one named stylesheet in the shadow root. Order of first
 * insertion is cascade order (reset → trigger → panel → theme).
 */
export function setCss(id: string, css: string, nonce?: string): void {
  const r = peekUiRoot();
  if (!r || !r.shadow) return;
  const existing = sheets.get(id);
  if (supportsAdopted(r.shadow)) {
    let sheet = existing as CSSStyleSheet | undefined;
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheets.set(id, sheet);
      r.shadow.adoptedStyleSheets = [...r.shadow.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(css);
    return;
  }
  let el = existing as HTMLStyleElement | undefined;
  if (!el) {
    el = document.createElement("style");
    if (nonce) el.nonce = nonce;
    el.setAttribute("data-spotter-style", id);
    r.shadow.insertBefore(el, r.container);
    sheets.set(id, el);
  }
  el.textContent = css;
}

export function hasCss(id: string): boolean {
  return sheets.has(id);
}

