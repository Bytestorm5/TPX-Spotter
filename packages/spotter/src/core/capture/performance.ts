/**
 * Performance capture: LCP, INP, CLS, TTFB and FCP for the current page,
 * long tasks, JS heap (where the browser exposes it) and slow resources.
 *
 * A deliberately small reimplementation of the web-vitals algorithms over
 * `PerformanceObserver` rather than the `web-vitals` package — bytes matter
 * in a script that ships on every page:
 * - LCP: the last `largest-contentful-paint` candidate before the first input.
 * - INP: worst interaction latency per `interactionId`, at ~p98 (one outlier
 *   ignored per 50 interactions).
 * - CLS: the largest session window (shifts < 1 s apart, window ≤ 5 s),
 *   excluding shifts right after input.
 * - TTFB: navigation `responseStart` (minus prerender activation).
 * - FCP: the `first-contentful-paint` paint entry.
 *
 * On SPA route changes, INP and CLS restart for the new "page"; the load
 * metrics (LCP, FCP, TTFB) belong to the hard load and aren't re-reported.
 */
import type { PerformanceSnapshot } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer } from "../buffer.ts";
import { onNavigation } from "./navigation.ts";
import { isSpotterUrl } from "./network.ts";
import { hasDom, iso, listen } from "./util.ts";

export type Vitals = { lcp?: number; inp?: number; cls?: number; ttfb?: number; fcp?: number };

export type PerformanceSignal = Signal<PerformanceSnapshot> & {
  /** Subscribe to the current page's vitals as they update. The callback gets a fresh object each time. */
  onVitals(cb: (v: Vitals) => void): () => void;
  /** Start a new "page" (SPA navigation): resets INP and CLS. Called automatically on route changes. */
  resetPage(): void;
};

/** CLS session windows over (startTime, value) shifts: max window sum. Pure, for tests. */
export function clsFromShifts(shifts: readonly { t: number; value: number }[]): number {
  let best = 0;
  let current = 0;
  let first = -Infinity;
  let prev = -Infinity;
  for (const s of shifts) {
    if (s.t - prev < 1000 && s.t - first < 5000) {
      current += s.value;
    } else {
      current = s.value;
      first = s.t;
    }
    prev = s.t;
    if (current > best) best = current;
  }
  return best;
}

/** INP from per-interaction worst durations: the ~98th percentile. Pure, for tests. */
export function inpFromDurations(durations: readonly number[], totalInteractions = durations.length): number | undefined {
  if (!durations.length) return undefined;
  const sorted = durations.slice().sort((a, b) => b - a);
  const index = Math.min(sorted.length - 1, Math.floor(totalInteractions / 50));
  return sorted[index];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function installPerformance(rt: Runtime, opts: { slowResourceMs: number }): PerformanceSignal {
  const longTasks = new RingBuffer<{ at: string; duration: number }>(50, 16 * 1024);
  const slow = new RingBuffer<PerformanceSnapshot["slowResources"][number]>(30, 32 * 1024);
  const observers: PerformanceObserver[] = [];
  const undo: (() => void)[] = [];
  const subscribers = new Set<(v: Vitals) => void>();
  let active = true;

  // Load metrics.
  let lcp: number | undefined;
  let lcpFinal = false;
  let fcp: number | undefined;
  let ttfb: number | undefined;
  // Per-page metrics.
  let shifts: { t: number; value: number }[] = [];
  const interactions = new Map<number, number>();
  /** Distinct interactions seen on this page (the map is pruned to the worst few). */
  let interactionCount = 0;
  let softPage = false;

  const timeOrigin = typeof performance !== "undefined" ? (performance.timeOrigin ?? Date.now() - performance.now()) : Date.now();

  const pageVitals = (): Vitals => {
    const v: Vitals = {};
    if (!softPage) {
      if (lcp !== undefined) v.lcp = Math.round(lcp);
      if (fcp !== undefined) v.fcp = Math.round(fcp);
      if (ttfb !== undefined) v.ttfb = Math.round(ttfb);
    }
    const inp = inpFromDurations([...interactions.values()], interactionCount);
    if (inp !== undefined) v.inp = Math.round(inp);
    if (shifts.length) v.cls = round(clsFromShifts(shifts));
    return v;
  };

  let notifyQueued = false;
  const notify = () => {
    if (notifyQueued || !subscribers.size) return;
    notifyQueued = true;
    // Coalesce bursts of entries into one callback.
    queueMicrotask(() => {
      notifyQueued = false;
      const v = pageVitals();
      for (const cb of subscribers) {
        try {
          cb({ ...v });
        } catch {
          /* subscriber's fault */
        }
      }
    });
  };

  const fault = (error: unknown) => {
    if (!active) return;
    active = false;
    try {
      rt.fault("performance", error);
    } catch {
      /* never throw into the host */
    }
    for (const o of observers) o.disconnect();
  };

  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra?: Record<string, unknown>) => {
    try {
      const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
      if (supported && !supported.includes(type)) return;
      const o = new PerformanceObserver((list) => {
        if (!active) return;
        try {
          cb(list.getEntries());
        } catch (error) {
          fault(error);
        }
      });
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(o);
    } catch {
      /* entry type unsupported in this browser */
    }
  };

  if (hasDom() && typeof PerformanceObserver !== "undefined") {
    let activationStart = 0;
    try {
      const nav = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined;
      if (nav) {
        activationStart = nav.activationStart ?? 0;
        if (nav.responseStart > 0) ttfb = Math.max(0, nav.responseStart - activationStart);
      }
    } catch {
      /* no navigation timing */
    }

    observe("paint", (entries) => {
      for (const e of entries) {
        if (e.name === "first-contentful-paint" && fcp === undefined) {
          fcp = Math.max(0, e.startTime - activationStart);
          notify();
        }
      }
    });
    observe("largest-contentful-paint", (entries) => {
      if (lcpFinal) return;
      const last = entries[entries.length - 1];
      if (last) {
        lcp = Math.max(0, last.startTime - activationStart);
        notify();
      }
    });
    // LCP stops at the first input or when the page is hidden.
    const finalizeLcp = () => {
      lcpFinal = true;
    };
    undo.push(listen(window, "keydown", finalizeLcp, { capture: true, passive: true, once: true }));
    undo.push(listen(window, "pointerdown", finalizeLcp, { capture: true, passive: true, once: true }));
    undo.push(listen(document, "visibilitychange", finalizeLcp, { capture: true, passive: true, once: true }));

    observe("layout-shift", (entries) => {
      for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (e.hadRecentInput) continue;
        shifts.push({ t: e.startTime, value: e.value });
        if (shifts.length > 500) shifts = shifts.slice(-250);
      }
      notify();
    });
    const onInteraction = (entries: PerformanceEntry[]) => {
      let changed = false;
      for (const e of entries as (PerformanceEntry & { interactionId?: number })[]) {
        const id = e.interactionId;
        if (!id) continue;
        const prev = interactions.get(id);
        if (prev === undefined) interactionCount++;
        if (prev === undefined || e.duration > prev) {
          interactions.set(id, e.duration);
          changed = true;
        }
      }
      // Keep memory flat on long-lived pages: the worst few are all INP needs.
      if (interactions.size > 200) {
        const keep = [...interactions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
        interactions.clear();
        for (const [id, d] of keep) interactions.set(id, d);
      }
      if (changed) notify();
    };
    observe("event", onInteraction, { durationThreshold: 40 });
    observe("first-input", onInteraction);

    observe("longtask", (entries) => {
      for (const e of entries) longTasks.push({ at: iso(timeOrigin + e.startTime), duration: Math.round(e.duration) });
    });
    observe("resource", (entries) => {
      for (const e of entries as PerformanceResourceTiming[]) {
        if (e.duration < opts.slowResourceMs) continue;
        if (isSpotterUrl(e.name, rt.config.endpoint)) continue;
        const item: PerformanceSnapshot["slowResources"][number] = {
          url: rt.redactUrl(e.name),
          duration: Math.round(e.duration),
          initiatorType: e.initiatorType,
        };
        if (typeof e.transferSize === "number" && e.transferSize > 0) item.transferSize = e.transferSize;
        slow.push(item);
      }
    });
  }

  const resetPage = () => {
    softPage = true;
    shifts = [];
    interactions.clear();
    interactionCount = 0;
  };
  undo.push(onNavigation((entry) => {
    // A replaceState that changes the URL is usually a filter/query update on the same page.
    if (entry.kind === "push" || entry.kind === "pop") resetPage();
  }));

  return {
    name: "performance",
    snapshot(): PerformanceSnapshot {
      const snap: PerformanceSnapshot = { longTasks: longTasks.toArray(), slowResources: slow.toArray() };
      // The ticket keeps the hard-load metrics even after soft navigations.
      if (lcp !== undefined) snap.lcp = Math.round(lcp);
      if (fcp !== undefined) snap.fcp = Math.round(fcp);
      if (ttfb !== undefined) snap.ttfb = Math.round(ttfb);
      const v = pageVitals();
      if (v.inp !== undefined) snap.inp = v.inp;
      if (v.cls !== undefined) snap.cls = v.cls;
      try {
        const mem = (performance as Performance & { memory?: PerformanceSnapshot["memory"] }).memory;
        if (mem) snap.memory = { usedJSHeapSize: mem.usedJSHeapSize, totalJSHeapSize: mem.totalJSHeapSize, jsHeapSizeLimit: mem.jsHeapSizeLimit };
      } catch {
        /* not exposed */
      }
      return snap;
    },
    onVitals(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    resetPage,
    destroy() {
      active = false;
      for (const o of observers.splice(0)) o.disconnect();
      for (const fn of undo.splice(0)) fn();
      subscribers.clear();
      longTasks.clear();
      slow.clear();
    },
  };
}
