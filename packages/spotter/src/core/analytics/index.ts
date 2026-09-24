/**
 * Privacy-first web analytics (behind FEATURE_ANALYTICS): pageviews (SPA
 * included), sources, engagement, automatic events, custom events and Web
 * Vitals, batched.
 *
 * Cookieless by default: no visitor id, no cookies, no localStorage — only a
 * tab-scoped session id in sessionStorage. `mode: "cookie"` adds a
 * first-party `_spotter_vid` cookie. Nothing is sent when analytics consent
 * is refused, or when GPC / DNT are set and honoured; `identify` links a user
 * id only with `analytics.identify` AND consent.
 *
 * Wiring (the client's side):
 * - call `pageview()` from `rt.navigated` (the initial load is counted here;
 *   repeats of the current URL are ignored, so double calls are harmless);
 * - call `noteError(entry)` from `rt.error` for the per-page `js_error` event.
 *
 * Engagement is sent as deltas (`engagedMs` since the last engagement event
 * for the same `pageviewId`; `scrollDepth` is the max so far): the ingest sums
 * `engagedMs` and takes the max depth per pageview.
 */
import type { AnalyticsEvent, ErrorEntry } from "../schema.ts";
import type { AnalyticsConfig } from "../types.ts";
import type { Runtime } from "../internal.ts";

export { channelFor } from "./channels.ts";

type Props = Record<string, string | number | boolean>;
type Vitals = NonNullable<AnalyticsEvent["vitals"]>;

export interface AnalyticsController {
  track(name: string, props?: Props, revenue?: { value: number; currency: string }): void;
  pageview(url?: string, routePattern?: string): void;
  /** Count a JS error against the current page (`js_error` event). */
  noteError(entry?: Pick<ErrorEntry, "type" | "message">): void;
  /** Send what's queued now. */
  flush(beacon?: boolean): void;
  destroy(): void;
}

const CLICK_IDS = ["gclid", "fbclid", "msclkid", "ttclid", "twclid", "li_fat_id", "dclid", "gbraid", "wbraid"];
const DOWNLOADS = "pdf zip dmg exe msi pkg csv xlsx docx pptx mp3 mp4 mov gz rar 7z apk iso".split(" ");
const FLUSH_MS = 5000;
const FLUSH_AT = 20;
const MAX_QUEUE = 200;
const MAX_ERRORS_PER_PAGE = 10;
const VID_COOKIE = "_spotter_vid";
const SID_KEY = "_spotter_sid";

const rid = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
};

/** Stable 0–1 bucket for a session id (FNV-1a), so sampling needs no storage. */
export function sampleBucket(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

const stripHash = (url: string) => url.split("#")[0] ?? url;

export function startAnalytics(
  rt: Runtime,
  config: AnalyticsConfig & { environment?: string },
  send: (events: AnalyticsEvent[], opts: { beacon: boolean }) => void,
  perf?: { onVitals(cb: (v: Vitals) => void): () => void },
): AnalyticsController {
  const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
  const auto = { outbound: true, download: true, form_submit: true, "404": true, js_error: true, ...config.autoEvents };
  const exts = new Set((config.downloadExtensions ?? DOWNLOADS).map((e) => e.replace(/^\./, "").toLowerCase()));
  const undo: (() => void)[] = [];
  let queue: AnalyticsEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  // -- identity -----------------------------------------------------------------------------
  let sessionId = rt.sessionId;
  let visitorId: string | undefined;
  if (hasDom) {
    try {
      sessionId = sessionStorage.getItem(SID_KEY) || sessionId || rid();
      sessionStorage.setItem(SID_KEY, sessionId);
    } catch {
      /* storage blocked: the runtime's tab id */
    }
    if (config.mode === "cookie") {
      try {
        const m = /(?:^|;\s*)_spotter_vid=([^;]+)/.exec(document.cookie);
        visitorId = m?.[1] ?? rid();
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${VID_COOKIE}=${visitorId}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
      } catch {
        visitorId = undefined;
      }
    }
  }
  const sampled = sampleBucket(sessionId || "") < (config.sampleRate ?? 1);

  const allowed = (): boolean => {
    if (destroyed || !sampled) return false;
    try {
      if (rt.consent().analytics === false) return false;
      if (hasDom) {
        const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
        if (config.honorGpc && nav.globalPrivacyControl === true) return false;
        const w = window as Window & { doNotTrack?: string };
        if (config.honorDnt && (nav.doNotTrack === "1" || w.doNotTrack === "1")) return false;
      }
    } catch {
      return false;
    }
    return true;
  };

  // -- page state -------------------------------------------------------------------------------
  let page: { id: string; url: string; path: string; routePattern?: string } | null = null;
  let firstPage = true;
  let engagedMs = 0;
  let visibleSince: number | null = null;
  let scrollDepth = 0;
  let sentDepth = -1;
  let vitals: Vitals = {};
  let vitalsSent = false;
  let errorsThisPage = 0;

  const base = (type: AnalyticsEvent["type"]): AnalyticsEvent => {
    const e: AnalyticsEvent = { type, at: new Date(rt.now()).toISOString(), url: page?.url ?? "", pageviewId: page?.id ?? "" };
    if (page?.routePattern) e.routePattern = page.routePattern;
    if (sessionId) e.sessionId = sessionId;
    if (visitorId) e.visitorId = visitorId;
    if (config.identify && rt.consent().analytics === true) {
      const id = rt.identity()?.id;
      if (id) e.userId = id;
    }
    return e;
  };

  const flush = (beacon = false) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    if (!allowed()) return;
    try {
      send(events, { beacon });
    } catch {
      /* transport's problem; analytics is best-effort */
    }
  };

  const enqueue = (e: AnalyticsEvent) => {
    if (!allowed()) return;
    queue.push(e);
    if (queue.length > MAX_QUEUE) queue.shift();
    if (queue.length >= FLUSH_AT) flush();
    else if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
  };

  const now = () => rt.now();
  const pauseClock = () => {
    if (visibleSince !== null) engagedMs += Math.max(0, now() - visibleSince);
    visibleSince = null;
  };
  const resumeClock = () => {
    if (visibleSince === null && (!hasDom || document.visibilityState !== "hidden")) visibleSince = now();
  };

  /** Close out the current page's engagement (a delta) and, once, its vitals. */
  const closePage = (final: boolean) => {
    if (!page) return;
    pauseClock();
    if (engagedMs > 0 || scrollDepth > sentDepth) {
      const e = base("engagement");
      e.engagedMs = Math.round(engagedMs);
      e.scrollDepth = scrollDepth;
      enqueue(e);
      engagedMs = 0;
      sentDepth = scrollDepth;
    }
    if (!vitalsSent && Object.keys(vitals).length) {
      const e = base("vitals");
      e.vitals = { ...vitals };
      enqueue(e);
      vitalsSent = true;
    }
    if (!final) resumeClock();
  };

  const checkNotFound = () => {
    if (!auto["404"] || !hasDom) return;
    try {
      const nf = config.notFound;
      const hit =
        (typeof nf === "function" && nf() === true) ||
        (typeof nf === "string" && !!document.querySelector(nf)) ||
        document.querySelector('meta[name="spotter:status"]')?.getAttribute("content") === "404";
      if (hit) {
        const e = base("event");
        e.name = "404";
        e.props = { path: page?.path ?? "" };
        enqueue(e);
      }
    } catch {
      /* bad selector / throwing callback */
    }
  };

  const pageview = (url?: string, routePattern?: string) => {
    if (destroyed || !hasDom) return;
    try {
      const raw = stripHash(url ?? location.href);
      const redacted = rt.redactUrl(raw);
      if (page && page.url === redacted) return; // same page: load + navigated, or replaceState noise
      closePage(false);
      let path = redacted;
      let search = "";
      try {
        const u = new URL(raw, location.href);
        path = rt.redactUrl(u.pathname);
        search = u.search;
      } catch {
        /* keep the redacted URL */
      }
      page = { id: rid(), url: redacted, path };
      const pattern = routePattern ?? rt.routePattern(raw);
      if (pattern) page.routePattern = pattern;
      scrollDepth = 0;
      sentDepth = -1;
      engagedMs = 0;
      vitals = {};
      vitalsSent = false;
      errorsThisPage = 0;
      visibleSince = null;
      resumeClock();

      const e = base("pageview");
      const params = new URLSearchParams(search);
      const utm: NonNullable<AnalyticsEvent["utm"]> = {};
      for (const k of ["source", "medium", "campaign", "term", "content"] as const) {
        const v = params.get(`utm_${k}`);
        if (v) utm[k] = rt.redact(v.slice(0, 200), "url");
      }
      if (Object.keys(utm).length) e.utm = utm;
      const ids = CLICK_IDS.filter((k) => params.has(k));
      if (ids.length) e.clickIds = ids;
      if (firstPage) {
        const ref = document.referrer;
        try {
          if (ref && new URL(ref).host !== location.host) e.referrer = rt.redactUrl(ref);
        } catch {
          /* unparsable referrer */
        }
      }
      firstPage = false;
      e.screen = { width: screen.width, height: screen.height };
      e.language = navigator.language;
      const release = rt.release();
      const environment = config.environment ?? release.environment;
      e.release = environment ? { ...release, environment } : release;
      const flags = rt.flags();
      if (Object.keys(flags).length) e.flags = flags;
      enqueue(e);
      // SPA frameworks set the title (and render a 404) just after the URL changes.
      const current = page;
      setTimeout(() => {
        if (page !== current) return;
        try {
          if (document.title) e.title = rt.redact(document.title.slice(0, 300), "text");
        } catch {
          /* ignore */
        }
        checkNotFound();
      }, 100);
    } catch {
      /* analytics must never throw */
    }
  };

  const track: AnalyticsController["track"] = (name, props, revenue) => {
    if (destroyed || !page) return;
    try {
      const e = base("event");
      e.name = String(name).slice(0, 100);
      if (props) {
        const clean: Props = {};
        for (const [k, v] of Object.entries(props).slice(0, 30)) {
          const t = typeof v;
          if (t === "string" || t === "boolean" || (t === "number" && Number.isFinite(v))) {
            clean[k.slice(0, 50)] = t === "string" ? rt.redact((v as string).slice(0, 256), "context") : v;
          }
        }
        e.props = clean;
      }
      if (revenue && Number.isFinite(revenue.value) && typeof revenue.currency === "string") {
        e.revenue = { value: revenue.value, currency: revenue.currency.slice(0, 3).toUpperCase() };
      }
      enqueue(e);
    } catch {
      /* never throw */
    }
  };

  // -- automatic events and engagement listeners ---------------------------------------------
  if (hasDom) {
    const on = (t: EventTarget, type: string, fn: (e: Event) => void) => {
      t.addEventListener(type, fn, { capture: true, passive: true });
      undo.push(() => t.removeEventListener(type, fn, { capture: true }));
    };
    on(document, "click", (ev) => {
      try {
        const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || a.closest("[data-spotter-ui]")) return;
        const u = new URL(a.href, location.href);
        const ext = /\.([a-z0-9]+)$/i.exec(u.pathname)?.[1]?.toLowerCase();
        const kind =
          auto.download && (a.hasAttribute("download") || (ext && exts.has(ext)))
            ? "download"
            : auto.outbound && /^https?:$/.test(u.protocol) && u.host !== location.host
              ? "outbound"
              : null;
        if (kind) track(kind, { url: rt.redactUrl(u.origin + u.pathname) });
      } catch {
        /* odd href */
      }
    });
    on(document, "submit", (ev) => {
      if (!auto.form_submit) return;
      try {
        const form = ev.target as HTMLFormElement;
        if (form.closest?.("[data-spotter-ui]")) return;
        const props: Props = {};
        const id = form.getAttribute("id") || form.getAttribute("name");
        if (id) props.form = id.slice(0, 100);
        track("form_submit", props);
      } catch {
        /* ignore */
      }
    });
    let scrollQueued = false;
    on(window, "scroll", () => {
      if (scrollQueued) return;
      scrollQueued = true;
      setTimeout(() => {
        scrollQueued = false;
        try {
          const doc = document.documentElement;
          const depth = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / Math.max(1, doc.scrollHeight)) * 100));
          if (depth > scrollDepth) scrollDepth = depth;
        } catch {
          /* ignore */
        }
      }, 200);
    });
    on(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        closePage(true);
        flush(true);
      } else {
        resumeClock();
      }
    });
    on(window, "pagehide", () => {
      closePage(true);
      flush(true);
    });
    if (perf) {
      undo.push(
        perf.onVitals((v) => {
          vitals = { ...v };
        }),
      );
    }
    pageview();
  }

  return {
    track,
    pageview,
    noteError(entry) {
      if (!auto.js_error || !page || errorsThisPage >= MAX_ERRORS_PER_PAGE) return;
      errorsThisPage++;
      const e = base("event");
      e.name = "js_error";
      e.props = { type: String(entry?.type ?? "Error").slice(0, 100), message: rt.redact(String(entry?.message ?? "").slice(0, 200), "error") };
      enqueue(e);
    },
    flush,
    destroy() {
      if (destroyed) return;
      closePage(true);
      flush(true);
      destroyed = true;
      for (const fn of undo.splice(0)) fn();
      if (timer) clearTimeout(timer);
    },
  };
}
