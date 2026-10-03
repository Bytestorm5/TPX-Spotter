/**
 * `whenQuiet()` — run replay's heavy, unsplittable work (rrweb's full-page
 * snapshot) only when it can't get in the user's way: after the page has
 * loaded, while the tab is visible, with no input in the last `INPUT_QUIET_MS`,
 * and inside an idle period with most of its budget left (the main thread
 * has nothing queued). A page that never goes fully idle (an animation, a
 * polling loop), or a user who never pauses, still gets its turn after
 * `maxWaitMs`: then any idle callback will do, in a gap between inputs.
 *
 * Input times come from one set of passive capture listeners shared by every
 * waiter (`trackInput()`); the replay chunk installs them when it starts.
 */

/** No pointer / key / touch / wheel input for this long before heavy work starts. */
export const INPUT_QUIET_MS = 1500;
/** ...relaxed to this once `maxWaitMs` has passed. */
export const INPUT_GAP_MS = 250;
/** An idle period with at least this much left means nothing else is waiting (browsers cap it at 50 ms). */
export const MIN_IDLE_MS = 40;

type IdleDeadline = { timeRemaining(): number; didTimeout?: boolean };
type Ric = (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => number;

let lastInput = 0;
let tracking = 0;
const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
const onInput = () => {
  lastInput = Date.now();
};

/** Start noting input times (ref-counted). Returns the matching release. */
export function trackInput(): () => void {
  if (typeof window === "undefined") return () => {};
  if (tracking++ === 0) {
    for (const t of INPUT_EVENTS) window.addEventListener(t, onInput, { capture: true, passive: true });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--tracking === 0) {
      for (const t of INPUT_EVENTS) window.removeEventListener(t, onInput, { capture: true });
    }
  };
}

/** For tests. */
export function noteInput(at = Date.now()): void {
  lastInput = at;
}

export interface QuietOptions {
  /** After this long, any idle callback clear of input will do. Default 10 s. */
  maxWaitMs?: number;
  /** Never sooner than this long after the page's `load` (the first moments are when people tap most). Default 0. */
  afterLoadMs?: number;
}

/**
 * Call `fn` once the page is quiet (see the file comment). Returns a cancel
 * function. Without `requestIdleCallback` (Safari) it polls with short
 * timeouts and takes one that fires on time as an idle moment.
 */
export function whenQuiet(fn: () => void, options: QuietOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const afterLoadMs = options.afterLoadMs ?? 0;
  const ric = (window as unknown as { requestIdleCallback?: Ric }).requestIdleCallback;
  const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  let cancelled = false;
  let idleHandle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = 0;
  let loadedAt: number | undefined;
  const listeners: (() => void)[] = [];

  const once = (target: EventTarget, type: string, cb: () => void) => {
    const h = () => {
      target.removeEventListener(type, h);
      cb();
    };
    target.addEventListener(type, h);
    listeners.push(() => target.removeEventListener(type, h));
  };

  const wait = (ms: number) => {
    timer = setTimeout(check, ms);
  };

  const onIdle = (deadline: IdleDeadline) => {
    idleHandle = undefined;
    if (cancelled) return;
    if (document.visibilityState === "hidden") return once(document, "visibilitychange", check);
    const patient = Date.now() - started < maxWaitMs;
    // Past the patience window a gap between taps will do: someone who never stops interacting still gets recorded.
    const quietFor = patient ? INPUT_QUIET_MS : INPUT_GAP_MS;
    const sinceInput = Date.now() - lastInput;
    if (sinceInput < quietFor) return wait(quietFor - sinceInput);
    if (patient && !deadline.didTimeout && deadline.timeRemaining() < MIN_IDLE_MS) return wait(50);
    fn();
  };

  function check() {
    timer = undefined;
    if (cancelled) return;
    if (document.readyState !== "complete") return once(window, "load", check);
    if (document.visibilityState === "hidden") return once(document, "visibilitychange", check);
    if (afterLoadMs > 0) {
      // Pinned once: without a navigation entry (or before it records the load), "now" is when we saw it loaded.
      loadedAt ??= (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.loadEventEnd || performance.now();
      const until = loadedAt + afterLoadMs - performance.now();
      if (until > 0) return wait(until);
    }
    if (!started) started = Date.now();
    // Past the patience window, an idle callback forced by its timeout still runs us (an always-busy page).
    if (ric) idleHandle = ric(onIdle, { timeout: Math.max(1000, maxWaitMs) });
    else {
      // No requestIdleCallback (Safari): a timer that fires on time means nothing else was running.
      const due = Date.now() + 200;
      timer = setTimeout(() => {
        const onTime = Date.now() - due < 20;
        onIdle({ timeRemaining: () => (onTime ? MIN_IDLE_MS : 0), didTimeout: Date.now() - started >= maxWaitMs });
      }, 200);
    }
  }

  check();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    if (idleHandle !== undefined) cic?.(idleHandle);
    for (const off of listeners.splice(0)) off();
  };
}

/**
 * Run `fn` in idle time, in slices: `fn(more)` should stop when `more()` is
 * false and return true if work remains, and it is scheduled again.
 */
export function idleSlices(fn: (more: () => boolean) => boolean): () => void {
  if (typeof window === "undefined") return () => {};
  const ric = (window as unknown as { requestIdleCallback?: Ric }).requestIdleCallback;
  const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  let handle: number | ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const step = (deadline: IdleDeadline) => {
    handle = undefined;
    if (cancelled) return;
    // A forced (timed-out) callback still does one unit of work, so a busy page can't grow the backlog forever.
    let first = true;
    const more = () => {
      if (first) {
        first = false;
        return true;
      }
      return deadline.timeRemaining() > 2;
    };
    if (fn(more) && !cancelled) schedule();
  };
  const schedule = () => {
    if (ric) handle = ric(step, { timeout: 2000 });
    else {
      const until = () => Date.now() + 8;
      handle = setTimeout(() => {
        const end = until();
        step({ timeRemaining: () => end - Date.now() });
      }, 50);
    }
  };
  schedule();
  return () => {
    cancelled = true;
    if (handle === undefined) return;
    if (ric && typeof handle === "number") cic?.(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  };
}
