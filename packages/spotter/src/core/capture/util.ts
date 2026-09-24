/** Small helpers shared by the capture modules. Nothing here touches globals at import time. */
import { truncate } from "../buffer.ts";

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

/**
 * A bounded copy of a live value (a console argument, a thrown non-Error),
 * taken at call time so a later mutation doesn't change what gets reported.
 * Plain objects, class instances and arrays are copied — at most 100 keys /
 * items per level, depth 6, 2000 nodes, strings ≤ 8 KB — while built-ins with
 * internal state (Date, Map, Error, DOM nodes, …) are kept by reference.
 * `safeSerialize` and redaction run over the copy when a report is
 * snapshotted (`capture/finalize.ts`). `size.n` accumulates an approximate
 * byte cost, for the buffer bounds.
 */
export function copyValue(value: unknown, size = { n: 0 }): unknown {
  let budget = 2000;
  const path = new Set<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      size.n += v.length;
      return truncate(v);
    }
    size.n += 8;
    if (!v || typeof v !== "object") return v;
    try {
      if (--budget < 0) return "[…]";
      if (path.has(v)) return "[Circular]";
      const arr = Array.isArray(v);
      if (!arr && Object.prototype.toString.call(v) !== "[object Object]") return v;
      if (depth > 5) return arr ? `[Array(${v.length})]` : "[Object]";
      path.add(v);
      const out: Record<string | number, unknown> = arr ? [] : Object.create(Object.getPrototypeOf(v));
      const keys = arr ? v : Object.keys(v);
      const n = Math.min(keys.length, 100);
      for (let i = 0; i < n; i++) {
        const k = arr ? i : (keys[i] as string);
        let child: unknown;
        try {
          child = (v as Record<string | number, unknown>)[k];
        } catch {
          child = "[Throws]";
        }
        out[k] = walk(child, depth + 1);
      }
      if (keys.length > n) out[arr ? n : "…"] = arr ? `[… ${keys.length - n} more items]` : `${keys.length - n} more keys`;
      path.delete(v);
      return out;
    } catch {
      return "[Unserializable]";
    }
  };
  return walk(value, 0);
}
