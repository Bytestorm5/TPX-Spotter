/**
 * The engine: the half of the client that loads on idle (browser) or on
 * first use (server). `client.ts` stays small enough for the < 6 KB loader
 * budget — config, state, events, enrichment, scheduling — and everything
 * with weight lives here: capture signals, the report pipeline, transport,
 * the offline queue, flags, analytics wiring, remote config and the widget
 * flow. Heavy features (replay, screenshot, recording) are further lazy
 * chunks behind their `FEATURE_*` constants.
 *
 * Report pipeline (browser and server):
 *   include defaults → beforeCapture → snapshot signals → screenshot / replay
 *   flush / DOM snapshot / attachments as artifacts → submission (redacted,
 *   capped at ~1.9 MB) → beforeSend → submit (or queue + provisional
 *   receipt) → `submit` / `sent` / `issue` events → background chunked
 *   uploads → complete.
 */
import { startAnalytics as startAnalyticsImpl } from "./analytics/index.ts";
import { collectEnvironment } from "./capture/environment.ts";
import { errorEntryFrom } from "./capture/errors.ts";
import { installActions } from "./capture/actions.ts";
import { installConsole } from "./capture/console.ts";
import { installErrors } from "./capture/errors.ts";
import { installNavigation, type NavigationSnapshot } from "./capture/navigation.ts";
import { installNetwork, type NetworkSignal } from "./capture/network.ts";
import { collectPage, domSnapshot } from "./capture/page.ts";
import { installPerformance, type PerformanceSignal } from "./capture/performance.ts";
import { collectStorage } from "./capture/storage.ts";
import { RingBuffer } from "./buffer.ts";
import { analyticsAllowed, replayAllowed } from "./consent.ts";
import { replaySampleRate, type ResolvedConfig } from "./config.ts";
import { devWarn } from "./dev.ts";
import {
  FEATURE_ANALYTICS,
  FEATURE_ANNOTATE,
  FEATURE_FLAGS,
  FEATURE_RECORDING,
  FEATURE_REPLAY,
  FEATURE_SCREENSHOT,
  type FeatureName,
} from "./features.ts";
import { SpotterDroppedError } from "./errors.ts";
import { deriveFingerprint } from "./fingerprint.ts";
import { createFlagger, type Flagger } from "./flags.ts";
import { iso, isPendingId, pendingRef, randomId, SDK_NAME, SDK_VERSION, shortId } from "./ids.ts";
import type { ReplayController, Runtime, ScreenshotResult, Signal } from "./internal.ts";
import { lookupReport, noteStatus, rememberReport, resolvePending } from "./receipts.ts";
import { createRedactor, type CustomRedactor, type Redactor } from "./redact.ts";
import {
  REPORT_SCHEMA_ID,
  type ArtifactKind,
  type Breadcrumb,
  type ConsoleEntry,
  type EnvironmentInfo,
  type ErrorEntry,
  type Har,
  type Json,
  type RemoteConfig,
  type ReportReceipt,
  type ReportStatusView,
  type ReportSubmission,
  type ReporterType,
  type SdkInfo,
  type SimilarIssue,
  type StorageSnapshot,
  type PerformanceSnapshot,
} from "./schema.ts";
import { buildTimeline } from "./timeline.ts";
import { uploadAndComplete, drainQueue } from "./transport/deliver.ts";
import { createHttpTransport } from "./transport/http.ts";
import { createQueue, memoryQueue, type OfflineQueue, type QueuedArtifact } from "./transport/queue.ts";
import { isRetryable } from "./transport/retry.ts";
import type {
  Attachment,
  AttachmentSummary,
  ConsentState,
  ExceptionContext,
  FlagOptions,
  IdentifyInput,
  PreloadableFeature,
  RecordingSession,
  ReportInput,
  RequestLike,
  SpotterEvents,
  SpotterState,
  Transport,
  WidgetCapture,
  WidgetCaptureOptions,
  WidgetDraft,
} from "./types.ts";

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
  /** Apply (narrow) remote config; returns the effective config. */
  applyRemote(remote: RemoteConfig): ResolvedConfig;
}


type Include = Required<NonNullable<ReportInput["include"]>>;

interface Snapshot {
  at: number;
  console: ConsoleEntry[];
  errors: ErrorEntry[];
  network: Har;
  breadcrumbs: Breadcrumb[];
  navigation: NavigationSnapshot;
  performance?: PerformanceSnapshot;
  storage?: StorageSnapshot;
  environment: EnvironmentInfo;
  page: { url: string; routePattern?: string; title?: string; referrer?: string; selector?: string; domExcerpt?: string; nearbyText?: string };
  traceparents: string[];
  dom?: string;
}

interface PendingCapture {
  snapshot: Snapshot;
  screenshot?: ScreenshotResult;
  replay?: Promise<{ data: Uint8Array; startedAt: string; endedAt: string } | null>;
  at: number;
}

interface Built {
  submission: ReportSubmission;
  artifacts: QueuedArtifact[];
}

export interface Engine {
  readonly runtime: Runtime;
  readonly transport: Transport;
  start(): void;
  report(input: ReportInput, source?: ReportSubmission["source"]): Promise<ReportReceipt>;
  captureException(error: unknown, context?: ExceptionContext, mechanism?: ErrorEntry["mechanism"]): Promise<ReportReceipt | null>;
  flag(name: string, options?: FlagOptions, request?: RequestLike): void;
  flush(): Promise<void>;
  track(name: string, props?: Record<string, string | number | boolean>, revenue?: { value: number; currency: string }): void;
  pageview(url?: string, routePattern?: string): void;
  breadcrumb(crumb: Breadcrumb): void;
  status(id: string): Promise<ReportStatusView | null>;
  reply(id: string, body: string): Promise<ReportStatusView | null>;
  similar(page?: { url?: string; selector?: string }): Promise<SimilarIssue[]>;
  plusOne(id: string): Promise<number | null>;
  captureForReport(options?: WidgetCaptureOptions): Promise<WidgetCapture>;
  submitFromWidget(draft: WidgetDraft): Promise<ReportReceipt>;
  discardCapture(id: string): void;
  preload(feature: PreloadableFeature): Promise<void>;
  startRecording(options?: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void }): Promise<RecordingSession>;
  fetchRemote(): Promise<void>;
  drain(): Promise<number>;
  /** Re-evaluate features / consent (after remote config or setConsent). */
  reconfigure(): void;
  destroy(): void;
}

const REPORT_BUDGET = 1_900_000;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const CAPTURE_TTL = 30 * 60_000;
const SCREENSHOT_TIMEOUT = 5000;
const UI_SELECTOR = "[data-spotter-ui]";

const enc = new TextEncoder();

function header(req: RequestLike | undefined, name: string): string | undefined {
  if (!req) return undefined;
  const h = req.headers as Headers | Record<string, string | string[] | undefined>;
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function emptyHar(): Har {
  return { log: { version: "1.2", creator: { name: SDK_NAME, version: SDK_VERSION }, entries: [] } };
}

function safeName(name: string, taken: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "attachment";
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${i}-${base}`;
  taken.add(n);
  return n;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

function size(data: Blob | Uint8Array): number {
  return data instanceof Uint8Array ? data.byteLength : data.size;
}

export function createEngine(host: EngineHost): Engine {
  const cfg = () => host.config();
  const browser = cfg().runtime === "browser";
  const scope = host.scope;
  const transport: Transport =
    cfg().transport ??
    createHttpTransport({ endpoint: cfg().endpoint, project: cfg().project, secretKey: cfg().secretKey });
  const queue: OfflineQueue = browser ? createQueue() : memoryQueue();
  const redactor: Redactor = createRedactor(cfg().privacy ?? {}, () => scope.redactor);
  const crumbs = new RingBuffer<Breadcrumb>(cfg().capture?.breadcrumbs ?? 100, 256 * 1024);
  const earlyErrors: ErrorEntry[] = [];
  const signals = new Map<string, Signal<unknown>>();
  const captures = new Map<string, PendingCapture>();
  const cleanups: (() => void)[] = [];
  let replay: ReplayController | null = null;
  let replayStarting: Promise<void> | null = null;
  let analytics: {
    track(n: string, p?: Record<string, string | number | boolean>, r?: { value: number; currency: string }): void;
    pageview(u?: string, r?: string): void;
    noteError(e?: Pick<ErrorEntry, "type" | "message">): void;
    flush(beacon?: boolean): void;
    destroy(): void;
  } | null = null;
  let started = false;
  let destroyed = false;
  let env: EnvironmentInfo | null = null;
  let remoteFetched = false;

  const disabled = (signal: string) => cfg().capture?.disable?.includes(signal as never) ?? false;
  const enabled = (f: FeatureName) => cfg().features[f];
  const environment = () => (env ??= collectEnvironment());

  const release = () => {
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
    redact: (v, w) => redactor.redact(v, w),
    redactUrl: (u) => redactor.redactUrl(u),
    breadcrumb: (c) => crumbs.push(c),
    error(entry) {
      if (FEATURE_REPLAY && replay && replay.mode === "on_error") void replay.uploadSegment(`error:${entry.type}`).catch(() => {});
      if (FEATURE_ANALYTICS) analytics?.noteError(entry);
    },
    navigated(entry) {
      if (FEATURE_ANALYTICS) analytics?.pageview(entry.to, entry.routePattern);
    },
    fault(name, error) {
      devWarn(`${name} capture was disabled after an internal error: ${(error as Error)?.message ?? String(error)}`);
      const s = signals.get(name);
      signals.delete(name);
      try {
        s?.destroy();
      } catch {
        /* already broken */
      }
    },
    warn: (m) => devWarn(m.replace(/^\[spotter\]\s*/, "")),
    identity: () => (scope.user ? { id: scope.user.id, ...(scope.user.email ? { email: scope.user.email } : {}) } : null),
    flags: () => scope.flags,
    release,
    consent: () => host.consent(),
    routePattern,
  };

  const sdk = (): SdkInfo => ({
    name: SDK_NAME,
    version: SDK_VERSION,
    features: (Object.keys(cfg().features) as FeatureName[]).filter((f) => cfg().features[f]),
  });

  // -- flags -------------------------------------------------------------------------------

  let flagger: Flagger | null = null;
  if (FEATURE_FLAGS) {
    flagger = createFlagger({
      transport: () => transport,
      queue,
      sdk,
      server: !browser,
      limitPerMinute: () => cfg().flagRateLimit,
      replay: () => replay,
      context: () => {
        const e = environment();
        return {
          page: browser ? { url: redactor.redactUrl(location.href), ...(routePattern() ? { routePattern: routePattern()! } : {}) } : undefined,
          release: release(),
          reporter: scope.user ? { id: scope.user.id, ...(scope.user.email ? { email: scope.user.email } : {}) } : undefined,
          sessionId: browser ? host.sessionId : undefined,
          environment: { device: e.device, ...(e.browser ? { browser: e.browser } : {}), ...(e.os ? { os: e.os } : {}) },
          test: cfg().test,
        };
      },
      redactData: (d) => redactor.redactJson(d, "context") as Record<string, Json>,
      emit: (occ) => host.emit("flag", occ),
      onError: (error) => host.emit("error", { error, stage: "submit" }),
    });
  }

  // -- install -------------------------------------------------------------------------------

  function install<T>(name: string, fn: () => Signal<T>): void {
    if (disabled(name)) return;
    try {
      signals.set(name, fn() as Signal<unknown>);
    } catch (error) {
      runtime.fault(name, error);
    }
  }

  function start(): void {
    if (started || destroyed) return;
    started = true;
    const early = host.takeEarly();
    for (const c of early.crumbs) crumbs.push(c);
    for (const e of early.errors) {
      try {
        earlyErrors.push(errorEntryFrom(e.error, e.mechanism, (v, w) => redactor.redact(v, w), e.at));
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
    install("performance", () => installPerformance(runtime, { slowResourceMs: cap.slowResourceMs ?? 1000 }));

    const onOnline = () => void drain();
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        if (FEATURE_FLAGS) void flagger?.flush(true);
        if (FEATURE_ANALYTICS) analytics?.flush(true);
      }
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onHide);
    cleanups.push(() => window.removeEventListener("online", onOnline), () => document.removeEventListener("visibilitychange", onHide));
    reconfigure();
  }

  function reconfigure(): void {
    if (!browser || !started || destroyed) return;
    const c = cfg();
    const consent = host.consent();
    // replay
    if (FEATURE_REPLAY) {
      const mode = c.replayMode;
      let want = enabled("replay") && replayAllowed(mode, consent);
      if (want && mode === "sampled") want = sampledIn(c);
      if (!want && replay) {
        replay.stop();
        replay = null;
      } else if (want && !replay && !replayStarting) {
        replayStarting = startReplayChunk().finally(() => (replayStarting = null));
      }
    }
    // analytics
    if (FEATURE_ANALYTICS) {
      const want = enabled("analytics") && analyticsAllowed(c.analytics, consent);
      if (!want && analytics) {
        analytics.destroy();
        analytics = null;
      } else if (want && !analytics) {
        try {
          analytics = startAnalyticsNow();
        } catch (error) {
          runtime.fault("analytics", error);
        }
      }
    }
  }

  function sampledIn(c: ResolvedConfig): boolean {
    const key = "spotter:sample";
    let roll: number;
    try {
      const saved = sessionStorage.getItem(key);
      roll = saved ? Number(saved) : Math.random();
      if (!saved) sessionStorage.setItem(key, String(roll));
    } catch {
      roll = Math.random();
    }
    const segments = [scope.user ? "identified" : "anonymous", host.reporter().type];
    return roll < replaySampleRate(c, { path: location.pathname, environment: c.environment, release: c.release?.version, segments });
  }

  async function startReplayChunk(): Promise<void> {
    if (!FEATURE_REPLAY) return;
    try {
      const { startReplay } = await import("./replay/index.ts");
      if (destroyed || replay) return;
      const c = cfg();
      const mode = c.replayMode === "off" ? "buffer" : c.replayMode;
      replay = await startReplay(runtime, {
        mode,
        windowSeconds: c.windowSeconds,
        maskText: c.privacy?.maskText ?? "inputs",
        maskSelectors: c.privacy?.maskSelectors ?? [],
        blockSelectors: c.privacy?.blockSelectors ?? [],
        recordCanvas: c.replay?.recordCanvas,
        recordMedia: c.replay?.recordMedia,
        recordIframes: c.replay?.recordIframes,
        beforeReplayEvent: c.beforeReplayEvent,
        uploadSegment: (seq, data) => transport.replaySegment(host.sessionId, seq, data),
      });
      if (destroyed) replay.stop();
    } catch (error) {
      runtime.fault("replay", error);
    }
  }

  function startAnalyticsNow(): typeof analytics {
    if (!FEATURE_ANALYTICS) return null;
    // Static import is fine: the whole call sits behind FEATURE_ANALYTICS, so a build without it drops the module.
    return startAnalyticsImpl(
      runtime,
      { ...cfg().analytics, environment: cfg().environment },
      (events, opts) => {
        for (const e of events) if (e.type === "event") host.emit("track", e);
        void transport.events({ key: cfg().project, events, sdk: sdk() }, opts).catch(() => {});
      },
      signals.get("performance") as PerformanceSignal | undefined,
    );
  }

  // -- snapshot & submission -------------------------------------------------------------------

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

  function takeSnapshot(include: Include, opts: { element?: Element; point?: { x: number; y: number }; request?: RequestLike }): Snapshot {
    const at = Date.now();
    const nav = snap<NavigationSnapshot>("navigation", { entries: [], history: [] });
    const net = snap<Har>("network", emptyHar());
    const page: Snapshot["page"] = { url: "" };
    if (browser) {
      try {
        Object.assign(page, collectPage(runtime, { element: opts.element, point: opts.point }));
      } catch {
        page.url = redactor.redactUrl(location.href);
      }
      const rp = routePattern();
      if (rp) page.routePattern = rp;
    } else if (opts.request?.url) {
      page.url = redactor.redactUrl(opts.request.url);
    }
    const traceparents = [...((signals.get("network") as NetworkSignal | undefined)?.traceparents?.() ?? [])];
    const tp = header(opts.request, "traceparent");
    if (tp && !traceparents.includes(tp)) traceparents.push(tp);
    const errors = [...earlyErrors, ...snap<ErrorEntry[]>("errors", [])];
    const snapshot: Snapshot = {
      at,
      console: include.console ? snap<ConsoleEntry[]>("console", []) : [],
      errors,
      network: include.network ? net : emptyHar(),
      breadcrumbs: crumbs.toArray(),
      navigation: nav,
      environment: environment(),
      page,
      traceparents,
    };
    if (browser) {
      snapshot.environment = { ...environment(), ...viewportNow() };
      const perf = snap<PerformanceSnapshot | undefined>("performance", undefined);
      if (perf) snapshot.performance = perf;
      if (include.storage && !disabled("storage")) {
        try {
          snapshot.storage = collectStorage(runtime, cfg().privacy?.storageValues ?? []);
        } catch {
          /* blocked */
        }
      }
      if (include.dom) {
        try {
          snapshot.dom = domSnapshot(runtime);
        } catch {
          /* leave it out */
        }
      }
    }
    return snapshot;
  }

  function viewportNow(): Partial<EnvironmentInfo> {
    try {
      const nav = navigator as Navigator & { connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number } };
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        network: {
          online: navigator.onLine,
          ...(nav.connection?.type ? { type: nav.connection.type } : {}),
          ...(nav.connection?.effectiveType ? { effectiveType: nav.connection.effectiveType } : {}),
          ...(nav.connection?.downlink !== undefined ? { downlink: nav.connection.downlink } : {}),
          ...(nav.connection?.rtt !== undefined ? { rtt: nav.connection.rtt } : {}),
        },
      };
    } catch {
      return {};
    }
  }

  function defaultInclude(source: ReportSubmission["source"], override?: ReportInput["include"]): Include {
    const base: Include = {
      screenshot: browser && FEATURE_SCREENSHOT && enabled("screenshot") && source !== "error",
      replay: browser && FEATURE_REPLAY && enabled("replay"),
      network: true,
      console: true,
      storage: browser,
      dom: browser,
    };
    return { ...base, ...override };
  }

  async function screenshotNow(scopeKind: "viewport" | "full" | "element", element: Element | undefined, method: "auto" | "dom", exclude: Element[] = []): Promise<ScreenshotResult | undefined> {
    if (!FEATURE_SCREENSHOT || !browser || !enabled("screenshot")) return undefined;
    try {
      const { captureScreenshot } = await import("./screenshot/index.ts");
      const p = cfg().privacy ?? {};
      const ui = Array.from(document.querySelectorAll(UI_SELECTOR));
      return await withTimeout(
        captureScreenshot({
          scope: element ? "element" : scopeKind === "element" ? "viewport" : scopeKind,
          ...(element ? { element } : {}),
          exclude: [...ui, ...exclude],
          maskText: p.maskText ?? "inputs",
          maskSelectors: p.maskSelectors ?? [],
          blockSelectors: p.blockSelectors ?? [],
          method,
        }),
        SCREENSHOT_TIMEOUT,
      );
    } catch (error) {
      host.emit("error", { error, stage: "capture" });
      return undefined;
    }
  }

  function flushReplay(include: Include): Promise<{ data: Uint8Array; startedAt: string; endedAt: string } | null> | undefined {
    if (!FEATURE_REPLAY || !include.replay || !replay) return undefined;
    return replay.flush().catch(() => null);
  }

  function reporterFor(input: { email?: string }): ReportSubmission["reporter"] {
    const mode = host.reporter();
    const u = scope.user;
    const { id, email, name, ...traits } = u ?? ({} as Partial<IdentifyInput>);
    const contactEmail = email ?? input.email;
    const cleanTraits: Record<string, Json> = {};
    for (const [k, v] of Object.entries(traits)) if (v !== undefined) cleanTraits[k] = v as Json;
    return {
      ...(id ? { id } : {}),
      ...(contactEmail ? { email: contactEmail } : {}),
      ...(name ?? mode.name ? { name: (name as string | undefined) ?? mode.name } : {}),
      traits: cleanTraits,
      type: mode.type,
      contact: contactEmail ? "email" : browser ? "in_app" : "none",
    };
  }

  /** Trim the biggest signals until the JSON fits the ingest's 2 MB limit. */
  function fit(sub: ReportSubmission): void {
    const bytes = () => enc.encode(JSON.stringify(sub)).byteLength;
    if (bytes() <= REPORT_BUDGET) return;
    for (const e of sub.signals.network.log.entries) {
      delete e.request.postData;
      delete e.response.content.text;
    }
    const steps: (() => void)[] = [
      () => (sub.signals.console = sub.signals.console.slice(-50)),
      () => (sub.signals.network.log.entries = sub.signals.network.log.entries.slice(-50)),
      () => (sub.signals.breadcrumbs = sub.signals.breadcrumbs.slice(-50)),
      () => {
        delete sub.page.domExcerpt;
        delete sub.signals.storage;
      },
      () => {
        for (const c of sub.signals.console) c.args = c.args.map((a) => (typeof a === "string" ? a.slice(0, 500) : "[trimmed]"));
      },
      () => (sub.context.contexts = { trimmed: { reason: "report exceeded 2 MB" } }),
      () => (sub.signals.console = sub.signals.console.slice(-10)),
    ];
    for (const step of steps) {
      if (bytes() <= REPORT_BUDGET) return;
      step();
    }
  }

  async function build(
    input: ReportInput & { annotations?: WidgetDraft["annotations"] },
    source: ReportSubmission["source"],
    opts: {
      capture?: PendingCapture;
      error?: ErrorEntry;
      extraArtifacts?: { name: string; kind: ArtifactKind; contentType: string; data: Blob | Uint8Array; startedAt?: string; endedAt?: string }[];
      extraContexts?: Record<string, Record<string, Json>>;
      turnstileToken?: string;
      drop?: WidgetDraft["include"];
    } = {},
  ): Promise<Built> {
    let include = defaultInclude(source, input.include);
    if (opts.drop) for (const [k, v] of Object.entries(opts.drop)) if (v === false && k in include) include[k as keyof Include] = false;
    const before = cfg().beforeCapture;
    if (before) {
      const r = before({ source, include });
      if (!r) throw new SpotterDroppedError("beforeCapture");
      include = { ...include, ...r.include };
    }

    const element = typeof input.element === "string" && browser ? (document.querySelector(input.element) ?? undefined) : (input.element as Element | undefined);
    const snapshot = opts.capture?.snapshot ?? takeSnapshot(include, { element, request: input.request });
    const createdAt = iso(opts.capture?.at ?? Date.now());

    // artifacts
    const artifacts: (QueuedArtifact & { kind: ArtifactKind; startedAt?: string; endedAt?: string })[] = [];
    const names = new Set<string>();
    const add = (name: string, kind: ArtifactKind, contentType: string, data: Blob | Uint8Array, extra: { startedAt?: string; endedAt?: string } = {}) => {
      if (size(data) > (kind === "replay" || kind === "recording" ? 25 * 1024 * 1024 : MAX_ATTACHMENT)) {
        devWarn(`artifact "${name}" is larger than the ingest accepts and was left out.`);
        return;
      }
      artifacts.push({ name: safeName(name, names), kind, contentType, data, ...extra });
    };
    const replayP = opts.capture ? (include.replay ? opts.capture.replay : undefined) : flushReplay(include);
    const shot = opts.capture ? opts.capture.screenshot : include.screenshot ? await screenshotNow("viewport", element, "dom") : undefined;
    if (shot && include.screenshot) add("screenshot.png", "screenshot", shot.blob.type || "image/png", shot.blob);
    for (const a of opts.extraArtifacts ?? []) add(a.name, a.kind, a.contentType, a.data, { startedAt: a.startedAt, endedAt: a.endedAt });
    if (include.dom && snapshot.dom) add("dom.html", "dom_snapshot", "text/html; charset=utf-8", enc.encode(snapshot.dom));
    for (const a of scope.attachments) {
      const data = typeof a.data === "string" ? enc.encode(a.data) : a.data;
      add(a.name, a.kind, a.contentType, data);
    }
    const flushed = replayP ? await replayP : null;
    if (flushed) add("replay.rrweb.json.gz", "replay", "application/x-rrweb+gzip", flushed.data, { startedAt: flushed.startedAt, endedAt: flushed.endedAt });

    const errors = opts.error ? [...snapshot.errors.filter((e) => e !== opts.error), opts.error] : snapshot.errors;
    const pageUrl = snapshot.page.url;
    const contexts: Record<string, Record<string, Json>> = {};
    for (const [k, v] of Object.entries({ ...scope.contexts, ...opts.extraContexts }))
      contexts[k] = redactor.redactJson(v, "context") as Record<string, Json>;
    const signalsOut: ReportSubmission["signals"] = {
      console: snapshot.console,
      errors,
      network: snapshot.network,
      breadcrumbs: snapshot.breadcrumbs,
      navigation: snapshot.navigation.entries,
      ...(snapshot.performance ? { performance: snapshot.performance } : {}),
      ...(snapshot.storage ? { storage: snapshot.storage } : {}),
    };
    const category = input.category ?? "bug";
    const sessionId = browser ? host.sessionId : header(input.request, "x-spotter-session");
    const reporterMode = host.reporter();
    let submission: ReportSubmission = {
      schema: REPORT_SCHEMA_ID,
      clientId: randomId(16),
      createdAt,
      source,
      test: cfg().test,
      fingerprint: deriveFingerprint({
        source,
        error: opts.error,
        page: { url: pageUrl, routePattern: snapshot.page.routePattern, selector: snapshot.page.selector },
        category,
      }),
      reporter: reporterFor(input),
      content: {
        title: (input.title || "").slice(0, 500),
        description: input.description ?? "",
        ...(input.expected ? { expected: input.expected } : {}),
        category,
        severity: input.severity ?? (source === "error" || source === "server" ? "error" : "warning"),
        fields: input.fields ?? {},
        annotations: input.annotations ?? [],
      },
      page: { ...snapshot.page, url: pageUrl, history: snapshot.navigation.history.slice(-20) },
      environment: snapshot.environment,
      release: release(),
      context: { tags: { ...scope.tags, ...input.tags }, contexts, flags: { ...scope.flags } },
      signals: signalsOut,
      artifacts: artifacts.map((a) => ({
        name: a.name,
        kind: a.kind,
        contentType: a.contentType,
        size: size(a.data),
        ...(a.startedAt ? { startedAt: a.startedAt } : {}),
        ...(a.endedAt ? { endedAt: a.endedAt } : {}),
      })),
      trace: { traceparents: snapshot.traceparents.slice(-20), ...(sessionId ? { sessionId } : {}), serverEvents: [] },
      timeline: buildTimeline({ ...signalsOut, console: snapshot.console }, snapshot.at),
      sdk: sdk(),
      ...(reporterMode.teamToken ? { teamToken: reporterMode.teamToken } : {}),
      ...(reporterMode.guestToken ? { guestToken: reporterMode.guestToken } : {}),
      ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
    };
    fit(submission);
    const beforeSend = cfg().beforeSend;
    if (beforeSend) {
      const r = await beforeSend(submission);
      if (!r) throw new SpotterDroppedError("beforeSend");
      submission = r;
    }
    // beforeSend may drop artifacts from the declaration: upload only what's still declared
    const declared = new Set(submission.artifacts.map((a) => a.name));
    return { submission, artifacts: artifacts.filter((a) => declared.has(a.name)).map(({ name, contentType, data }) => ({ name, contentType, data })) };
  }

  async function deliver(built: Built): Promise<ReportReceipt> {
    const { submission, artifacts } = built;
    host.emit("submit", submission);
    let receipt: ReportReceipt;
    try {
      receipt = await transport.submit(submission);
    } catch (error) {
      if (!isRetryable(error)) {
        host.emit("error", { error, stage: "submit" });
        throw error;
      }
      // Never lose it: queue, and confirm with a provisional receipt.
      const id = `pending_${submission.clientId}`;
      await queue.put({ kind: "report", id, at: Date.now(), attempts: 0, submission, artifacts });
      receipt = { id, ref: pendingRef(submission.clientId), token: "", uploads: [], queued: true };
    }
    if (browser) rememberReport(receipt, submission.content.title, submission.createdAt);
    host.emit("sent", receipt);
    host.emit("issue", { ...submission, receipt });
    if (!receipt.queued) {
      const upload = () =>
        uploadAndComplete(transport, receipt, artifacts, queue).catch((error) => host.emit("error", { error, stage: "upload" }));
      // Browser: after the confirmation is shown. Server: before returning (a serverless function may freeze).
      if (browser) setTimeout(() => void upload(), 0);
      else await upload();
    }
    return receipt;
  }

  async function report(input: ReportInput, source?: ReportSubmission["source"]): Promise<ReportReceipt> {
    const src = source ?? (browser ? "api" : "server");
    return deliver(await build(input, src));
  }

  async function captureException(error: unknown, context: ExceptionContext = {}, mechanism: ErrorEntry["mechanism"] = browser ? "captured" : "server") {
    const { tags, request, ...extras } = context;
    const entry = errorEntryFrom(error, mechanism, (v, w) => redactor.redact(v, w));
    const input: ReportInput = {
      title: `${entry.type}: ${entry.message}`.slice(0, 200),
      description: entry.message,
      category: "bug",
      severity: "error",
      ...(tags ? { tags } : {}),
      ...(request ? { request } : {}),
    };
    const extra: Record<string, Json> = {};
    for (const [k, v] of Object.entries(extras)) if (v !== undefined) extra[k] = v as Json;
    try {
      return await deliver(
        await build(input, browser ? "error" : "server", { error: entry, extraContexts: Object.keys(extra).length ? { exception: extra } : undefined }),
      );
    } catch (e) {
      if (e instanceof SpotterDroppedError) return null;
      throw e;
    }
  }

  // -- widget flow ------------------------------------------------------------------------------

  function summarize(s: Snapshot, shot: ScreenshotResult | undefined, include: Include): AttachmentSummary[] {
    const out: AttachmentSummary[] = [];
    if (shot) out.push({ kind: "screenshot", label: "screenshot" });
    if (include.replay && replay) out.push({ kind: "replay", label: "replay", count: cfg().windowSeconds });
    if (s.console.length) out.push({ kind: "console", label: "console", count: s.console.length });
    if (s.network.log.entries.length) out.push({ kind: "network", label: "network", count: s.network.log.entries.length });
    if (s.errors.length) out.push({ kind: "errors", label: "errors", count: s.errors.length });
    out.push({ kind: "environment", label: "environment" });
    if (s.dom) out.push({ kind: "dom", label: "dom" });
    if (s.storage) out.push({ kind: "storage", label: "storage" });
    for (const a of scope.attachments) out.push({ kind: "attachment", label: a.name });
    return out;
  }

  async function captureForReport(options: WidgetCaptureOptions = {}): Promise<WidgetCapture> {
    const id = shortId("cap_");
    const include = defaultInclude("widget");
    const wantShot = options.screenshot !== false && include.screenshot;
    const scopeKind = typeof options.screenshot === "string" ? options.screenshot : options.element ? "element" : "viewport";
    // Screenshot first: the panel isn't open yet, so it can't be in the picture.
    const shotP = wantShot ? screenshotNow(scopeKind, scopeKind === "element" ? options.element : undefined, "auto", options.exclude) : Promise.resolve(undefined);
    const snapshot = takeSnapshot(include, { element: options.element, point: options.point });
    const replayP = flushReplay(include);
    const screenshot = await shotP;
    for (const [k, c] of captures) if (Date.now() - c.at > CAPTURE_TTL) captures.delete(k);
    captures.set(id, { snapshot, screenshot, replay: replayP, at: snapshot.at });
    return {
      id,
      capturedAt: iso(snapshot.at),
      ...(screenshot ? { screenshot } : {}),
      page: snapshot.page,
      attachments: summarize(snapshot, screenshot, include),
      test: cfg().test,
    };
  }

  async function submitFromWidget(draft: WidgetDraft): Promise<ReportReceipt> {
    const capture = draft.captureId ? captures.get(draft.captureId) : undefined;
    if (draft.captureId) captures.delete(draft.captureId);
    const extra: NonNullable<Parameters<typeof build>[2]>["extraArtifacts"] = [];
    if (draft.annotatedScreenshot && FEATURE_ANNOTATE) extra.push({ name: "annotated.png", kind: "annotated_screenshot", contentType: draft.annotatedScreenshot.type || "image/png", data: draft.annotatedScreenshot });
    if (draft.recording && FEATURE_RECORDING)
      extra.push({
        name: `recording.${/mp4/.test(draft.recording.contentType ?? draft.recording.blob.type) ? "mp4" : "webm"}`,
        kind: "recording",
        contentType: draft.recording.contentType ?? (draft.recording.blob.type || "video/webm"),
        data: draft.recording.blob,
        startedAt: draft.recording.startedAt,
        endedAt: draft.recording.endedAt,
      });
    for (const f of draft.files ?? []) {
      if ("kind" in f && "data" in f) {
        const a = f as Attachment;
        extra.push({ name: a.name, kind: a.kind, contentType: a.contentType, data: typeof a.data === "string" ? enc.encode(a.data) : a.data });
      } else {
        const file = f as File;
        extra.push({ name: file.name, kind: "attachment", contentType: file.type || "application/octet-stream", data: file });
      }
    }
    const firstLine = draft.description.trim().split("\n")[0] ?? "";
    const title = (draft.title?.trim() || firstLine || "Report").slice(0, 200);
    host.setState("submitting");
    try {
      const receipt = await deliver(
        await build(
          {
            title,
            description: draft.description,
            ...(draft.expected ? { expected: draft.expected } : {}),
            category: draft.category ?? (draft.mode === "feature" ? "feature" : "bug"),
            ...(draft.severity ? { severity: draft.severity } : {}),
            ...(draft.fields ? { fields: draft.fields } : {}),
            ...(draft.email ? { email: draft.email } : {}),
            annotations: draft.annotations,
            include: draft.mode === "text" || draft.mode === "feature" ? { screenshot: false } : undefined,
          },
          "widget",
          { capture, extraArtifacts: extra, turnstileToken: draft.turnstileToken, drop: draft.include },
        ),
      );
      host.setState("sent");
      return receipt;
    } catch (error) {
      host.setState("error");
      throw error;
    }
  }

  async function preload(feature: PreloadableFeature): Promise<void> {
    try {
      if (feature === "screenshot" && FEATURE_SCREENSHOT && enabled("screenshot")) await import("./screenshot/index.ts");
      else if (feature === "replay" && FEATURE_REPLAY && enabled("replay")) await import("./replay/index.ts");
      else if (feature === "recording" && FEATURE_RECORDING && enabled("recording")) await import("./recording/index.ts");
      // widget / annotate chunks belong to ui/next, which preloads its own
    } catch {
      /* preloading is best-effort */
    }
  }

  async function startRecording(options: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void } = {}): Promise<RecordingSession> {
    if (!FEATURE_RECORDING || !enabled("recording")) throw new Error("Spotter: screen recording is not enabled (features.recording).");
    const { startRecording: start } = await import("./recording/index.ts");
    const startedAt = iso();
    const handle = await start(options);
    return {
      async stop() {
        const r = await handle.stop();
        return { blob: r.blob, contentType: r.contentType, startedAt, endedAt: iso() };
      },
      cancel: () => handle.cancel(),
    };
  }

  // -- reporter loop -----------------------------------------------------------------------------

  async function status(id: string): Promise<ReportStatusView | null> {
    const stored = lookupReport(id);
    if (!stored) return null;
    if (stored.queued || isPendingId(stored.id)) {
      return { id: stored.id, ref: stored.ref, title: stored.title, status: "received", history: [], messages: [], updatedAt: stored.createdAt };
    }
    const view = await transport.status(stored.id, stored.token);
    if (view && noteStatus(stored.id, view.status)) host.emit("statusChange", { reportId: stored.id, status: view.status });
    return view;
  }

  async function reply(id: string, body: string): Promise<ReportStatusView | null> {
    const stored = lookupReport(id);
    if (!stored || stored.queued) return null;
    return transport.reply(stored.id, stored.token, body);
  }

  async function similar(page: { url?: string; selector?: string } = {}): Promise<SimilarIssue[]> {
    const url = page.url ?? (browser ? redactor.redactUrl(location.href) : "");
    if (!url) return [];
    return transport.similar(url, page.selector);
  }

  async function plusOne(id: string): Promise<number | null> {
    const stored = lookupReport(id);
    return transport.plusOne(id, stored?.token);
  }

  // -- remote config & queue ------------------------------------------------------------------------

  async function fetchRemote(): Promise<void> {
    if (remoteFetched || cfg().remoteConfig === false || !cfg().project) return;
    remoteFetched = true;
    try {
      const remote = await transport.config();
      if (!remote || destroyed) return;
      host.applyRemote(remote);
      reconfigure();
    } catch (error) {
      host.emit("error", { error, stage: "config" });
    }
  }

  function drain(): Promise<number> {
    return drainQueue(queue, transport, {
      delivered: (pendingId, receipt) => {
        if (browser) resolvePending(pendingId, receipt);
        host.emit("sent", receipt);
        host.emit("statusChange", { reportId: receipt.id, status: "received" });
      },
      failed: (_item, error) => host.emit("error", { error, stage: "submit" }),
    }).catch(() => 0);
  }

  function track(name: string, props?: Record<string, string | number | boolean>, revenue?: { value: number; currency: string }) {
    if (FEATURE_ANALYTICS) {
      if (!analytics) {
        if (browser) devWarn("track() was called while analytics is off (consent, GPC, remote config or not yet started); the event was dropped.");
        else void transport.events({ key: cfg().project, events: [{ type: "event", name, at: iso(), url: "", pageviewId: "", ...(props ? { props } : {}), ...(revenue ? { revenue } : {}) }], sdk: sdk() }).catch(() => {});
        return;
      }
      analytics.track(name, props, revenue);
    }
  }

  return {
    runtime,
    transport,
    start,
    report,
    captureException,
    flag(name, options, request) {
      if (FEATURE_FLAGS) flagger?.flag(name, options, { sessionId: header(request, "x-spotter-session"), url: request?.url ? redactor.redactUrl(request.url) : undefined });
    },
    async flush() {
      if (FEATURE_FLAGS) await flagger?.flush();
      if (FEATURE_ANALYTICS) analytics?.flush();
    },
    track,
    pageview(url, rp) {
      if (FEATURE_ANALYTICS) analytics?.pageview(url, rp);
    },
    breadcrumb: (c) => crumbs.push(c),
    status,
    reply,
    similar,
    plusOne,
    captureForReport,
    submitFromWidget,
    discardCapture: (id) => void captures.delete(id),
    preload,
    startRecording,
    fetchRemote,
    drain,
    reconfigure,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (FEATURE_FLAGS) {
        void flagger?.flush(true);
        flagger?.destroy();
      }
      if (FEATURE_ANALYTICS) {
        analytics?.flush(true);
        analytics?.destroy();
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
      captures.clear();
    },
  };
}
