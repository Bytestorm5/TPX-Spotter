/**
 * The engine: what loads on idle after `init()` in the browser (and on
 * first use on the server). It holds only what must run from the start —
 * the capture signals (errors, console, network, navigation, actions), the
 * shared breadcrumb buffer, and the switches for replay and analytics — so
 * "core once initialized" stays inside its 15 KB budget. Signals hold raw,
 * bounded records; redaction, serialization, stack parsing and HAR building
 * run at snapshot time in the session chunk (nothing is sent before a
 * snapshot).
 *
 * Everything that is only needed once the user engages or something is
 * filed — transport, the offline queue, flags, the report pipeline, the
 * widget flow, remote config, performance metrics, page / storage /
 * environment collection — lives in the `session` chunk (`session.ts`),
 * loaded on first interaction, on the first report / flag / capture, on
 * trigger hover (`preload`), or when analytics starts. Replay, screenshot,
 * recording and analytics are their own lazy chunks behind `FEATURE_*`.
 */
import { installActions } from "./capture/actions.ts";
import { installConsole } from "./capture/console.ts";
import { installErrors, rawError, type RawError } from "./capture/errors.ts";
import { installNavigation } from "./capture/navigation.ts";
import { installNetwork } from "./capture/network.ts";
import { RingBuffer } from "./buffer.ts";
import { analyticsAllowed, replayAllowed } from "./consent.ts";
import type { ResolvedConfig } from "./config.ts";
import { devWarn } from "./dev.ts";
import { DEV, FEATURE_ANALYTICS, FEATURE_REPLAY, type FeatureName } from "./features.ts";
import type { RawCrumb, ReplayController, Runtime, Signal } from "./internal.ts";
import type { createRedactor, CustomRedactor, Redactor } from "./redact.ts";
import type { Breadcrumb, ErrorEntry, Json, RemoteConfig, ReleaseInfo, ReporterType } from "./schema.ts";
import type { Session } from "./session.ts";
import type { Attachment, ConsentState, DevDetails, FlagOptions, IdentifyInput, RequestLike, SpotterEvents, SpotterState } from "./types.ts";

// Bundler defines, read inline at each guarded site: a `FEATURE_X` imported
// from features.ts is only known after linking, too late for the bundler to
// drop an `import()` inside a dead branch (the chunk would still be emitted).
// Written inline, `define` folds the condition while this file is parsed.
declare const __SPOTTER_REPLAY__: boolean | undefined;
declare const __SPOTTER_ANALYTICS__: boolean | undefined;
declare const __SPOTTER_DEV__: boolean | undefined;

/** Enrichment set through the client's API, shared with the engine by reference. */
export interface Scope {
  user: IdentifyInput | null;
  contexts: Record<string, Record<string, Json>>;
  tags: Record<string, string>;
  flags: Record<string, Json>;
  attachments: Attachment[];
  redactor: CustomRedactor | null;
  routeResolver: ((url: string) => string | undefined) | null;
}

export interface EngineHost {
  config(): ResolvedConfig;
  readonly sessionId: string;
  readonly scope: Scope;
  consent(): ConsentState;
  emit<E extends keyof SpotterEvents>(event: E, payload: SpotterEvents[E]): void;
  setState(state: SpotterState): void;
  reporter(): { type: ReporterType; name?: string; teamToken?: string; guestToken?: string };
  /** Errors and breadcrumbs caught by the loader before the engine arrived. */
  takeEarly(): { errors: { error: unknown; mechanism: "uncaught" | "unhandledrejection"; at: number }[]; crumbs: Breadcrumb[] };
  /** Remote config was fetched and narrowed: store the effective config. */
  setRemote(config: ResolvedConfig, remote: RemoteConfig): void;
  /** Code config without remote narrowing (re-narrowed after a second `init`). */
  baseConfig(): ResolvedConfig;
  remote(): RemoteConfig | null;
}

/** What the session chunk gets from the engine. */
export interface EngineCore {
  readonly host: EngineHost;
  readonly browser: boolean;
  readonly runtime: Runtime;
  /** Install (once) and return the redactor; `rt.redact` / `rt.redactUrl` work from then on. */
  useRedactor(make: typeof createRedactor): Redactor;
  /** Raw, like every signal snapshot: finished by `capture/finalize.ts` / `stack.ts` at snapshot. */
  readonly earlyErrors: RawError[];
  cfg(): ResolvedConfig;
  crumbs(): RawCrumb[];
  snap<T>(name: string, fallback: T): T;
  signal(name: string): Signal<unknown> | undefined;
  install<T>(name: string, fn: () => Signal<T>): void;
  replay(): ReplayController | null;
  release(): ReleaseInfo;
  routePattern(url?: string): string | undefined;
  reconfigure(): void;
  isDestroyed(): boolean;
}

export interface Engine {
  readonly runtime: Runtime;
  start(): void;
  /** Load (once) the session chunk. Reports, the widget flow and the closed loop are called on it directly. */
  session(): Promise<Session>;
  flag(name: string, options?: FlagOptions, request?: RequestLike): void;
  flush(): Promise<void>;
  track(name: string, props?: Record<string, string | number | boolean>, revenue?: { value: number; currency: string }): void;
  pageview(url?: string, routePattern?: string): void;
  breadcrumb(crumb: Breadcrumb): void;
  discardCapture(id: string): void;
  devDetails(captureId?: string): DevDetails | null;
  /** First interaction: remote config + offline queue. */
  engage(): Promise<void>;
  /** Re-evaluate features / consent (after remote config, a second init or setConsent). */
  reconfigure(): void;
  destroy(): void;
}

interface AnalyticsHandle {
  track(n: string, p?: Record<string, string | number | boolean>, r?: { value: number; currency: string }): void;
  pageview(u?: string, r?: string): void;
  noteError(e?: Pick<ErrorEntry, "type" | "message">): void;
  flush(beacon?: boolean): void;
  destroy(): void;
}

export function createEngine(host: EngineHost): Engine {
  const cfg = () => host.config();
  const browser = cfg().runtime === "browser";
  const scope = host.scope;
  // Redaction (and its regex set) arrives with the session chunk or with replay, whichever loads first:
  // signals hold raw records until a snapshot, and nothing is sent before one.
  let redactor: Redactor | null = null;
  const useRedactor = (make: typeof createRedactor) => (redactor ??= make(cfg().privacy ?? {}, () => scope.redactor));
  const crumbs = new RingBuffer<RawCrumb>(cfg().capture?.breadcrumbs ?? 100, 256 * 1024);
  const earlyErrors: RawError[] = [];
  const signals = new Map<string, Signal<unknown>>();
  const cleanups: (() => void)[] = [];
  let replay: ReplayController | null = null;
  let replayStarting = false;
  let analytics: AnalyticsHandle | null = null;
  let analyticsStarting = false;
  let sessionPromise: Promise<Session> | null = null;
  let loaded: Session | null = null;
  let started = false;
  let destroyed = false;

  const disabled = (signal: string) => cfg().capture?.disable?.includes(signal as never) ?? false;
  const enabled = (f: FeatureName) => cfg().features[f];

  const release = (): ReleaseInfo => {
    const r = cfg().release ?? {};
    return { ...r, ...(cfg().environment ? { environment: cfg().environment } : {}) };
  };

  const routePattern = (url?: string): string | undefined => {
    try {
      return scope.routeResolver?.(url ?? (browser ? location.href : "")) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const runtime: Runtime = {
    get config() {
      return cfg();
    },
    sessionId: host.sessionId,
    now: () => Date.now(),
    // Not loaded yet: mask entirely rather than let anything through unredacted.
    redact: (v, w) => (redactor ? redactor.redact(v, w) : "[redacted]"),
    redactUrl: (u) => (redactor ? redactor.redactUrl(u) : "[redacted]"),
    breadcrumb: (c) => crumbs.push(c),
    error(entry) {
      if (FEATURE_REPLAY && replay && replay.mode === "on_error") void replay.uploadSegment(`error:${entry.type}`).catch(() => {});
      if (FEATURE_ANALYTICS) analytics?.noteError(entry);
    },
    navigated(entry) {
      if (FEATURE_ANALYTICS) analytics?.pageview(entry.to, entry.routePattern);
    },
    fault(name, error) {
      if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn(`${name} capture was disabled after an internal error: ${(error as Error)?.message ?? String(error)}`);
      const s = signals.get(name);
      signals.delete(name);
      try {
        s?.destroy();
      } catch {
        /* already broken */
      }
    },
    warn(m) {
      if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn(m.replace(/^\[spotter\]\s*/, ""));
    },
    identity: () => (scope.user ? { id: scope.user.id, ...(scope.user.email ? { email: scope.user.email } : {}) } : null),
    flags: () => scope.flags,
    release,
    consent: () => host.consent(),
    routePattern,
  };

  function install<T>(name: string, fn: () => Signal<T>): void {
    if (disabled(name) || signals.has(name) || destroyed) return;
    try {
      signals.set(name, fn() as Signal<unknown>);
    } catch (error) {
      runtime.fault(name, error);
    }
  }

  function snap<T>(name: string, fallback: T): T {
    const s = signals.get(name);
    if (!s) return fallback;
    try {
      return s.snapshot() as T;
    } catch (error) {
      runtime.fault(name, error);
      return fallback;
    }
  }

  const core: EngineCore = {
    host,
    browser,
    runtime,
    useRedactor,
    earlyErrors,
    cfg,
    crumbs: () => crumbs.toArray(),
    snap,
    signal: (n) => signals.get(n),
    install,
    replay: () => replay,
    release,
    routePattern,
    reconfigure: () => reconfigure(),
    isDestroyed: () => destroyed,
  };

  function session(): Promise<Session> {
    sessionPromise ??= import("./session.ts").then((m) => {
      const s = m.createSession(core);
      loaded = s;
      if (destroyed) s.destroy();
      return s;
    });
    return sessionPromise;
  }

  function start(): void {
    if (started || destroyed) return;
    started = true;
    const early = host.takeEarly();
    for (const c of early.crumbs) crumbs.push(c);
    for (const e of early.errors) {
      try {
        earlyErrors.push(rawError(e.error, e.mechanism, e.at));
      } catch {
        /* unreadable */
      }
    }
    if (!browser) return;
    const cap = cfg().capture ?? {};
    const privacy = cfg().privacy ?? {};
    install("errors", () => installErrors(runtime));
    install("console", () => installConsole(runtime, { max: cap.consoleEntries ?? 200 }));
    install("network", () => installNetwork(runtime, { max: cap.networkEntries ?? 100, bodies: privacy.networkBodies ?? [], headers: privacy.networkHeaders ?? [] }));
    install("navigation", () => installNavigation(runtime, { max: cap.navigationHistory ?? 20 }));
    install("actions", () => installActions(runtime));

    const onOnline = () => void session().then((s) => s.drain());
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      void loaded?.flush(true);
      if (FEATURE_ANALYTICS) analytics?.flush(true);
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onHide);
    cleanups.push(() => window.removeEventListener("online", onOnline), () => document.removeEventListener("visibilitychange", onHide));
    reconfigure();
  }

  function reconfigure(): void {
    if (!browser || !started || destroyed) return;
    const consent = host.consent();
    if ((typeof __SPOTTER_REPLAY__ === "boolean" ? __SPOTTER_REPLAY__ : true) && FEATURE_REPLAY) {
      const mode = cfg().replayMode;
      const want = enabled("replay") && replayAllowed(mode, consent);
      if (!want && replay) {
        replay.stop();
        replay = null;
      } else if (want && !replay && !replayStarting) {
        replayStarting = true;
        void startReplayChunk().finally(() => (replayStarting = false));
      }
    }
    if ((typeof __SPOTTER_ANALYTICS__ === "boolean" ? __SPOTTER_ANALYTICS__ : true) && FEATURE_ANALYTICS) {
      const want = enabled("analytics") && analyticsAllowed(cfg().analytics, consent);
      if (!want && analytics) {
        analytics.destroy();
        analytics = null;
      } else if (want && !analytics && !analyticsStarting) {
        analyticsStarting = true;
        void startAnalyticsChunk().finally(() => (analyticsStarting = false));
      }
    }
  }

  /** The `import()` sits inside the positive guard: code after an early return isn't dropped at parse time. */
  let segmentReason: "on_error" | "flag" = "on_error";
  async function startReplayChunk(): Promise<void> {
    if ((typeof __SPOTTER_REPLAY__ === "boolean" ? __SPOTTER_REPLAY__ : true) && FEATURE_REPLAY) {
      try {
        const c = cfg();
        // Sampled mode: decided once per tab session (the session chunk owns the sampling rules).
        if (c.replayMode === "sampled" && !(await session()).sampledIn()) return;
        const { startReplay, createRedactor } = await import("./replay/index.ts");
        if (destroyed || replay) return;
        useRedactor(createRedactor); // replay's error / upload markers are redacted as they are recorded
        replay = await startReplay(runtime, {
          mode: c.replayMode === "off" ? "buffer" : c.replayMode,
          windowSeconds: c.windowSeconds,
          maskText: c.privacy?.maskText ?? "inputs",
          maskSelectors: c.privacy?.maskSelectors ?? [],
          blockSelectors: c.privacy?.blockSelectors ?? [],
          recordCanvas: c.replay?.recordCanvas,
          recordMedia: c.replay?.recordMedia,
          recordIframes: c.replay?.recordIframes,
          beforeReplayEvent: c.beforeReplayEvent,
          uploadSegment: (seq, data) =>
            session().then((s) =>
              s.transport.replaySegment(host.sessionId, seq, data, {
                reason: c.replayMode === "sampled" ? "sampled" : segmentReason,
                ...(runtime.identity()?.id ? { user: runtime.identity()!.id! } : {}),
              }),
            ),
        });
        // Remember why the next segment goes up (`error:…` / `flag:…`) so the ingest files it under the right reason.
        const upload = replay.uploadSegment.bind(replay);
        replay.uploadSegment = (reason: string) => {
          segmentReason = reason.startsWith("flag:") ? "flag" : "on_error";
          return upload(reason);
        };
        if (destroyed) replay.stop();
      } catch (error) {
        runtime.fault("replay", error);
      }
    }
  }

  async function startAnalyticsChunk(): Promise<void> {
    if ((typeof __SPOTTER_ANALYTICS__ === "boolean" ? __SPOTTER_ANALYTICS__ : true) && FEATURE_ANALYTICS) {
      try {
        // With the session chunk: analytics sends through its transport, and beacons on page hide must be synchronous.
        const [{ startAnalytics }, s] = await Promise.all([import("./analytics/index.ts"), session()]);
        if (destroyed || analytics) return;
        analytics = startAnalytics(
          runtime,
          { ...cfg().analytics, environment: cfg().environment },
          (events, opts) => s.sendEvents(events, opts),
          s.performance(),
        );
      } catch (error) {
        runtime.fault("analytics", error);
      }
    }
  }

  const via = <T>(fn: (s: Session) => Promise<T> | T): Promise<T> => session().then(fn);

  return {
    runtime,
    start,
    session,
    flag(name, options, request) {
      const at = Date.now();
      if (loaded) loaded.flag(name, options, request, at);
      else void session().then((s) => s.flag(name, options, request, at));
    },
    async flush() {
      if (FEATURE_ANALYTICS) analytics?.flush();
      if (sessionPromise) await (await sessionPromise).flush();
    },
    track(name, props, revenue) {
      if (!FEATURE_ANALYTICS) return;
      if (analytics) analytics.track(name, props, revenue);
      else if (!browser) void session().then((s) => s.trackServer(name, props, revenue));
      else if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn("track() was called while analytics is off (consent, GPC, remote config, or not started yet); the event was dropped.");
    },
    pageview(url, rp) {
      if (FEATURE_ANALYTICS) analytics?.pageview(url, rp);
    },
    breadcrumb: (c) => crumbs.push(c),
    discardCapture: (id) => loaded?.discardCapture(id),
    devDetails: (id) => loaded?.devDetails(id) ?? null,
    engage: () =>
      via(async (s) => {
        await s.fetchRemote();
        await s.drain();
      }),
    reconfigure() {
      loaded?.reapplyRemote();
      reconfigure();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loaded?.destroy();
      if (FEATURE_ANALYTICS) {
        analytics?.flush(true);
        analytics?.destroy();
        analytics = null;
      }
      replay?.stop();
      replay = null;
      for (const s of signals.values()) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
      signals.clear();
      for (const c of cleanups) c();
    },
  };
}
