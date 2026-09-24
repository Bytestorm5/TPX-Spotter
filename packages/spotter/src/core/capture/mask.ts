/**
 * The DOM privacy rules shared by every capture path that sees page content
 * (breadcrumb labels, DOM excerpts and snapshots, the screenshot, replay), so
 * `data-spotter-mask` means the same thing everywhere:
 *
 * - `data-spotter-mask` (+ `privacy.maskSelectors`): text replaced by
 *   same-length placeholders.
 * - `data-spotter-block` (+ `privacy.blockSelectors`): not captured at all;
 *   rendered as a placeholder box.
 * - `data-spotter-unmask`: opt text back in under `maskText: "all"`, or under
 *   a masked ancestor. The nearest of mask / unmask wins.
 * - `data-spotter-ui`: Spotter's own UI, never captured.
 *
 * Input values are never captured by the always-on paths, whatever the
 * config; password values are never captured by any path.
 */
import type { MaskText, PrivacyConfig } from "../types.ts";

export const MASK_ATTR = "data-spotter-mask";
export const BLOCK_ATTR = "data-spotter-block";
export const UNMASK_ATTR = "data-spotter-unmask";
export const UI_ATTR = "data-spotter-ui";

/** Drop selectors the engine can't parse, so one typo in config can't disable masking wholesale. */
export function validSelectors(selectors: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const s of selectors ?? []) {
    if (typeof s !== "string" || !s.trim()) continue;
    try {
      if (typeof document !== "undefined") document.createDocumentFragment().querySelector(s);
      out.push(s);
    } catch {
      /* invalid selector: skip */
    }
  }
  return out;
}

export interface MaskRules {
  maskText: MaskText;
  /** Joined selector list for masked text (always includes `[data-spotter-mask]`). */
  mask: string;
  /** Joined selector list for blocked elements (always includes `[data-spotter-block]` and `[data-spotter-ui]`). */
  block: string;
}

export function maskRules(privacy: PrivacyConfig | undefined): MaskRules {
  return {
    maskText: privacy?.maskText ?? "inputs",
    mask: [`[${MASK_ATTR}]`, ...validSelectors(privacy?.maskSelectors)].join(","),
    block: [`[${BLOCK_ATTR}]`, `[${UI_ATTR}]`, ...validSelectors(privacy?.blockSelectors)].join(","),
  };
}

export function safeClosest(el: Element | null | undefined, selector: string): Element | null {
  if (!el) return null;
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

export function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Whether the text of `el` must be masked: the nearest of a mask match and
 * an unmask ancestor wins; with neither, `maskText: "all"` masks.
 */
export function isTextMasked(el: Element | null, rules: Pick<MaskRules, "maskText" | "mask">): boolean {
  if (!el) return rules.maskText === "all";
  const masked = safeClosest(el, rules.mask);
  const unmasked = safeClosest(el, `[${UNMASK_ATTR}]`);
  // Both on the same element: mask wins (the safe reading).
  if (masked && unmasked) return unmasked.contains(masked);
  if (masked) return true;
  if (unmasked) return false;
  return rules.maskText === "all";
}

export function isBlocked(el: Element | null, rules: Pick<MaskRules, "block">): boolean {
  return !!safeClosest(el, rules.block);
}

/** Same-length placeholder: whitespace kept so layout and word shapes survive. */
export function placeholder(text: string, char = "*"): string {
  return text.replace(/\S/g, char);
}

/** Password, one-time-code and card inputs: their values are never captured, even under unmask. */
export function isSensitiveInput(el: Element): boolean {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password") return true;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  return /\b(cc-|one-time-code|current-password|new-password)/.test(ac);
}

/** Whether an event came from inside Spotter's own UI (through shadow roots, via the composed path). */
export function fromSpotterUi(event: Event): boolean {
  try {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      const el = node as Element;
      if (el && el.nodeType === 1 && typeof el.hasAttribute === "function" && el.hasAttribute(UI_ATTR)) return true;
    }
    const target = event.target as Element | null;
    return !!(target && target.nodeType === 1 && safeClosest(target, `[${UI_ATTR}]`));
  } catch {
    return false;
  }
}

/** The event's real target (inside open shadow roots), as an Element. */
export function eventTarget(event: Event): Element | null {
  try {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const first = (path[0] ?? event.target) as Node | null;
    if (!first) return null;
    if (first.nodeType === 1) return first as Element;
    return (first as Node).parentElement ?? null;
  } catch {
    return null;
  }
}
