// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPerformance, type PerformanceSignal } from "../../src/core/capture/performance.ts";
import { installNavigation } from "../../src/core/capture/navigation.ts";
import { setUrl, testRuntime } from "./helpers.ts";

class FakePO {
  static supportedEntryTypes = ["paint", "largest-contentful-paint", "layout-shift", "event", "first-input", "longtask", "resource"];
  static byType = new Map<string, FakePO>();
  constructor(private cb: (list: { getEntries(): unknown[] }) => void) {}
  observe(init: { type: string }) {
    FakePO.byType.set(init.type, this);
  }
  disconnect() {
    for (const [k, v] of FakePO.byType) if (v === this) FakePO.byType.delete(k);
  }
  static emit(type: string, entries: Record<string, unknown>[]) {
    FakePO.byType.get(type)?.cb({ getEntries: () => entries });
  }
}

const saved = globalThis.PerformanceObserver;
let sig: PerformanceSignal | null = null;

beforeEach(() => {
  FakePO.byType.clear();
  (globalThis as { PerformanceObserver: unknown }).PerformanceObserver = FakePO;
  setUrl("https://app.example.com/");
});
afterEach(() => {
  sig?.destroy();
  sig = null;
  (globalThis as { PerformanceObserver: unknown }).PerformanceObserver = saved;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("installPerformance", () => {
  it("computes vitals, long tasks and slow resources", async () => {
    const rt = testRuntime();
    sig = installPerformance(rt, { slowResourceMs: 1000 });
    const seen: unknown[] = [];
    sig.onVitals((v) => seen.push(v));
    FakePO.emit("paint", [{ name: "first-contentful-paint", startTime: 800 }]);
    FakePO.emit("largest-contentful-paint", [{ startTime: 1200 }, { startTime: 1900 }]);
    FakePO.emit("layout-shift", [
      { startTime: 100, value: 0.05, hadRecentInput: false },
      { startTime: 400, value: 0.3, hadRecentInput: true },
      { startTime: 600, value: 0.05, hadRecentInput: false },
    ]);
    FakePO.emit("event", [
      { interactionId: 1, duration: 80 },
      { interactionId: 1, duration: 240 },
      { interactionId: 2, duration: 120 },
      { interactionId: 0, duration: 900 }, // not an interaction
    ]);
    FakePO.emit("longtask", [{ startTime: 50, duration: 120.4 }]);
    FakePO.emit("resource", [
      { name: "https://cdn.example.com/big.js?token=x", duration: 2500, initiatorType: "script", transferSize: 123 },
      { name: "https://cdn.example.com/fast.css", duration: 20, initiatorType: "link", transferSize: 1 },
      { name: "https://app.example.com/api/spotter/v1/config", duration: 5000, initiatorType: "fetch" },
    ]);
    await tick();
    const snap = sig.snapshot();
    expect(snap).toMatchObject({ fcp: 800, lcp: 1900, cls: 0.1, inp: 240 });
    expect(snap.longTasks).toHaveLength(1);
    expect(snap.longTasks[0]?.duration).toBe(120);
    expect(snap.slowResources).toEqual([{ url: "https://cdn.example.com/big.js?token=[redacted]", duration: 2500, initiatorType: "script", transferSize: 123 }]);
    expect(seen.at(-1)).toEqual({ fcp: 800, lcp: 1900, cls: 0.1, inp: 240 });
  });

  it("stops LCP at the first input", async () => {
    sig = installPerformance(testRuntime(), { slowResourceMs: 1000 });
    FakePO.emit("largest-contentful-paint", [{ startTime: 1000 }]);
    window.dispatchEvent(new Event("pointerdown"));
    FakePO.emit("largest-contentful-paint", [{ startTime: 3000 }]);
    expect(sig.snapshot().lcp).toBe(1000);
  });

  it("resets INP and CLS for the new page on SPA navigation", async () => {
    const rt = testRuntime();
    const nav = installNavigation(rt, { max: 20 });
    sig = installPerformance(rt, { slowResourceMs: 1000 });
    const seen: Record<string, number>[] = [];
    sig.onVitals((v) => seen.push(v as Record<string, number>));
    FakePO.emit("paint", [{ name: "first-contentful-paint", startTime: 500 }]);
    FakePO.emit("layout-shift", [{ startTime: 100, value: 0.2, hadRecentInput: false }]);
    FakePO.emit("event", [{ interactionId: 7, duration: 300 }]);
    await tick();
    history.pushState({}, "", "/next");
    FakePO.emit("event", [{ interactionId: 8, duration: 60 }]);
    await tick();
    expect(seen.at(-1)).toEqual({ inp: 60 }); // soft page: no load metrics, fresh INP/CLS
    const snap = sig.snapshot();
    expect(snap.fcp).toBe(500); // the ticket keeps the hard-load metric
    expect(snap.cls).toBeUndefined();
    expect(snap.inp).toBe(60);
    nav.destroy();
  });

  it("disconnects observers on destroy", () => {
    sig = installPerformance(testRuntime(), { slowResourceMs: 1000 });
    expect(FakePO.byType.size).toBeGreaterThan(0);
    sig.destroy();
    sig = null;
    expect(FakePO.byType.size).toBe(0);
  });
});
