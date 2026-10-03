// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INPUT_GAP_MS, INPUT_QUIET_MS, noteInput, trackInput, whenQuiet } from "../../src/core/replay/quiet.ts";
import { EVENT_FULL_SNAPSHOT, EVENT_META, ReplayWindow } from "../../src/core/replay/window.ts";

// happy-dom has no requestIdleCallback: these run the timer fallback, where a timer that fires on time counts as idle.
beforeEach(() => {
  vi.useFakeTimers();
  noteInput(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("whenQuiet", () => {
  it("waits for a quiet moment, then runs once", () => {
    const fn = vi.fn();
    whenQuiet(fn);
    expect(fn).not.toHaveBeenCalled(); // never synchronously
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never runs sooner than afterLoadMs after load", () => {
    const fn = vi.fn();
    whenQuiet(fn, { afterLoadMs: 2000 });
    vi.advanceTimersByTime(1500);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("holds off while the user is interacting", () => {
    const release = trackInput();
    const fn = vi.fn();
    whenQuiet(fn, { maxWaitMs: 60_000 });
    // A tap every 500 ms keeps it waiting...
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event("pointerdown"));
      vi.advanceTimersByTime(500);
    }
    expect(fn).not.toHaveBeenCalled();
    // ...until there has been no input for INPUT_QUIET_MS.
    vi.advanceTimersByTime(INPUT_QUIET_MS + 300);
    expect(fn).toHaveBeenCalledTimes(1);
    release();
  });

  it("past maxWaitMs, a gap between taps is enough (no starvation)", () => {
    const release = trackInput();
    const fn = vi.fn();
    whenQuiet(fn, { maxWaitMs: 2000 });
    for (let i = 0; i < 20 && !fn.mock.calls.length; i++) {
      window.dispatchEvent(new Event("keydown"));
      vi.advanceTimersByTime(INPUT_GAP_MS + 450);
    }
    expect(fn).toHaveBeenCalledTimes(1);
    release();
  });

  it("waits for a hidden tab to become visible", () => {
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fn = vi.fn();
    whenQuiet(fn);
    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();
    state.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    state.mockRestore();
  });

  it("can be cancelled", () => {
    const fn = vi.fn();
    const cancel = whenQuiet(fn);
    cancel();
    vi.advanceTimersByTime(20_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("stops listening for input once every tracker is released", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const a = trackInput();
    const b = trackInput();
    const adds = add.mock.calls.length;
    a();
    expect(remove).not.toHaveBeenCalled();
    b();
    b(); // idempotent
    expect(remove.mock.calls.length).toBe(adds);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("ReplayWindow with deferred sizing", () => {
  type Ev = { type: number; timestamp: number };
  const meta = (t: number): Ev => ({ type: EVENT_META, timestamp: t });
  const full = (t: number): Ev => ({ type: EVENT_FULL_SNAPSHOT, timestamp: t });
  const inc = (t: number): Ev => ({ type: 3, timestamp: t });

  it("files events without sizing them, and sizes them in slices later", () => {
    const sizeOf = vi.fn(() => 10);
    const w = new ReplayWindow<Ev>({ windowMs: 60_000, sizeOf, deferSizing: true });
    w.push(meta(0));
    w.push(full(0));
    for (let t = 1; t <= 8; t++) w.push(inc(t));
    expect(sizeOf).not.toHaveBeenCalled();
    expect(w.length).toBe(10);
    expect(w.unmeasured).toBe(10);
    let budget = 4;
    const first = w.measure(() => budget-- > 0);
    expect(first).toMatchObject({ bytes: 40, done: false, needsCheckout: false });
    expect(w.unmeasured).toBe(6);
    expect(w.measure()).toMatchObject({ bytes: 60, done: true });
    expect(w.bytes).toBe(100);
    expect(sizeOf).toHaveBeenCalledTimes(10);
  });

  it("still prunes by age at push, and applies byte budgets when measuring", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 10_000, targetBytes: 250, hardCapBytes: 1000, sizeOf: () => 100, deferSizing: true });
    w.push(meta(0));
    w.push(full(0));
    w.push(meta(20_000), true);
    w.push(full(20_000), true);
    w.push(inc(31_000)); // the chain at 0 s is now entirely before the window
    expect(w.chainCount).toBe(1);
    w.push(meta(32_000), true);
    w.push(full(32_000), true);
    expect(w.chainCount).toBe(2);
    w.measure();
    // 500 bytes over a 250 target: the older chain goes.
    expect(w.chainCount).toBe(1);
    expect(w.bytes).toBe(200);
  });

  it("asks for a checkout from measure() when a lone chain passes the hard cap", () => {
    const w = new ReplayWindow<Ev>({ windowMs: 60_000, targetBytes: 300, hardCapBytes: 500, sizeOf: () => 100, deferSizing: true });
    w.push(meta(0));
    w.push(full(0));
    for (let t = 1; t < 6; t++) expect(w.push(inc(t))).toBe(false);
    expect(w.measure().needsCheckout).toBe(true);
  });
});
