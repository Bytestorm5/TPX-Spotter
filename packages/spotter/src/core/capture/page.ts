/**
 * Page state for a report: the selected element's selector, a redacted DOM
 * excerpt around it, the visible text near it, and (as an artifact) a full
 * masked DOM snapshot.
 *
 * All of it is produced by walking the live DOM and emitting strings — never
 * by cloning (cloning custom elements runs their constructors) and never by
 * mutating the page. Input values are always stripped, masked text becomes
 * same-length placeholders, blocked elements become empty boxes, scripts and
 * event-handler attributes are dropped, and URLs and text are redacted.
 */
import type { PageInfo } from "../schema.ts";
import type { Runtime } from "../internal.ts";
import { cssSelector } from "../selector.ts";
import { truncate, utf8Length } from "../serialize.ts";
import { isBlocked, isTextMasked, maskRules, placeholder, safeMatches, UI_ATTR, type MaskRules } from "./mask.ts";
import { hasDom } from "./util.ts";

const EXCERPT_BYTES = 8 * 1024;
const NEARBY_BYTES = 2 * 1024;
const SNAPSHOT_BYTES = 2 * 1024 * 1024;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP = new Set(["script", "noscript", "template", "object", "embed", "applet"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "background", "xlink:href"]);
const TEXT_ATTRS = new Set(["alt", "title", "placeholder", "aria-label", "aria-description", "aria-valuetext", "label", "content"]);
const DROP_ATTRS = new Set(["srcdoc", "srcset", "selected", "checked", "nonce", "integrity", "ping"]);
const BUTTON_TYPES = new Set(["submit", "button", "reset", "image"]);

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

export interface DomSerializeOptions {
  mode: "excerpt" | "snapshot";
  maxBytes: number;
  /** Marked with `data-spotter-target` in the output. */
  target?: Element;
}

/**
 * Serialize a subtree into masked, redacted HTML. Bounded by `maxBytes`
 * (approximate, UTF-16 length) — the output ends with a truncation comment
 * when the budget runs out.
 */
export function serializeDom(root: Node, rt: Runtime, rules: MaskRules, opts: DomSerializeOptions): string {
  const out: string[] = [];
  let size = 0;
  let full = false;
  const emit = (s: string) => {
    if (full) return;
    if (size + s.length > opts.maxBytes) {
      full = true;
      out.push("<!-- truncated -->");
      return;
    }
    out.push(s);
    size += s.length;
  };
  const text = (s: string) => rt.redact(s, "text");

  const attrs = (el: Element, masked: boolean): string => {
    let s = "";
    const tag = el.localName;
    const inputType = (el.getAttribute("type") || "").toLowerCase();
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      let value = attr.value;
      if (name.startsWith("on") || DROP_ATTRS.has(name)) continue;
      if (name === "value" && (tag === "textarea" || tag === "select" || (tag === "input" && !BUTTON_TYPES.has(inputType)))) continue;
      if (name === "style" && opts.mode === "excerpt") continue;
      if (URL_ATTRS.has(name)) {
        if (/^\s*(javascript|data):/i.test(value)) value = value.trim().slice(0, value.indexOf(":") + 1);
        else value = rt.redactUrl(value);
      } else if (TEXT_ATTRS.has(name) || name === "value") {
        value = masked ? placeholder(value) : text(value);
      } else if (name !== "class" && name !== "id" && name !== "style" && name !== "type" && name !== "role") {
        value = text(value);
      }
      s += ` ${name}="${escapeAttr(truncate(value, 500))}"`;
    }
    if (opts.target === el) s += ' data-spotter-target=""';
    return s;
  };

  const walk = (node: Node, depth: number) => {
    if (full) return;
    if (depth > 200) return;
    if (node.nodeType === 3) {
      const data = (node as Text).data;
      if (!data) return;
      const parent = node.parentElement;
      const pTag = parent?.localName;
      if (pTag === "textarea") return; // a textarea's text is its value
      if (pTag === "style") {
        if (opts.mode === "snapshot") emit(truncate(data, 64 * 1024));
        return;
      }
      if (!data.trim()) {
        emit(data.length > 1 ? " " : data);
        return;
      }
      emit(escapeText(isTextMasked(parent, rules) ? placeholder(data) : text(data)));
      return;
    }
    if (node.nodeType === 9) {
      if (opts.mode === "snapshot") emit("<!DOCTYPE html>");
      const docEl = (node as Document).documentElement;
      if (docEl) walk(docEl, depth + 1);
      return;
    }
    if (node.nodeType === 11) {
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c, depth + 1);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName;
    if (SKIP.has(tag)) return;
    if (el.hasAttribute(UI_ATTR)) return;
    if (opts.mode === "excerpt" && (tag === "style" || tag === "link" || tag === "meta" || tag === "head")) return;
    if (tag === "link" && !/stylesheet|icon/i.test(el.getAttribute("rel") || "")) return;

    if (safeMatches(el, rules.block)) {
      let box = "";
      try {
        const r = el.getBoundingClientRect();
        box = ` style="display:inline-block;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:#ccc"`;
      } catch {
        /* no layout */
      }
      emit(`<${tag} data-spotter-blocked=""${box}></${tag}>`);
      return;
    }
    const masked = isTextMasked(el, rules);
    emit(`<${tag}${attrs(el, masked)}>`);
    if (VOID.has(tag)) return;
    if (tag === "iframe") {
      emit(`</${tag}>`);
      return;
    }
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
      emit('<template shadowrootmode="open">');
      for (let c = shadow.firstChild; c; c = c.nextSibling) walk(c, depth + 1);
      emit("</template>");
    }
    // (For a select, option labels are the app's; which one is chosen — `selected` — was dropped above.)
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c, depth + 1);
    emit(`</${tag}>`);
  };

  try {
    walk(root, 0);
  } catch {
    emit("<!-- serialization failed -->");
  }
  return out.join("");
}

/** Visible, masked, redacted text in and around `el`, up to `max` chars. */
function textNear(el: Element, rt: Runtime, rules: MaskRules, max: number): string {
  // Climb until there is enough context to be useful, but not to the whole page.
  let scope: Element = el;
  while (scope.parentElement && scope.parentElement.localName !== "body" && scope.localName !== "body" && (scope.textContent?.length ?? 0) < 300) {
    scope = scope.parentElement;
  }
  const parts: string[] = [];
  let size = 0;
  const walk = (node: Node) => {
    if (size >= max) return;
    if (node.nodeType === 3) {
      const t = (node as Text).data.replace(/\s+/g, " ").trim();
      if (!t) return;
      const parent = node.parentElement;
      const s = isTextMasked(parent, rules) ? placeholder(t) : t;
      parts.push(s);
      size += s.length + 1;
      return;
    }
    if (node.nodeType !== 1) return;
    const e = node as Element;
    if (SKIP.has(e.localName) || e.localName === "style" || e.localName === "textarea" || e.localName === "select") return;
    if (e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true" || isBlocked(e, rules)) return;
    const cv = (e as Element & { checkVisibility?: () => boolean }).checkVisibility;
    if (typeof cv === "function" && !cv.call(e)) return;
    for (let c = e.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(scope);
  return truncate(rt.redact(parts.join(" "), "text"), max);
}

/**
 * Page facts for a report about an element or a point: its selector, a DOM
 * excerpt (≤ 8 KB) with the element marked, and the visible text near it
 * (≤ 2 KB). Without an element or point, only url/title/referrer.
 */
export function collectPage(rt: Runtime, opts?: { element?: Element; point?: { x: number; y: number } }): Partial<PageInfo> {
  const page: Partial<PageInfo> = {};
  if (!hasDom()) return page;
  try {
    page.url = rt.redactUrl(location.href);
    if (document.title) page.title = truncate(rt.redact(document.title, "text"), 300);
    if (document.referrer) page.referrer = rt.redactUrl(document.referrer);
  } catch {
    /* sandboxed */
  }
  let el: Element | null = opts?.element ?? null;
  if (!el && opts?.point) {
    try {
      el = document.elementFromPoint(opts.point.x, opts.point.y);
    } catch {
      el = null;
    }
  }
  if (!el || el.closest(`[${UI_ATTR}]`)) return page;
  try {
    const rules = maskRules(rt.config.privacy);
    page.selector = cssSelector(el);
    // Widen the excerpt to the parent / grandparent while it stays small.
    let scope: Element = el;
    let html = serializeDom(el, rt, rules, { mode: "excerpt", maxBytes: EXCERPT_BYTES, target: el });
    for (let i = 0; i < 2; i++) {
      const parent: Element | null = scope.parentElement;
      if (!parent || parent.localName === "body" || parent.localName === "html" || utf8Length(html) > 2048) break;
      const wider = serializeDom(parent, rt, rules, { mode: "excerpt", maxBytes: EXCERPT_BYTES, target: el });
      if (wider.endsWith("<!-- truncated -->")) break;
      html = wider;
      scope = parent;
    }
    page.domExcerpt = html;
    page.nearbyText = textNear(el, rt, rules, NEARBY_BYTES);
  } catch {
    /* leave what we have */
  }
  return page;
}

/**
 * The `dom_snapshot` artifact: the whole document serialized with the same
 * masking (scripts removed, inputs stripped, masked text replaced, blocked
 * elements boxed, Spotter's UI left out). Stylesheet links and inline styles
 * are kept so it renders roughly like the page.
 */
export function domSnapshot(rt: Runtime, opts?: { root?: Node; maxBytes?: number }): string {
  if (!hasDom()) return "";
  const rules = maskRules(rt.config.privacy);
  return serializeDom(opts?.root ?? document, rt, rules, { mode: "snapshot", maxBytes: opts?.maxBytes ?? SNAPSHOT_BYTES });
}

