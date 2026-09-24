import { describe, expect, it } from "vitest";
import { gunzipSync, strFromU8 } from "fflate";
import { checkoutInterval, clampWindowSeconds, ReplayWindow, EVENT_FULL_SNAPSHOT, EVENT_META } from "../../src/core/replay/window.ts";
import { deriveSignals } from "../../src/core/replay/signals.ts";
import { compressEvents, gzipBytes } from "../../src/core/replay/compress.ts";
import { recorderSelectors } from "../../src/core/replay/index.ts";
import { pickMimeType } from "../../src/core/recording/index.ts";

type Ev = { type: number; timestamp: number; data?: Record<string, unknown> };
const meta = (t: number): Ev => ({ type: EVENT_META, timestamp: t });
const full = (t: number): Ev => ({ type: EVENT_FULL_SNAPSHOT, timestamp: t });
const inc = (t: number, data: Record<string, unknown> = { source: 1 }): Ev => ({ type: 3, timestamp: t, data });

/** Simulate rrweb: a checkout (meta + full) every `every` ms, incrementals every `step` ms. */
function record(w: ReplayWindow<Ev>, until: number, every: number, step = 1000) {
  for (let t = 0; t <= until; t += step) {
    if (t % every === 0) {
      w.push(meta(t), t > 0);
      w.push(full(t), t > 0);
    } else {
      w.push(inc(t));
    }
  }
}

describe("ReplayWindow", () => {
  it("keeps the newest checkout chain that starts before the window, and everything after", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 60_000, sizeOf: () => 10 });
    record(w, 200_000, 30_000);
    const events = w.events();
    // now = 200 s, cutoff = 140 s → keep the chain starting at 120 s.
    expect(events[0]).toEqual(meta(120_000));
    expect(events[1]).toEqual(full(120_000));
    expect(events.at(-1)?.timestamp).toBe(200_000);
    expect(w.range()).toEqual({ start: 120_000, end: 200_000 });
    expect(w.chainCount).toBe(3); // 120 s, 150 s, 180 s
    // Always a full snapshot at or before the window start.
    expect(events.some((e) => e.type === EVENT_FULL_SNAPSHOT && e.timestamp <= 140_000)).toBe(true);
    expect(w.bytes).toBe(events.length * 10);
  });

  it("never drops the only chain for age alone", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 15_000, sizeOf: () => 1 });
    w.push(meta(0));
    w.push(full(0));
    for (let t = 1000; t <= 100_000; t += 1000) w.push(inc(t));
    expect(w.events()[1]).toEqual(full(0));
    expect(w.length).toBe(102);
  });

  it("drops older chains beyond the soft byte budget, even inside the window", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 300_000, targetBytes: 1000, hardCapBytes: 5000, sizeOf: () => 100 });
    record(w, 30_000, 10_000);
    // Chains at 0, 10, 20, 30 s; each ≤ 1000 bytes; budget keeps only the newest ones.
    expect(w.bytes).toBeLessThanOrEqual(1000);
    expect(w.events()[0]?.type).toBe(EVENT_META);
    expect(w.events()[1]?.type).toBe(EVENT_FULL_SNAPSHOT);
  });

  it("asks for a fresh checkout when a lone chain exceeds the hard cap, then sheds it", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 60_000, targetBytes: 300, hardCapBytes: 500, sizeOf: () => 100 });
    w.push(meta(0));
    w.push(full(0));
    let asked = false;
    for (let t = 1; t < 10 && !asked; t++) asked = w.push(inc(t));
    expect(asked).toBe(true);
    // The recorder answers with a checkout: the old chain goes.
    w.push(meta(20), true);
    w.push(full(20), true);
    expect(w.events()[0]).toEqual(meta(20));
    expect(w.bytes).toBe(200);
  });

  it("starts a chain on a bare full snapshot after a complete one", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 1000, sizeOf: () => 1 });
    w.push(meta(0));
    w.push(full(0));
    w.push(full(5000));
    // The window (4–5 s) still needs the chain at 0 s to replay its start.
    expect(w.chainCount).toBe(2);
    w.push(inc(7000));
    expect(w.chainCount).toBe(1);
    expect(w.events()).toEqual([full(5000), inc(7000)]);
  });

  it("clamps windows and picks checkout intervals", () => {
    expect(clampWindowSeconds(undefined)).toBe(60);
    expect(clampWindowSeconds(5)).toBe(15);
    expect(clampWindowSeconds(1000)).toBe(300);
    expect(checkoutInterval(60)).toBe(30_000);
    expect(checkoutInterval(15)).toBe(10_000);
  });
});

describe("deriveSignals", () => {
  const click = (t: number, x = 100, y = 100): Ev => ({ type: 3, timestamp: t, data: { source: 2, type: 2, id: 5, x, y } });
  const mutation = (t: number): Ev => ({ type: 3, timestamp: t, data: { source: 0 } });
  const scroll = (t: number, y: number, id = 1): Ev => ({ type: 3, timestamp: t, data: { source: 3, id, x: 0, y } });
  const input = (t: number): Ev => ({ type: 3, timestamp: t, data: { source: 5, id: 9, text: "***" } });
  const custom = (t: number, tag: string): Ev => ({ type: 5, timestamp: t, data: { tag, payload: {} } });
  const kinds = (events: Ev[]) => Object.fromEntries(deriveSignals(events).map((s) => [s.kind, s.count]));

  it("rage clicks: one per burst of ≥3 nearby clicks in 1 s", () => {
    const events = [meta(0), full(0), click(1000), click(1200, 105), click(1400, 98), click(1600), mutation(1650), click(5000), mutation(5100), inc(9000)];
    expect(kinds(events).rage_click).toBe(1);
    expect(kinds([meta(0), click(1000), click(1300, 300), click(1600, 600), inc(9000)]).rage_click).toBeUndefined();
  });

  it("dead clicks: no mutation/input/navigation within 1 s; only when covered by the recording", () => {
    const events = [meta(0), full(0), click(1000), inc(2500), click(3000), mutation(3200), click(8000), inc(8500)];
    const sig = deriveSignals(events).find((s) => s.kind === "dead_click");
    expect(sig).toEqual({ kind: "dead_click", count: 1, at: [1000] });
  });

  it("error clicks: an error custom event within 1 s of a click", () => {
    const events = [meta(0), click(1000), mutation(1100), custom(1500, "spotter:error"), click(4000), mutation(4100), custom(6000, "spotter:error"), inc(9000)];
    expect(kinds(events).error_click).toBe(1);
  });

  it("thrashing scroll: rapid direction reversals", () => {
    const events: Ev[] = [meta(0)];
    let t = 1000;
    for (const y of [0, 300, 100, 400, 50, 500, 20, 600]) events.push(scroll((t += 150), y));
    events.push(inc(20_000));
    for (const y of [0, 100, 200, 300, 400]) events.push(scroll((t += 1000), y)); // steady: no thrash
    expect(kinds(events).thrashing_scroll).toBe(1);
  });

  it("form abandonment: typed then navigated (or idled 30 s) without clicking", () => {
    expect(kinds([meta(0), input(1000), input(2000), meta(5000)]).form_abandonment).toBe(1);
    expect(kinds([meta(0), input(1000), click(3000), meta(5000)]).form_abandonment).toBeUndefined();
    expect(kinds([meta(0), input(1000), inc(40_000)]).form_abandonment).toBe(1);
    expect(kinds([meta(0), input(1000), inc(10_000)]).form_abandonment).toBeUndefined();
  });

  it("tolerates junk and unsorted input", () => {
    expect(deriveSignals([null, 1, "x", {}, { timestamp: "no" }] as unknown[])).toEqual([]);
    expect(kinds([click(1600), click(1000), click(1200), meta(0), mutation(1700), inc(9000)]).rage_click).toBe(1);
  });
});

describe("replay compression", () => {
  it("gzips events (sync fallback without Workers) and round-trips", async () => {
    const events = [meta(1), full(2), inc(3)];
    const gz = await compressEvents(events);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(JSON.parse(strFromU8(gunzipSync(gz)))).toEqual(events);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(Array.from(gunzipSync(await gzipBytes(bytes)))).toEqual([1, 2, 3]);
  });
});

describe("recorderSelectors", () => {
  it("always blocks Spotter UI and media by default, with opt-ins", () => {
    const s = recorderSelectors({ maskText: "inputs", maskSelectors: [".pii"], blockSelectors: [".ad"], recordCanvas: ["#chart"], recordMedia: [] });
    expect(s.blockSelector).toBe("[data-spotter-block],[data-spotter-ui],.ad,canvas:not(#chart),video,audio");
    expect(s.maskTextSelector).toBe("[data-spotter-mask],.pii");
    expect(recorderSelectors({ maskText: "all", maskSelectors: [], blockSelectors: [] }).maskTextSelector).toBe("*");
  });
});

describe("pickMimeType", () => {
  it("prefers vp9, then vp8, then mp4", () => {
    expect(pickMimeType(() => true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickMimeType((t) => t.includes("vp8"))).toBe("video/webm;codecs=vp8,opus");
    expect(pickMimeType((t) => t === "video/mp4")).toBe("video/mp4");
    expect(pickMimeType(() => false)).toBeUndefined();
  });
});
