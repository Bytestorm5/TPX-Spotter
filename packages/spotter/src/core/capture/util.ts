/** Small helpers shared by the capture modules. Nothing here touches globals at import time. */

export function iso(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** A real browser document (not Node, not an edge worker). */
export function hasDom(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Replace `target[key]` with a wrapper; the returned function restores the
 * original. If someone else wrapped the method after us we can't unwrap
 * without breaking them, so the wrapper stays — callers make their wrapper a
 * pass-through once disabled (every wrapper here checks an `active` flag).
 */
export function patchMethod<T extends object, K extends keyof T>(target: T, key: K, make: (original: T[K]) => T[K]): () => void {
  const original = target[key];
  const wrapped = make(original);
  try {
    target[key] = wrapped;
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (target[key] === wrapped) target[key] = original;
    } catch {
      /* frozen or redefined: leave it, the wrapper is inert */
    }
  };
}

/** Add an event listener and return its remover. */
export function listen(
  target: EventTarget,
  type: string,
  fn: (event: Event) => void,
  options: AddEventListenerOptions | boolean = { capture: true, passive: true },
): () => void {
  target.addEventListener(type, fn, options);
  return () => target.removeEventListener(type, fn, options);
}

/** Resolve a possibly-relative URL against the page. */
export function absoluteUrl(url: string): string {
  try {
    return typeof location !== "undefined" ? new URL(url, location.href).href : new URL(url).href;
  } catch {
    return url;
  }
}

/** Path + query of a URL, for short human-facing labels. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost/");
    const sameOrigin = typeof location !== "undefined" && u.origin === location.origin;
    return (sameOrigin ? "" : u.host) + u.pathname + u.search;
  } catch {
    return url;
  }
}
