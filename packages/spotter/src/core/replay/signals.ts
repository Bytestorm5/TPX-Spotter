/**
 * Frustration signals derived from rrweb events: rage clicks, dead clicks,
 * error clicks, thrashing scroll and form abandonment. A pure function over
 * the event list (no rrweb import, no DOM), so Console can run the same
 * algorithm over stored sessions.
 *
 * Numeric rrweb enums are inlined: EventType (FullSnapshot 2, Incremental 3,
 * Meta 4, Custom 5), IncrementalSource (Mutation 0, MouseInteraction 2,
 * Scroll 3, Input 5), MouseInteractions (Click 2).
 */

export type DerivedSignalKind = "rage_click" | "dead_click" | "error_click" | "thrashing_scroll" | "form_abandonment";

export interface DerivedSignal {
  kind: DerivedSignalKind;
  count: number;
  /** Timestamps (ms) of each occurrence, for timeline markers. */
  at: number[];
}

const T_FULL = 2;
const T_INCREMENTAL = 3;
const T_META = 4;
const T_CUSTOM = 5;
const S_MUTATION = 0;
const S_MOUSE_INTERACTION = 2;
const S_SCROLL = 3;
const S_INPUT = 5;
const MI_CLICK = 2;

interface RawEvent {
  type?: number;
  timestamp?: number;
  data?: { source?: number; type?: number; id?: number; x?: number; y?: number; tag?: string; href?: string; payload?: unknown };
}

export interface DeriveOptions {
  rageCount?: number;
  rageWindowMs?: number;
  rageRadiusPx?: number;
  deadWindowMs?: number;
  errorWindowMs?: number;
  /** Direction reversals within `thrashWindowMs` that count as thrashing. */
  thrashReversals?: number;
  thrashWindowMs?: number;
  /** Idle time after the last input (with no click) that counts as abandoning a form. */
  abandonAfterMs?: number;
}

function isErrorCustom(e: RawEvent): boolean {
  return e.type === T_CUSTOM && typeof e.data?.tag === "string" && /error/i.test(e.data.tag);
}

/**
 * Derive frustration signals. Returns only kinds that occurred.
 *
 * - rage_click: ≥ 3 clicks within 1 s within 30 px (one per burst)
 * - dead_click: a click followed by no DOM mutation, navigation or input
 *   within 1 s (only when the recording covers that second)
 * - error_click: an error custom event (tag containing "error", as Spotter's
 *   recorder adds) within 1 s after a click
 * - thrashing_scroll: ≥ 4 vertical direction reversals on one scroller within 2 s
 * - form_abandonment: input into fields, then no click before a navigation
 *   or before the recording ends ≥ 30 s later (heuristic: rrweb has no submit event)
 */
export function deriveSignals(events: readonly unknown[], options: DeriveOptions = {}): DerivedSignal[] {
  const o = {
    rageCount: options.rageCount ?? 3,
    rageWindowMs: options.rageWindowMs ?? 1000,
    rageRadiusPx: options.rageRadiusPx ?? 30,
    deadWindowMs: options.deadWindowMs ?? 1000,
    errorWindowMs: options.errorWindowMs ?? 1000,
    thrashReversals: options.thrashReversals ?? 4,
    thrashWindowMs: options.thrashWindowMs ?? 2000,
    abandonAfterMs: options.abandonAfterMs ?? 30_000,
  };
  const list = (events as RawEvent[]).filter((e) => e && typeof e.timestamp === "number").slice();
  list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const found: Record<DerivedSignalKind, number[]> = {
    rage_click: [],
    dead_click: [],
    error_click: [],
    thrashing_scroll: [],
    form_abandonment: [],
  };
  const endTs = list[list.length - 1]?.timestamp ?? 0;

  const isClick = (e: RawEvent) => e.type === T_INCREMENTAL && e.data?.source === S_MOUSE_INTERACTION && e.data.type === MI_CLICK;
  const isResponse = (e: RawEvent) =>
    (e.type === T_INCREMENTAL && (e.data?.source === S_MUTATION || e.data?.source === S_INPUT)) ||
    e.type === T_META ||
    e.type === T_FULL ||
    (e.type === T_CUSTOM && /navigation|network|request/i.test(String(e.data?.tag ?? "")));

  // -- clicks: rage, dead, error
  const clicks: { t: number; x: number; y: number }[] = [];
  let burstEnd = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const e = list[i] as RawEvent;
    if (!isClick(e)) continue;
    const t = e.timestamp as number;
    const x = e.data?.x ?? 0;
    const y = e.data?.y ?? 0;

    clicks.push({ t, x, y });
    while (clicks.length && t - (clicks[0]?.t ?? t) > o.rageWindowMs) clicks.shift();
    const near = clicks.filter((c) => Math.hypot(c.x - x, c.y - y) <= o.rageRadiusPx).length;
    if (near >= o.rageCount) {
      if (t > burstEnd) found.rage_click.push(t);
      burstEnd = t + o.rageWindowMs;
    }

    let responded = false;
    let errored = false;
    for (let j = i + 1; j < list.length; j++) {
      const next = list[j] as RawEvent;
      if ((next.timestamp as number) - t > Math.max(o.deadWindowMs, o.errorWindowMs)) break;
      const dt = (next.timestamp as number) - t;
      if (dt <= o.deadWindowMs && isResponse(next)) responded = true;
      if (dt <= o.errorWindowMs && isErrorCustom(next)) errored = true;
    }
    if (!responded && endTs - t >= o.deadWindowMs) found.dead_click.push(t);
    if (errored) found.error_click.push(t);
  }

  // -- thrashing scroll: rapid direction reversals per scroller
  const scrollers = new Map<number, { lastY: number; dir: number; reversals: number[]; lastFired: number }>();
  for (const e of list) {
    if (e.type !== T_INCREMENTAL || e.data?.source !== S_SCROLL) continue;
    const id = e.data.id ?? 0;
    const y = e.data.y ?? 0;
    const t = e.timestamp as number;
    const s = scrollers.get(id);
    if (!s) {
      scrollers.set(id, { lastY: y, dir: 0, reversals: [], lastFired: -Infinity });
      continue;
    }
    const dir = Math.sign(y - s.lastY);
    s.lastY = y;
    if (!dir) continue;
    if (s.dir && dir !== s.dir) {
      s.reversals.push(t);
      while (s.reversals.length && t - (s.reversals[0] ?? t) > o.thrashWindowMs) s.reversals.shift();
      if (s.reversals.length >= o.thrashReversals && t - s.lastFired > o.thrashWindowMs) {
        found.thrashing_scroll.push(t);
        s.lastFired = t;
        s.reversals = [];
      }
    }
    s.dir = dir;
  }

  // -- form abandonment: typed, then left (navigation or long idle) without clicking anything
  let lastInput = -1;
  let clickedSince = false;
  for (const e of list) {
    const t = e.timestamp as number;
    if (e.type === T_INCREMENTAL && e.data?.source === S_INPUT) {
      lastInput = t;
      clickedSince = false;
    } else if (isClick(e)) {
      if (lastInput >= 0) clickedSince = true;
    } else if (e.type === T_META && lastInput >= 0) {
      if (!clickedSince) found.form_abandonment.push(t);
      lastInput = -1;
    }
  }
  if (lastInput >= 0 && !clickedSince && endTs - lastInput >= o.abandonAfterMs) found.form_abandonment.push(endTs);

  return (Object.keys(found) as DerivedSignalKind[])
    .filter((k) => found[k].length > 0)
    .map((kind) => ({ kind, count: found[kind].length, at: found[kind] }));
}
