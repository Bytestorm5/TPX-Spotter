/**
 * Navigation capture, SPA-aware: the initial load, `history.pushState` /
 * `replaceState` (patched reversibly — App Router soft navigations go through
 * them), `popstate` and `hashchange`. Every change is reported to the client
 * (`rt.navigated`, which drives analytics pageviews) and to in-process
 * listeners (`onNavigation`, which resets per-page performance metrics).
 *
 * URLs are held as they are; `finalizeNavigation` / `finalizeCrumbs` redact
 * them at snapshot time, and every consumer of `rt.navigated` (analytics)
 * redacts what it sends.
 */
import type { NavigationEntry } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer } from "../buffer.ts";
import { hasDom, iso, listen, patchMethod, shortUrl } from "./util.ts";

const navListeners = new Set<(entry: NavigationEntry) => void>();

/** In-process route-change listeners (performance resets its per-page metrics). Called after `rt.navigated`. */
export function onNavigation(fn: (entry: NavigationEntry) => void): () => void {
  navListeners.add(fn);
  return () => navListeners.delete(fn);
}

function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

export type NavigationSnapshot = { entries: NavigationEntry[]; history: string[] };

export function installNavigation(rt: Runtime, opts: { max: number }): Signal<NavigationSnapshot> {
  const maxHistory = Math.max(1, opts.max || 20);
  const entries = new RingBuffer<NavigationEntry>(Math.max(maxHistory, 50), 64 * 1024);
  const history: string[] = [];
  const undo: (() => void)[] = [];
  let active = true;
  let last = "";

  const fault = (error: unknown) => {
    if (!active) return;
    active = false;
    rt.fault("navigation", error); // the engine's fault() never throws
  };

  const record = (kind: NavigationEntry["kind"], to: string, from?: string) => {
    const entry: NavigationEntry = { at: iso(rt.now()), to, kind };
    if (from) entry.from = from;
    const pattern = rt.routePattern(to);
    if (pattern) entry.routePattern = pattern;
    entries.push(entry);
    history.push(to);
    while (history.length > maxHistory) history.shift();
    rt.breadcrumb({
      at: entry.at,
      category: "navigation",
      level: "info",
      message: kind === "load" ? `Loaded ${shortUrl(to)}` : `${from ? shortUrl(from) : "?"} → ${shortUrl(to)}`,
      data: { kind },
    });
    rt.navigated(entry);
    for (const fn of navListeners) {
      try {
        fn(entry);
      } catch {
        /* a listener's fault is its own */
      }
    }
  };

  /** Record a change if the URL actually moved; hash-only moves are `hash`. */
  const changed = (kind: "push" | "replace" | "pop") => {
    if (!active) return;
    try {
      const now = location.href;
      if (now === last) return;
      const from = last;
      last = now;
      const hashOnly = stripHash(now) === stripHash(from);
      record(hashOnly && kind !== "replace" ? "hash" : kind, now, from);
    } catch (error) {
      fault(error);
    }
  };

  if (hasDom()) {
    try {
      last = location.href;
      const referrer = document.referrer;
      record("load", last, referrer || undefined);
    } catch (error) {
      fault(error);
    }

    const h = window.history;
    if (h) {
      for (const method of ["pushState", "replaceState"] as const) {
        if (typeof h[method] !== "function") continue;
        undo.push(
          patchMethod(h, method, (original) =>
            function spotterHistory(this: History, ...args: Parameters<History["pushState"]>) {
              const result = original.apply(this ?? h, args);
              if (active) changed(method === "pushState" ? "push" : "replace");
              return result;
            },
          ),
        );
      }
    }
    undo.push(listen(window, "popstate", () => changed("pop")));
    // popstate already covers most hash moves; this catches the ones it doesn't (and dedupes on URL).
    undo.push(listen(window, "hashchange", () => changed("pop")));
  }

  return {
    name: "navigation",
    snapshot: () => ({ entries: entries.toArray(), history: history.slice() }),
    destroy() {
      active = false;
      for (const fn of undo.splice(0)) fn();
      entries.clear();
      history.length = 0;
    },
  };
}
