/**
 * DOM session replay (rrweb), loaded as a lazy chunk behind FEATURE_REPLAY.
 *
 * Modes:
 * - `buffer`: a rolling in-memory window (default 60 s), uploaded only with a report.
 * - `on_error`: the same buffer; the client calls `uploadSegment(reason)` on
 *   uncaught errors and flags.
 * - `sampled`: the whole session, streamed as ~10 s gzip segments.
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
import { checkoutInterval, clampWindowSeconds, estimateEventSize, ReplayWindow } from "./window.ts";

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
  const buffer = new ReplayWindow<eventWithTime>({ windowMs: windowSeconds * 1000, sizeOf: estimateEventSize });
  const { blockSelector, maskTextSelector, mask } = recorderSelectors(options);
  const rules = { maskText: options.maskText, mask };

  let seq = 0;
  let stopped = false;
  let stopRecording: (() => void) | undefined;
  let lastCheckoutRequest = 0;
  let lastErrorUpload = 0;
  // Sampled mode: events since the last segment.
  let pending: eventWithTime[] = [];
  let pendingBytes = 0;
  let segmentTimer: ReturnType<typeof setInterval> | null = null;
  let uploading: Promise<unknown> = Promise.resolve();
  const cleanups: (() => void)[] = [];

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
      if (mode === "sampled") {
        pending.push(event);
        pendingBytes += estimateEventSize(event);
        if (pendingBytes > MAX_PENDING_BYTES) void sendSegment();
      }
      // Every mode keeps the rolling window: it's what a report attaches and what the timeline reads.
      const needsCheckout = buffer.push(event, isCheckout);
      if (needsCheckout && event.timestamp - lastCheckoutRequest > 5000) {
        lastCheckoutRequest = event.timestamp;
        // Outside rrweb's emit call stack.
        setTimeout(() => {
          if (!stopped) record.takeFullSnapshot(true);
        }, 0);
      }
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
        if (!stopped) record.takeFullSnapshot(true);
        return null;
      }
    });
    uploading = job;
    return job;
  };

  try {
    stopRecording = record<eventWithTime>({
      emit,
      checkoutEveryNms: mode === "sampled" ? 5 * 60_000 : checkoutInterval(windowSeconds),
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
    fault(error);
    return inertController(mode);
  }
  if (!stopRecording) return inertController(mode);

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

  if (mode === "sampled") {
    segmentTimer = setInterval(() => void sendSegment(), SEGMENT_MS);
    // Send what we have when the page goes away (the client's transport decides how).
    const onHide = () => {
      if (document.visibilityState === "hidden") void sendSegment();
    };
    document.addEventListener("visibilitychange", onHide);
    cleanups.push(() => document.removeEventListener("visibilitychange", onHide));
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      stopRecording?.();
    } catch {
      /* ignore */
    }
    if (segmentTimer) clearInterval(segmentTimer);
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
