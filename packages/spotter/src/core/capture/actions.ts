/**
 * User-action breadcrumbs: clicks, input changes (never values), scrolls and
 * focus, each with a CSS selector and a short redacted label.
 *
 * Also derives the frustration signals Console turns into suggested issues
 * and heatmaps:
 * - rage click: ≥ 3 clicks within 1 s within ~30 px;
 * - dead click: a click on something clickable with no DOM mutation and no
 *   network request within 1 s;
 * - error click: an uncaught error within 1 s after a click.
 * Each carries `{ x, y, pageX, pageY, docWidth, docHeight }` so Console can
 * place it on a page-relative heatmap.
 *
 * Events inside Spotter's own UI (`[data-spotter-ui]`, through shadow roots)
 * are ignored.
 */
import type { Breadcrumb, Json } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { cssSelector } from "../selector.ts";
import { truncate } from "../serialize.ts";
import { eventTarget, fromSpotterUi, isTextMasked, maskRules, safeClosest, UI_ATTR } from "./mask.ts";
import { onNetworkActivity } from "./network.ts";
import { hasDom, iso, listen } from "./util.ts";

const RAGE_COUNT = 3;
const RAGE_WINDOW_MS = 1000;
const RAGE_RADIUS_PX = 30;
const DEAD_WINDOW_MS = 1000;
const ERROR_WINDOW_MS = 1000;
const SCROLL_SETTLE_MS = 400;
const INPUT_REPEAT_MS = 1000;

/** What counts as "meant to do something" for dead-click detection. */
const ACTIONABLE =
  'button:not([disabled]),[role="button"],[role="link"],[role="menuitem"],[role="tab"],input[type="submit"],input[type="button"],input[type="reset"],input[type="image"],a[href],summary';

/** Where to anchor a click's label and selector: the nearest meaningful ancestor. */
const INTERESTING = `${ACTIONABLE},input,select,textarea,label,[onclick],[tabindex]`;

export interface ClickPoint {
  x: number;
  y: number;
  pageX: number;
  pageY: number;
  docWidth: number;
  docHeight: number;
}

/** Pure rage-click check over recent clicks (time, x, y), newest last. */
export function isRageBurst(clicks: readonly { t: number; x: number; y: number }[], now: number): boolean {
  const last = clicks[clicks.length - 1];
  if (!last) return false;
  let n = 0;
  for (const c of clicks) {
    if (now - c.t <= RAGE_WINDOW_MS && Math.hypot(c.x - last.x, c.y - last.y) <= RAGE_RADIUS_PX) n++;
  }
  return n >= RAGE_COUNT;
}

export function installActions(rt: Runtime, _opts: Record<string, never> = {}): Signal<void> {
  const undo: (() => void)[] = [];
  let active = true;
  const rules = maskRules(rt.config.privacy);

  const fault = (error: unknown) => {
    if (!active) return;
    active = false;
    try {
      rt.fault("actions", error);
    } catch {
      /* never throw into the host */
    }
    cleanup();
  };

  const crumb = (c: Omit<Breadcrumb, "at">) => rt.breadcrumb({ at: iso(rt.now()), ...c });

  /** Short visible label for an element, redacted; empty when its text is masked. */
  const labelOf = (el: Element): string => {
    try {
      const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt");
      let text = aria ?? "";
      if (!text) {
        if (el.localName === "input") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          // Button-like inputs show their value as a label; every other input's value is private.
          text = ["submit", "button", "reset"].includes(type) ? (el as HTMLInputElement).value : el.getAttribute("placeholder") || el.getAttribute("name") || "";
        } else if (el.localName === "select" || el.localName === "textarea") {
          text = el.getAttribute("name") || el.getAttribute("placeholder") || "";
        } else if (!isTextMasked(el, rules)) {
          text = el.textContent ?? "";
        }
      }
      text = text.replace(/\s+/g, " ").trim();
      return text ? truncate(rt.redact(text, "breadcrumb"), 60) : "";
    } catch {
      return "";
    }
  };

  const pointOf = (e: MouseEvent): ClickPoint => {
    const doc = document.documentElement;
    return {
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      pageX: Math.round(e.pageX ?? e.clientX + window.scrollX),
      pageY: Math.round(e.pageY ?? e.clientY + window.scrollY),
      docWidth: Math.max(doc.scrollWidth, doc.clientWidth),
      docHeight: Math.max(doc.scrollHeight, doc.clientHeight),
    };
  };

  // -- clicks, rage / dead / error clicks ----------------------------------------------------

  const recent: { t: number; x: number; y: number }[] = [];
  let rageFiredAt = 0;
  let lastClick: { t: number; selector: string; label: string; point: ClickPoint; errored: boolean } | null = null;
  let observer: MutationObserver | null = null;
  let deadTimer: ReturnType<typeof setTimeout> | null = null;
  let deadPending: { selector: string; label: string; point: ClickPoint } | null = null;

  const resolveDead = () => {
    deadPending = null;
    if (deadTimer) clearTimeout(deadTimer);
    deadTimer = null;
    observer?.disconnect();
  };

  const watchDead = (el: Element, selector: string, label: string, point: ClickPoint) => {
    resolveDead();
    const link = el.closest("a[href]");
    if (link) {
      const href = link.getAttribute("href") || "";
      // New tabs, downloads and in-page anchors legitimately change nothing here.
      if (href.startsWith("#") || link.getAttribute("target") === "_blank" || link.hasAttribute("download") || /^(mailto|tel|sms):/i.test(href)) return;
    }
    if (typeof MutationObserver === "undefined") return;
    deadPending = { selector, label, point };
    if (!observer) {
      observer = new MutationObserver((records) => {
        // Spotter's own UI changing is not a response to the click.
        for (const r of records) {
          const node = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as Element | null;
          if (!node || !safeClosest(node, `[${UI_ATTR}]`)) {
            resolveDead();
            return;
          }
        }
      });
    }
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    deadTimer = setTimeout(() => {
      const p = deadPending;
      resolveDead();
      if (!p || !active || document.visibilityState === "hidden") return;
      crumb({
        category: "dead_click",
        level: "warning",
        message: `Dead click on ${p.label ? `"${p.label}"` : p.selector}`,
        selector: p.selector,
        data: p.point as unknown as Record<string, Json>,
      });
    }, DEAD_WINDOW_MS);
  };

  const onClick = (event: Event) => {
    if (!active) return;
    try {
      if (fromSpotterUi(event)) return;
      const target = eventTarget(event);
      if (!target) return;
      const el = safeClosest(target, INTERESTING) ?? target;
      const selector = cssSelector(el);
      const label = labelOf(el);
      const point = pointOf(event as MouseEvent);
      const now = rt.now();
      crumb({
        category: "click",
        level: "info",
        message: label ? `Clicked "${label}"` : `Clicked ${selector}`,
        selector,
        data: point as unknown as Record<string, Json>,
      });

      recent.push({ t: now, x: point.x, y: point.y });
      while (recent.length && now - (recent[0]?.t ?? now) > RAGE_WINDOW_MS) recent.shift();
      if (isRageBurst(recent, now) && now - rageFiredAt > RAGE_WINDOW_MS) {
        rageFiredAt = now;
        crumb({
          category: "rage_click",
          level: "warning",
          message: `Rage click on ${label ? `"${label}"` : selector}`,
          selector,
          data: { ...point, count: recent.length } as unknown as Record<string, Json>,
        });
      } else if (rageFiredAt && now - rageFiredAt <= RAGE_WINDOW_MS) {
        rageFiredAt = now; // still the same burst: extend it, don't fire again
      }

      lastClick = { t: now, selector, label, point, errored: false };
      const actionable = safeClosest(target, ACTIONABLE);
      if (actionable) watchDead(actionable, selector, label, point);
      else resolveDead();
    } catch (error) {
      fault(error);
    }
  };

  const onError = () => {
    if (!active || !lastClick || lastClick.errored) return;
    try {
      if (rt.now() - lastClick.t > ERROR_WINDOW_MS) return;
      lastClick.errored = true;
      crumb({
        category: "error_click",
        level: "error",
        message: `Error after click on ${lastClick.label ? `"${lastClick.label}"` : lastClick.selector}`,
        selector: lastClick.selector,
        data: lastClick.point as unknown as Record<string, Json>,
      });
    } catch (error) {
      fault(error);
    }
  };

  // -- inputs (values never recorded) -----------------------------------------------------------

  const lastInput = new WeakMap<Element, number>();
  const onInput = (event: Event) => {
    if (!active) return;
    try {
      if (fromSpotterUi(event)) return;
      const el = eventTarget(event);
      if (!el) return;
      const tag = el.localName;
      const editable = (el as HTMLElement).isContentEditable;
      if (tag !== "input" && tag !== "select" && tag !== "textarea" && !editable) return;
      const now = rt.now();
      const prev = lastInput.get(el);
      lastInput.set(el, now);
      // One breadcrumb per burst of typing, not per keystroke (and not again for the `change` that follows).
      if (prev !== undefined && now - prev < INPUT_REPEAT_MS) return;
      const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : editable ? "contenteditable" : tag;
      const selector = cssSelector(el);
      const label = labelOf(el);
      crumb({
        category: "input",
        level: "info",
        message: `Changed ${type} ${label ? `"${label}"` : selector}`,
        selector,
        data: { type },
      });
    } catch (error) {
      fault(error);
    }
  };

  // -- focus (form fields only, to keep noise down) ------------------------------------------------

  const onFocus = (event: Event) => {
    if (!active) return;
    try {
      if (fromSpotterUi(event)) return;
      const el = eventTarget(event);
      if (!el || !/^(input|select|textarea)$/.test(el.localName)) return;
      const selector = cssSelector(el);
      const label = labelOf(el);
      crumb({ category: "focus", level: "debug", message: `Focused ${label ? `"${label}"` : selector}`, selector });
    } catch (error) {
      fault(error);
    }
  };

  // -- scroll (settled position only) -------------------------------------------------------------

  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  const onScroll = (event: Event) => {
    if (!active) return;
    if (event.target !== document && event.target !== window) return; // page scroll only
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (!active) return;
      try {
        const doc = document.documentElement;
        const max = Math.max(1, doc.scrollHeight - window.innerHeight);
        const depth = Math.min(100, Math.round((window.scrollY / max) * 100));
        crumb({
          category: "scroll",
          level: "debug",
          message: `Scrolled to ${depth}%`,
          data: { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), depth },
        });
      } catch (error) {
        fault(error);
      }
    }, SCROLL_SETTLE_MS);
  };

  const cleanup = () => {
    for (const fn of undo.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    resolveDead();
    observer = null;
    if (scrollTimer) clearTimeout(scrollTimer);
  };

  if (hasDom()) {
    const opts = { capture: true, passive: true };
    undo.push(listen(document, "click", onClick, opts));
    undo.push(listen(document, "input", onInput, opts));
    undo.push(listen(document, "change", onInput, opts));
    undo.push(listen(document, "focusin", onFocus, opts));
    undo.push(listen(document, "scroll", onScroll, opts));
    undo.push(listen(window, "error", onError, opts));
    undo.push(listen(window, "unhandledrejection", onError, opts));
    undo.push(
      onNetworkActivity(() => {
        if (deadPending) resolveDead();
      }),
    );
  }

  return {
    name: "actions",
    snapshot: () => undefined,
    destroy() {
      active = false;
      cleanup();
    },
  };
}
