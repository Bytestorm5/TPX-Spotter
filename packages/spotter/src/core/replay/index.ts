/**
 * DOM session replay (rrweb), loaded as a lazy chunk behind FEATURE_REPLAY.
 *
 * Modes:
 * - `buffer`: a rolling in-memory window (default 60 s), uploaded only with a report.
 * - `on_error`: the same buffer; the client calls `uploadSegment(reason)` on
 *   uncaught errors and flags.
 * - `sampled`: the whole session, streamed as ~10 s gzip segments.
 *
 * In-app navigations (pushState / popstate) are marked with a
 * `spotter:navigation` custom event, so Console attributes what follows to
 * the right page. In sampled mode the new page also gets a full snapshot
 * once it has settled (NAV_SNAPSHOT_MS after the last navigation): a picture
 * of every page a sampled session visits, which Console draws heatmaps on.
 *
 * Staying out of the page's way: a full snapshot serializes the whole DOM in
 * one synchronous task (~180 ms on a throttled phone), so none is taken on
 * rrweb's own schedule. Recording starts only once the page has loaded,
 * at least START_AFTER_LOAD_MS later, and at a quiet moment (`whenQuiet`:
 * idle main thread, no recent input, tab visible), which is when rrweb takes
 * its first snapshot; periodic checkouts, the
 * post-navigation snapshot and recovery snapshots wait for the same, and a
 * checkout is skipped when nothing has been recorded since the last one.
 * Event sizes (for the buffer's byte budgets) are measured in idle slices,
 * not on every recorded change. A report filed before recording starts has
 * no replay.
 *
 * Privacy is enforced in the recorder, before anything leaves the page:
 * every input value is masked (password values are dropped entirely, even
 * their length); `maskText` masks inputs only, or all text; `data-spotter-mask`
 * / `-block` / `-unmask` and the configured selectors apply; canvas, video,
 * audio and cross-origin iframes are blocked unless opted in by selector; and
 * Spotter's own UI is never recorded.
 */
import { record } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
import type { MaskText } from "../types.ts";
import type { ReplayController, Runtime } from "../internal.ts";
import { isSensitiveInput, isTextMasked, placeholder, UI_ATTR, BLOCK_ATTR, MASK_ATTR, UNMASK_ATTR, validSelectors } from "../capture/mask.ts";
import { compressEvents } from "./compress.ts";
import { idleSlices, trackInput, whenQuiet } from "./quiet.ts";
import { checkoutInterval, clampWindowSeconds, EVENT_FULL_SNAPSHOT, EVENT_INCREMENTAL, ReplayWindow } from "./window.ts";

export { deriveSignals } from "./signals.ts";
/** Replay redacts its error / upload markers as it records: the engine installs the redactor from here when replay loads before the session chunk. */
export { createRedactor } from "../redact.ts";

export interface StartReplayOptions {
  mode: "buffer" | "on_error" | "sampled";
  windowSeconds: number;
  maskText: MaskText;
  maskSelectors: string[];
  blockSelectors: string[];
  recordCanvas?: string[];
  recordMedia?: string[];
  recordIframes?: string[];
  beforeReplayEvent?: (e: unknown) => unknown | null;
  uploadSegment: (seq: number, data: Uint8Array) => Promise<void>;
}

const SEGMENT_MS = 10_000;
const MIN_ERROR_UPLOAD_GAP_MS = 10_000;
const MAX_PENDING_BYTES = 5 * 1024 * 1024;
/** How long after an in-app navigation the new page is snapshotted (sampled mode): long enough for it to render. */
export const NAV_SNAPSHOT_MS = 1500;
/** Recording (and its first full snapshot) never starts sooner than this after `load`... */
const START_AFTER_LOAD_MS = 2_000;
/** ...and starts anyway, in the next input-free idle callback, after this long waiting for a quiet moment. */
const START_MAX_WAIT_MS = 10_000;
/** Longest wait for a quiet moment for a checkout / navigation snapshot. */
const SNAPSHOT_MAX_WAIT_MS = 5_000;

/** `a:not(b, c)` — or `a` when nothing is opted back in. */
function except(tag: string, optIn: string[] | undefined): string {
  const keep = validSelectors(optIn);
  return keep.length ? `${tag}:not(${keep.join(",")})` : tag;
}

/** The recorder's privacy selectors, from config. Exported for tests. */
export function recorderSelectors(options: Pick<StartReplayOptions, "maskText" | "maskSelectors" | "blockSelectors" | "recordCanvas" | "recordMedia">): {
  blockSelector: string;
  maskTextSelector: string;
  mask: string;
} {
  const mask = [`[${MASK_ATTR}]`, ...validSelectors(options.maskSelectors)].join(",");
  const blockSelector = [
    `[${BLOCK_ATTR}]`,
    `[${UI_ATTR}]`,
    ...validSelectors(options.blockSelectors),
    except("canvas", options.recordCanvas),
    except("video", options.recordMedia),
    except("audio", options.recordMedia),
  ].join(",");
  // Under `all` every text node goes through maskTextFn, which honours unmask.
  const maskTextSelector = options.maskText === "all" ? "*" : mask;
  return { blockSelector, maskTextSelector, mask };
}

function inertController(mode: ReplayController["mode"]): ReplayController {
  return {
    mode,
    flush: async () => null,
    uploadSegment: async () => null,
    recentEvents: () => [],
    stop: () => {},
  };
}

export async function startReplay(rt: Runtime, options: StartReplayOptions): Promise<ReplayController> {
  const mode = options.mode;
  if (typeof window === "undefined" || typeof document === "undefined") return inertController(mode);
  // Consent explicitly refused: record nothing. (Undefined = not asked; buffer mode fits legitimate interest.)
  if (rt.consent().replay === false) return inertController(mode);

  const windowSeconds = clampWindowSeconds(options.windowSeconds);
  const buffer = new ReplayWindow<eventWithTime>({ windowMs: windowSeconds * 1000, deferSizing: true });
  const { blockSelector, maskTextSelector, mask } = recorderSelectors(options);
  const rules = { maskText: options.maskText, mask };

  let seq = 0;
  let stopped = false;
  let stopRecording: (() => void) | undefined;
  let lastErrorUpload = 0;
  /** Incremental events since the last full snapshot: no activity, no checkout. */
  let sinceSnapshot = 0;
  let lastSnapshotAt = 0;
  let cancelSnapshot: (() => void) | null = null;
  let cancelSizing: (() => void) | null = null;
  let checkoutTimer: ReturnType<typeof setInterval> | null = null;
  // Sampled mode: events since the last segment.
  let pending: eventWithTime[] = [];
  let pendingBytes = 0;
  let segmentTimer: ReturnType<typeof setInterval> | null = null;
  let uploading: Promise<unknown> = Promise.resolve();
  const cleanups: (() => void)[] = [];
  const hrefNow = () => location.href.split("#")[0] ?? location.href;
  let lastHref = hrefNow();
  let navTimer: ReturnType<typeof setTimeout> | null = null;
  const releaseInput = trackInput();

  /**
   * A full snapshot, at the next quiet moment (one pending at a time).
   * `ifActive`: skip it when nothing was recorded since the last one.
   */
  const snapshotWhenQuiet = (ifActive = false) => {
    if (stopped || cancelSnapshot) return;
    cancelSnapshot = whenQuiet(
      () => {
        cancelSnapshot = null;
        if (stopped || (ifActive && sinceSnapshot === 0)) return;
        try {
          record.takeFullSnapshot(true);
        } catch (error) {
          fault(error);
        }
      },
      { maxWaitMs: SNAPSHOT_MAX_WAIT_MS },
    );
  };

  /** Size the backlog in idle time; the byte budgets apply as it goes. */
  const scheduleSizing = () => {
    if (stopped || cancelSizing) return;
    cancelSizing = idleSlices((more) => {
      if (stopped) return false;
      const { bytes, done, needsCheckout } = buffer.measure(more);
      if (mode === "sampled") {
        pendingBytes += bytes;
        if (pendingBytes > MAX_PENDING_BYTES) void sendSegment();
      }
      if (needsCheckout) snapshotWhenQuiet();
      if (done) cancelSizing = null;
      return !done;
    });
  };

  /** Called from emit: SPA routers change the URL and then mutate the DOM, so any event after a change notices it. */
  const checkNavigation = () => {
    const href = hrefNow();
    if (href === lastHref) return;
    lastHref = href;
    // Outside rrweb's emit call stack.
    setTimeout(() => {
      if (stopped) return;
      try {
        record.addCustomEvent("spotter:navigation", { href: rt.redactUrl(href) });
      } catch {
        /* recorder not ready */
      }
    }, 0);
    if (mode !== "sampled") return;
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      navTimer = null;
      snapshotWhenQuiet();
    }, NAV_SNAPSHOT_MS);
  };

  const fault = (error: unknown) => {
    try {
      rt.fault("replay", error);
    } catch {
      /* never throw into the host */
    }
    stop();
  };

  const emit = (raw: eventWithTime, isCheckout?: boolean) => {
    if (stopped) return;
    try {
      let event: eventWithTime | null = raw;
      if (options.beforeReplayEvent) {
        try {
          event = options.beforeReplayEvent(raw) as eventWithTime | null;
        } catch {
          event = null; // a throwing hook drops the event: the safe side for privacy
        }
        if (!event) return;
      }
      if (mode === "sampled") pending.push(event);
      if (event.type === EVENT_FULL_SNAPSHOT) {
        sinceSnapshot = 0;
        lastSnapshotAt = event.timestamp;
      } else if (event.type === EVENT_INCREMENTAL) sinceSnapshot++;
      checkNavigation();
      // Every mode keeps the rolling window: it's what a report attaches and what the timeline reads.
      buffer.push(event, isCheckout);
      scheduleSizing();
    } catch (error) {
      fault(error);
    }
  };

  const sendSegment = (): Promise<number | null> => {
    if (!pending.length) return Promise.resolve(null);
    const events = pending;
    pending = [];
    pendingBytes = 0;
    const n = seq++;
    const job = uploading.then(async () => {
      try {
        const data = await compressEvents(events);
        await options.uploadSegment(n, data);
        return n;
      } catch {
        // A lost segment breaks the chain: the next segment starts with a fresh snapshot.
        snapshotWhenQuiet();
        return null;
      }
    });
    uploading = job;
    return job;
  };

  /** Start rrweb (it takes its first full snapshot right away) and the timers that go with it. */
  const begin = () => {
    cancelStart = null;
    if (stopped) return;
    try {
      stopRecording = record<eventWithTime>({
        emit,
        // No `checkoutEveryNms`: rrweb would snapshot synchronously inside whatever event crossed the
        // interval (often the user's own click). Checkouts run on the timer below, at quiet moments.
        blockSelector,
        ignoreSelector: `[${UI_ATTR}] *`,
        maskAllInputs: true,
        maskTextSelector,
        maskTextFn: (text, el) => (isTextMasked(el, rules) ? placeholder(text) : text),
        maskInputFn: (text, el) => {
          if (!el || isSensitiveInput(el)) return "";
          return el.closest(`[${UNMASK_ATTR}]`) && !el.closest(`[${MASK_ATTR}]`) ? text : "*".repeat(text.length);
        },
        maskInputOptions: { password: true },
        slimDOMOptions: "all",
        inlineStylesheet: true,
        recordCanvas: (options.recordCanvas?.length ?? 0) > 0,
        recordCrossOriginIframes: (options.recordIframes?.length ?? 0) > 0,
        collectFonts: false,
        inlineImages: false,
        sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
        errorHandler: (error: unknown) => {
          try {
            rt.warn(`[spotter] replay recorder error: ${String((error as Error | null)?.message ?? error)}`);
          } catch {
            /* ignore */
          }
          return true; // swallow: never let recording errors surface in the host
        },
      });
    } catch (error) {
      return fault(error);
    }
    if (!stopRecording) return stop();

    // Errors as custom events: timeline markers, and error clicks for deriveSignals().
    const onError = (event: Event) => {
      if (stopped) return;
      try {
        const e = event as ErrorEvent & PromiseRejectionEvent;
        const err = (e.error ?? e.reason) as { message?: unknown } | undefined;
        const message = String(err?.message ?? e.message ?? "error").slice(0, 200);
        record.addCustomEvent("spotter:error", { message: rt.redact(message, "error") });
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onError, true);
    cleanups.push(() => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onError, true);
    });

    // Periodic checkouts keep the buffer replayable from its start (and bounded); skipped while nothing happens.
    const every = mode === "sampled" ? 5 * 60_000 : checkoutInterval(windowSeconds);
    checkoutTimer = setInterval(() => {
      if (rt.now() - lastSnapshotAt >= every) snapshotWhenQuiet(true);
    }, Math.min(every, 10_000));

    if (mode === "sampled") {
      segmentTimer = setInterval(() => void sendSegment(), SEGMENT_MS);
      // Send what we have when the page goes away (the client's transport decides how).
      const onHide = () => {
        if (document.visibilityState === "hidden") void sendSegment();
      };
      document.addEventListener("visibilitychange", onHide);
      cleanups.push(() => document.removeEventListener("visibilitychange", onHide));
    }
  };

  // rrweb snapshots the whole page as it starts: wait for the page to load and go quiet.
  let cancelStart: (() => void) | null = whenQuiet(begin, { maxWaitMs: START_MAX_WAIT_MS, afterLoadMs: START_AFTER_LOAD_MS });

  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      stopRecording?.();
    } catch {
      /* ignore */
    }
    if (segmentTimer) clearInterval(segmentTimer);
    if (checkoutTimer) clearInterval(checkoutTimer);
    if (navTimer) clearTimeout(navTimer);
    cancelStart?.();
    cancelSnapshot?.();
    cancelSizing?.();
    releaseInput();
    for (const fn of cleanups.splice(0)) fn();
    buffer.clear();
    pending = [];
  }

  const flush: ReplayController["flush"] = async () => {
    const events = buffer.events();
    if (!events.length) return null;
    const first = events[0] as eventWithTime;
    const last = events[events.length - 1] as eventWithTime;
    const data = await compressEvents(events);
    return {
      data,
      startedAt: new Date(first.timestamp).toISOString(),
      endedAt: new Date(last.timestamp).toISOString(),
      events: events.length,
    };
  };

  return {
    mode,
    flush,
    async uploadSegment(reason: string) {
      if (stopped) return null;
      try {
        record.addCustomEvent("spotter:upload", { reason: rt.redact(String(reason).slice(0, 100), "context") });
      } catch {
        /* recorder not ready */
      }
      if (mode === "sampled") return sendSegment();
      const now = rt.now();
      if (now - lastErrorUpload < MIN_ERROR_UPLOAD_GAP_MS) return null;
      lastErrorUpload = now;
      const events = buffer.events();
      if (!events.length) return null;
      const n = seq++;
      try {
        const data = await compressEvents(events);
        await options.uploadSegment(n, data);
        return n;
      } catch {
        return null;
      }
    },
    recentEvents: () => buffer.events(),
    stop,
  };
}
