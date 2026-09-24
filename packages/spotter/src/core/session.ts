/**
 * The session chunk: everything the engine needs once the user engages or
 * something is filed. Loaded lazily (see `engine.ts`), so none of it counts
 * against the initial or init-time budgets.
 *
 * Report pipeline (browser and server):
 *   include defaults → beforeCapture → snapshot signals → screenshot / replay
 *   flush / DOM snapshot / attachments as artifacts → submission (redacted,
 *   capped at ~1.9 MB) → beforeSend → submit (or queue + provisional
 *   receipt) → `submit` / `sent` / `issue` events → background chunked
 *   uploads → complete.
 */
import { collectEnvironment } from "./capture/environment.ts";
import type { RawConsoleEntry } from "./capture/console.ts";
import type { RawError } from "./capture/errors.ts";
import { finalizeConsole, finalizeCrumbs, finalizeNavigation } from "./capture/finalize.ts";
import type { NavigationSnapshot } from "./capture/navigation.ts";
import type { NetworkSignal, RawRequest } from "./capture/network.ts";
import { emptyHar, harFrom } from "./capture/network-har.ts";
import { errorEntryFrom, finalizeError } from "./capture/stack.ts";
import { collectPage, domSnapshot } from "./capture/page.ts";
import { installPerformance, type PerformanceSignal } from "./capture/performance.ts";
import { collectStorage } from "./capture/storage.ts";
import type { ResolvedConfig } from "./config.ts";
import { devWarn } from "./dev.ts";
import type { EngineCore } from "./engine.ts";
import { SpotterDroppedError } from "./errors.ts";
import { FEATURE_ANNOTATE, FEATURE_FLAGS, FEATURE_RECORDING, FEATURE_REPLAY, FEATURE_SCREENSHOT, type FeatureName } from "./features.ts";
import { deriveFingerprint } from "./fingerprint.ts";
import { createFlagger, type Flagger } from "./flags.ts";
import { iso, isPendingId, pendingRef, randomId, SDK_NAME, SDK_VERSION, shortId } from "./ids.ts";
import type { ScreenshotResult } from "./internal.ts";
import { lookupReport, noteStatus, rememberReport, resolvePending } from "./receipts.ts";
import { createRedactor } from "./redact.ts";
import { applyRemoteConfig, replaySampleRate } from "./remote-config.ts";
import {
  REPORT_SCHEMA_ID,
  type AnalyticsEvent,
  type ArtifactKind,
  type Breadcrumb,
  type ConsoleEntry,
  type EnvironmentInfo,
  type ErrorEntry,
  type Har,
  type Json,
  type PerformanceSnapshot,
  type ReportReceipt,
  type ReportStatusView,
  type ReportSubmission,
  type SdkInfo,
  type SimilarIssue,
  type StorageSnapshot,
} from "./schema.ts";
import { buildTimeline } from "./timeline.ts";
import { drainQueue, uploadAndComplete } from "./transport/deliver.ts";
import { createHttpTransport } from "./transport/http.ts";
import { createQueue, memoryQueue, type OfflineQueue, type QueuedArtifact } from "./transport/queue.ts";
import { isRetryable } from "./transport/retry.ts";
import type {
  Attachment,
  AttachmentSummary,
  DevDetails,
  ExceptionContext,
  FlagOptions,
  IdentifyInput,
  PreloadableFeature,
  RecordingSession,
  ReportInput,
  RequestLike,
  Transport,
  WidgetCapture,
  WidgetCaptureOptions,
  WidgetDraft,
} from "./types.ts";

// Bundler defines, read inline at each guarded site: a `FEATURE_X` imported
// from features.ts is only known after linking, too late for the bundler to
// drop an `import()` inside a dead branch (the chunk would still be emitted).
// Written inline, `define` folds the condition while this file is parsed.
declare const __SPOTTER_REPLAY__: boolean | undefined;
declare const __SPOTTER_SCREENSHOT__: boolean | undefined;
declare const __SPOTTER_RECORDING__: boolean | undefined;
declare const __SPOTTER_FLAGS__: boolean | undefined;
declare const __SPOTTER_ANNOTATE__: boolean | undefined;

export interface Session {
  readonly transport: Transport;
  report(input: ReportInput, source?: ReportSubmission["source"]): Promise<ReportReceipt>;
  captureException(error: unknown, context?: ExceptionContext): Promise<ReportReceipt | null>;
  flag(name: string, options: FlagOptions | undefined, request: RequestLike | undefined, at: number): void;
  flush(beacon?: boolean): Promise<void>;
  sendEvents(events: AnalyticsEvent[], opts: { beacon: boolean }): void;
  trackServer(name: string, props?: Record<string, string | number | boolean>, revenue?: { value: number; currency: string }): void;
  performance(): PerformanceSignal | undefined;
  sampledIn(): boolean;
  status(id: string): Promise<ReportStatusView | null>;
  reply(id: string, body: string): Promise<ReportStatusView | null>;
  similar(page?: { url?: string; selector?: string }): Promise<SimilarIssue[]>;
  plusOne(id: string): Promise<number | null>;
  captureForReport(options?: WidgetCaptureOptions): Promise<WidgetCapture>;
  submitFromWidget(draft: WidgetDraft): Promise<ReportReceipt>;
  discardCapture(id: string): void;
  devDetails(captureId?: string): DevDetails | null;
  preload(feature: PreloadableFeature): Promise<void>;
  startRecording(options?: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void }): Promise<RecordingSession>;
  fetchRemote(): Promise<void>;
  reapplyRemote(): void;
  drain(): Promise<number>;
  destroy(): void;
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

interface ExtraArtifact {
  name: string;
  kind: ArtifactKind;
  contentType: string;
  data: Blob | Uint8Array;
  startedAt?: string;
  endedAt?: string;
}

const REPORT_BUDGET = 1_900_000;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_REPLAY = 25 * 1024 * 1024;
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

function safeName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "attachment";
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${i}-${base}`;
  taken.add(n);
  return n;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

const byteSize = (data: Blob | Uint8Array) => (data instanceof Uint8Array ? data.byteLength : data.size);

export function createSession(core: EngineCore): Session {
  const { host, browser } = core;
  const redactor = core.useRedactor(createRedactor);
  const cfg = core.cfg;
  const scope = host.scope;
  const transport: Transport =
    cfg().transport ??
    createHttpTransport({
      endpoint: cfg().endpoint,
      project: cfg().project,
      secretKey: cfg().secretKey,
      meta: () => {
        const mode = host.reporter();
        return {
          sdkVersion: SDK_VERSION,
          features: sdk().features,
          maskText: cfg().privacy?.maskText ?? "inputs",
          ...(mode.teamToken ? { teamToken: mode.teamToken } : {}),
          ...(mode.guestToken ? { guestToken: mode.guestToken } : {}),
        };
      },
    });
  const queue: OfflineQueue = browser ? createQueue() : memoryQueue();
  const captures = new Map<string, PendingCapture>();
  let env: EnvironmentInfo | null = null;
  let remoteFetched = false;
  let destroyed = false;

  const enabled = (f: keyof ResolvedConfig["features"]) => cfg().features[f];
  const sdk = (): SdkInfo => ({ name: SDK_NAME, version: SDK_VERSION, features: (Object.keys(cfg().features) as FeatureName[]).filter((f) => cfg().features[f]) });
  const environment = () => (env ??= collectEnvironment());

  // Performance: buffered observers, so installing now still sees LCP / CLS / long tasks from page load.
  if (browser) core.install("performance", () => installPerformance(core.runtime, { slowResourceMs: cfg().capture?.slowResourceMs ?? 1000 }));

  // -- flags ---------------------------------------------------------------------------------

  let flagger: Flagger | null = null;
  if ((typeof __SPOTTER_FLAGS__ === "boolean" ? __SPOTTER_FLAGS__ : true) && FEATURE_FLAGS) {
    flagger = createFlagger({
      transport: () => transport,
      queue,
      sdk,
      server: !browser,
      limitPerMinute: () => cfg().flagRateLimit,
      replay: core.replay,
      context: () => {
        const e = environment();
        const rp = core.routePattern();
        return {
          page: browser ? { url: redactor.redactUrl(location.href), ...(rp ? { routePattern: rp } : {}) } : undefined,
          release: core.release(),
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

  // -- snapshot ------------------------------------------------------------------------------------

  function viewportNow(): Partial<EnvironmentInfo> {
    try {
      const nav = navigator as Navigator & { connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number } };
      const c = nav.connection;
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        network: {
          online: navigator.onLine,
          ...(c?.type ? { type: c.type } : {}),
          ...(c?.effectiveType ? { effectiveType: c.effectiveType } : {}),
          ...(c?.downlink !== undefined ? { downlink: c.downlink } : {}),
          ...(c?.rtt !== undefined ? { rtt: c.rtt } : {}),
        },
      };
    } catch {
      return {};
    }
  }

  function takeSnapshot(include: Include, opts: { element?: Element; point?: { x: number; y: number }; request?: RequestLike }): Snapshot {
    const at = Date.now();
    const page: Snapshot["page"] = { url: "" };
    if (browser) {
      try {
        Object.assign(page, collectPage(core.runtime, { element: opts.element, point: opts.point }));
      } catch {
        page.url = redactor.redactUrl(location.href);
      }
      const rp = core.routePattern();
      if (rp) page.routePattern = rp;
    } else if (opts.request?.url) {
      page.url = redactor.redactUrl(opts.request.url);
    }
    const traceparents = [...((core.signal("network") as NetworkSignal | undefined)?.traceparents?.() ?? [])];
    const tp = header(opts.request, "traceparent");
    if (tp && !traceparents.includes(tp)) traceparents.push(tp);
    const snapshot: Snapshot = {
      at,
      // Signals hold raw records: serialized, redacted and formatted here, before anything is sent.
      console: include.console ? finalizeConsole(core.snap<RawConsoleEntry[]>("console", []), redactor) : [],
      errors: [...core.earlyErrors, ...core.snap<RawError[]>("errors", [])].map((e) => finalizeError(e, redactor.redact)),
      network: include.network ? harFrom(core.snap<RawRequest[]>("network", []), redactor) : emptyHar(),
      breadcrumbs: finalizeCrumbs(core.crumbs(), redactor),
      navigation: finalizeNavigation(core.snap<NavigationSnapshot>("navigation", { entries: [], history: [] }), redactor),
      environment: browser ? { ...environment(), ...viewportNow() } : environment(),
      page,
      traceparents,
    };
    if (browser) {
      const perf = core.snap<PerformanceSnapshot | undefined>("performance", undefined);
      if (perf) snapshot.performance = perf;
      if (include.storage && !cfg().capture?.disable?.includes("storage")) {
        try {
          snapshot.storage = collectStorage(core.runtime, cfg().privacy?.storageValues ?? []);
        } catch {
          /* blocked */
        }
      }
      if (include.dom) {
        try {
          snapshot.dom = domSnapshot(core.runtime) || undefined;
        } catch {
          /* leave it out */
        }
      }
    }
    return snapshot;
  }

  function defaultInclude(source: ReportSubmission["source"], override?: ReportInput["include"]): Include {
    return {
      screenshot: browser && FEATURE_SCREENSHOT && enabled("screenshot") && source !== "error",
      replay: browser && FEATURE_REPLAY && enabled("replay"),
      network: true,
      console: true,
      storage: browser,
      dom: browser,
      ...override,
    };
  }

  async function screenshotNow(
    scopeKind: "viewport" | "full" | "element",
    element: Element | undefined,
    method: "auto" | "dom",
    exclude: Element[] = [],
  ): Promise<ScreenshotResult | undefined> {
    // `import()` inside the positive guard, so a define can drop it while parsing
    if ((typeof __SPOTTER_SCREENSHOT__ === "boolean" ? __SPOTTER_SCREENSHOT__ : true) && FEATURE_SCREENSHOT && browser && enabled("screenshot")) {
      try {
        const { captureScreenshot } = await import("./screenshot/index.ts");
        const p = cfg().privacy ?? {};
        return await withTimeout(
          captureScreenshot({
            scope: element ? "element" : scopeKind === "element" ? "viewport" : scopeKind,
            ...(element ? { element } : {}),
            exclude: [...Array.from(document.querySelectorAll(UI_SELECTOR)), ...exclude],
            maskText: p.maskText ?? "inputs",
            maskSelectors: p.maskSelectors ?? [],
            blockSelectors: p.blockSelectors ?? [],
            method,
          }),
          SCREENSHOT_TIMEOUT,
        );
      } catch (error) {
        host.emit("error", { error, stage: "capture" });
      }
    }
    return undefined;
  }

  function flushReplay(include: Include) {
    const replay = core.replay();
    if (!FEATURE_REPLAY || !include.replay || !replay) return undefined;
    return replay.flush().catch(() => null);
  }

  function reporterFor(input: { email?: string }): ReportSubmission["reporter"] {
    const mode = host.reporter();
    const { id, email, name, ...traits } = scope.user ?? ({} as Partial<IdentifyInput>);
    const contactEmail = email ?? input.email;
    const clean: Record<string, Json> = {};
    for (const [k, v] of Object.entries(traits)) if (v !== undefined) clean[k] = v as Json;
    const displayName = (name as string | undefined) ?? mode.name;
    return {
      ...(id ? { id } : {}),
      ...(contactEmail ? { email: contactEmail } : {}),
      ...(displayName ? { name: displayName } : {}),
      traits: clean,
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
      extraArtifacts?: ExtraArtifact[];
      extraContexts?: Record<string, Record<string, Json>>;
      turnstileToken?: string;
      drop?: WidgetDraft["include"];
    } = {},
  ): Promise<{ submission: ReportSubmission; artifacts: QueuedArtifact[] }> {
    let include = defaultInclude(source, input.include);
    for (const [k, v] of Object.entries(opts.drop ?? {})) if (v === false && k in include) include[k as keyof Include] = false;
    const before = cfg().beforeCapture;
    if (before) {
      const r = before({ source, include });
      if (!r) throw new SpotterDroppedError("beforeCapture");
      include = { ...include, ...r.include };
    }

    const element =
      typeof input.element === "string" ? (browser ? (document.querySelector(input.element) ?? undefined) : undefined) : input.element;
    const snapshot = opts.capture?.snapshot ?? takeSnapshot(include, { element, request: input.request });
    const createdAt = iso(opts.capture?.at ?? Date.now());

    const artifacts: (QueuedArtifact & { kind: ArtifactKind; startedAt?: string; endedAt?: string })[] = [];
    const names = new Set<string>();
    const add = (a: ExtraArtifact) => {
      if (byteSize(a.data) > (a.kind === "replay" || a.kind === "recording" ? MAX_REPLAY : MAX_ATTACHMENT)) {
        devWarn(`artifact "${a.name}" is larger than the ingest accepts and was left out.`);
        return;
      }
      artifacts.push({ ...a, name: safeName(a.name, names) });
    };
    const replayP = opts.capture ? (include.replay ? opts.capture.replay : undefined) : flushReplay(include);
    const shot = opts.capture ? opts.capture.screenshot : include.screenshot ? await screenshotNow("viewport", element, "dom") : undefined;
    if (shot && include.screenshot) add({ name: "screenshot.png", kind: "screenshot", contentType: shot.blob.type || "image/png", data: shot.blob });
    for (const a of opts.extraArtifacts ?? []) add(a);
    if (include.dom && snapshot.dom) add({ name: "dom.html", kind: "dom_snapshot", contentType: "text/html; charset=utf-8", data: enc.encode(snapshot.dom) });
    for (const a of scope.attachments) add({ name: a.name, kind: a.kind, contentType: a.contentType, data: typeof a.data === "string" ? enc.encode(a.data) : a.data });
    const flushed = replayP ? await replayP : null;
    if (flushed)
      add({ name: "replay.rrweb.json.gz", kind: "replay", contentType: "application/x-rrweb+gzip", data: flushed.data, startedAt: flushed.startedAt, endedAt: flushed.endedAt });

    const errors = opts.error ? [...snapshot.errors, opts.error] : snapshot.errors;
    const contexts: Record<string, Record<string, Json>> = {};
    for (const [k, v] of Object.entries({ ...scope.contexts, ...opts.extraContexts })) contexts[k] = redactor.redactJson(v, "context") as Record<string, Json>;
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
    const mode = host.reporter();
    let submission: ReportSubmission = {
      schema: REPORT_SCHEMA_ID,
      clientId: randomId(16),
      createdAt,
      source,
      test: cfg().test,
      fingerprint: deriveFingerprint({
        source,
        error: opts.error,
        page: { url: snapshot.page.url, routePattern: snapshot.page.routePattern, selector: snapshot.page.selector },
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
      page: { ...snapshot.page, history: snapshot.navigation.history.slice(-20) },
      environment: snapshot.environment,
      release: core.release(),
      context: { tags: { ...scope.tags, ...input.tags }, contexts, flags: { ...scope.flags } },
      signals: signalsOut,
      artifacts: artifacts.map((a) => ({
        name: a.name,
        kind: a.kind,
        contentType: a.contentType,
        size: byteSize(a.data),
        ...(a.startedAt ? { startedAt: a.startedAt } : {}),
        ...(a.endedAt ? { endedAt: a.endedAt } : {}),
      })),
      trace: { traceparents: snapshot.traceparents.slice(-20), ...(sessionId ? { sessionId } : {}), serverEvents: [] },
      timeline: buildTimeline({ ...signalsOut, console: snapshot.console }, snapshot.at),
      sdk: sdk(),
      ...(mode.teamToken ? { teamToken: mode.teamToken } : {}),
      ...(mode.guestToken ? { guestToken: mode.guestToken } : {}),
      ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
    };
    fit(submission);
    const beforeSend = cfg().beforeSend;
    if (beforeSend) {
      const r = await beforeSend(submission);
      if (!r) throw new SpotterDroppedError("beforeSend");
      submission = r;
    }
    // beforeSend may remove artifacts from the declaration: upload only what's still declared
    const declared = new Set(submission.artifacts.map((a) => a.name));
    return {
      submission,
      artifacts: artifacts.filter((a) => declared.has(a.name)).map(({ name, contentType, data }) => ({ name, contentType, data })),
    };
  }

  async function deliver({ submission, artifacts }: { submission: ReportSubmission; artifacts: QueuedArtifact[] }): Promise<ReportReceipt> {
    host.emit("submit", submission);
    let receipt: ReportReceipt;
    try {
      receipt = await transport.submit(submission);
    } catch (error) {
      if (!isRetryable(error)) {
        host.emit("error", { error, stage: "submit" });
        throw error;
      }
      // Never lose it: queue it, and confirm with a provisional receipt.
      const id = `pending_${submission.clientId}`;
      await queue.put({ kind: "report", id, at: Date.now(), attempts: 0, submission, artifacts });
      receipt = { id, ref: pendingRef(submission.clientId), token: "", uploads: [], queued: true };
    }
    if (browser) rememberReport(receipt, submission.content.title, submission.createdAt);
    host.emit("sent", receipt);
    host.emit("issue", { ...submission, receipt });
    if (!receipt.queued) {
      const upload = () => uploadAndComplete(transport, receipt, artifacts, queue).catch((error) => host.emit("error", { error, stage: "upload" }));
      // Browser: after the confirmation is shown. Server: before returning (a serverless function may freeze).
      if (browser) setTimeout(() => void upload(), 0);
      else await upload();
    }
    return receipt;
  }

  async function captureException(error: unknown, context: ExceptionContext = {}): Promise<ReportReceipt | null> {
    const { tags, request, ...extras } = context;
    const entry = errorEntryFrom(error, browser ? "captured" : "server", (v, w) => redactor.redact(v, w));
    const extra: Record<string, Json> = {};
    for (const [k, v] of Object.entries(extras)) if (v !== undefined) extra[k] = v as Json;
    try {
      return await deliver(
        await build(
          {
            title: `${entry.type}: ${entry.message}`.slice(0, 200),
            description: entry.message,
            category: "bug",
            severity: "error",
            ...(tags ? { tags } : {}),
            ...(request ? { request } : {}),
          },
          browser ? "error" : "server",
          { error: entry, extraContexts: Object.keys(extra).length ? { exception: extra } : undefined },
        ),
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
    if (include.replay && core.replay()) out.push({ kind: "replay", label: "replay", count: cfg().windowSeconds });
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
    const scopeKind = typeof options.screenshot === "string" ? options.screenshot : "viewport";
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
    const extra: ExtraArtifact[] = [];
    if ((typeof __SPOTTER_ANNOTATE__ === "boolean" ? __SPOTTER_ANNOTATE__ : true) && FEATURE_ANNOTATE && draft.annotatedScreenshot)
      extra.push({ name: "annotated.png", kind: "annotated_screenshot", contentType: draft.annotatedScreenshot.type || "image/png", data: draft.annotatedScreenshot });
    if ((typeof __SPOTTER_RECORDING__ === "boolean" ? __SPOTTER_RECORDING__ : false) && FEATURE_RECORDING && draft.recording) {
      const type = draft.recording.contentType ?? (draft.recording.blob.type || "video/webm");
      extra.push({
        name: `recording.${/mp4/.test(type) ? "mp4" : "webm"}`,
        kind: "recording",
        contentType: type,
        data: draft.recording.blob,
        startedAt: draft.recording.startedAt,
        endedAt: draft.recording.endedAt,
      });
    }
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
    host.setState("submitting");
    try {
      const receipt = await deliver(
        await build(
          {
            title: (draft.title?.trim() || firstLine || "Report").slice(0, 200),
            description: draft.description,
            ...(draft.expected ? { expected: draft.expected } : {}),
            category: draft.category ?? (draft.mode === "feature" ? "feature" : "bug"),
            ...(draft.severity ? { severity: draft.severity } : {}),
            ...(draft.fields ? { fields: draft.fields } : {}),
            ...(draft.email ? { email: draft.email } : {}),
            annotations: draft.annotations,
            ...(draft.mode === "text" || draft.mode === "feature" ? { include: { screenshot: false } } : {}),
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

  function devDetails(captureId?: string): DevDetails {
    const snapshot = (captureId ? captures.get(captureId)?.snapshot : undefined) ?? takeSnapshot(defaultInclude("widget", { dom: false, storage: false }), {});
    const e = snapshot.environment;
    const environment: Record<string, string> = {};
    if (snapshot.page.url) environment.URL = snapshot.page.url;
    if (e.browser) environment.Browser = `${e.browser.name} ${e.browser.version ?? ""}`.trim();
    if (e.os) environment.OS = `${e.os.name} ${e.os.version ?? ""}`.trim();
    if (e.viewport) environment.Viewport = `${e.viewport.width}×${e.viewport.height}${e.dpr ? ` @${e.dpr}x` : ""}`;
    if (e.locale) environment.Locale = e.locale;
    const release = core.release();
    if (release.version) environment.Release = release.version;
    return {
      consoleErrors: [
        ...snapshot.errors.map((x) => ({ message: `${x.type}: ${x.message}`, at: x.at })),
        ...snapshot.console.filter((c) => c.level === "error").map((c) => ({ message: c.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 300), at: c.at })),
      ].slice(-20),
      failedRequests: snapshot.network.log.entries
        .filter((x) => x.response.status === 0 || x.response.status >= 400)
        .slice(-20)
        .map((x) => ({ method: x.request.method, url: x.request.url, status: x.response.status })),
      environment,
    };
  }

  async function preload(feature: PreloadableFeature): Promise<void> {
    try {
      if ((typeof __SPOTTER_SCREENSHOT__ === "boolean" ? __SPOTTER_SCREENSHOT__ : true) && FEATURE_SCREENSHOT && feature === "screenshot" && enabled("screenshot")) await import("./screenshot/index.ts");
      else if ((typeof __SPOTTER_REPLAY__ === "boolean" ? __SPOTTER_REPLAY__ : true) && FEATURE_REPLAY && feature === "replay" && enabled("replay")) await import("./replay/index.ts");
      else if ((typeof __SPOTTER_RECORDING__ === "boolean" ? __SPOTTER_RECORDING__ : false) && FEATURE_RECORDING && feature === "recording" && enabled("recording")) await import("./recording/index.ts");
      // "widget" / "annotate": loading this session chunk was the point; the UI preloads its own chunks
    } catch {
      /* preloading is best-effort */
    }
  }

  async function startRecording(options: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void } = {}): Promise<RecordingSession> {
    if ((typeof __SPOTTER_RECORDING__ === "boolean" ? __SPOTTER_RECORDING__ : false) && FEATURE_RECORDING && enabled("recording")) {
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
    throw new Error("Spotter: screen recording is not enabled (features.recording).");
  }

  // -- the closed loop -----------------------------------------------------------------------------

  async function status(id: string): Promise<ReportStatusView | null> {
    const stored = lookupReport(id);
    if (!stored) return null;
    if (stored.queued || isPendingId(stored.id))
      return { id: stored.id, ref: stored.ref, title: stored.title, status: "received", history: [], messages: [], updatedAt: stored.createdAt };
    const view = await transport.status(stored.id, stored.token);
    if (view && noteStatus(stored.id, view.status)) host.emit("statusChange", { reportId: stored.id, status: view.status });
    return view;
  }

  // -- remote config & queue -------------------------------------------------------------------------

  function reapplyRemote(): void {
    const remote = host.remote();
    if (!remote) return;
    const applied = applyRemoteConfig(host.baseConfig(), remote);
    for (const i of applied.ignored) devWarn(`remote config asked for ${i}, which this build or your code config doesn't allow; ignored.`);
    host.setRemote(applied.config, remote);
  }

  function sampledIn(): boolean {
    const key = "spotter:sample";
    let roll: number;
    try {
      const saved = sessionStorage.getItem(key);
      roll = saved ? Number(saved) : Math.random();
      if (!saved) sessionStorage.setItem(key, String(roll));
    } catch {
      roll = Math.random();
    }
    const c = cfg();
    const segments = [scope.user ? "identified" : "anonymous", host.reporter().type];
    if (scope.user) for (const [k, v] of Object.entries(scope.user)) if (typeof v === "string") segments.push(`trait:${k}=${v}`);
    return roll < replaySampleRate(c, { path: location.pathname, environment: c.environment, release: c.release?.version, segments });
  }

  return {
    transport,
    report: async (input, source) => deliver(await build(input, source ?? (browser ? "api" : "server"))),
    captureException,
    flag(name, options, request, at) {
      if (FEATURE_FLAGS)
        flagger?.flag(name, options, { sessionId: header(request, "x-spotter-session"), url: request?.url ? redactor.redactUrl(request.url) : undefined, at });
    },
    async flush(beacon) {
      if (FEATURE_FLAGS) await flagger?.flush(beacon);
    },
    sendEvents(events, opts) {
      for (const e of events) if (e.type === "event") host.emit("track", e);
      void transport.events({ key: cfg().project, events, sdk: sdk() }, opts).catch(() => {});
    },
    trackServer(name, props, revenue) {
      const event: AnalyticsEvent = { type: "event", name, at: iso(), url: "", pageviewId: "", ...(props ? { props } : {}), ...(revenue ? { revenue } : {}) };
      host.emit("track", event);
      void transport.events({ key: cfg().project, events: [event], sdk: sdk() }).catch(() => {});
    },
    performance: () => core.signal("performance") as PerformanceSignal | undefined,
    sampledIn,
    status,
    async reply(id, body) {
      const stored = lookupReport(id);
      if (!stored || stored.queued) return null;
      return transport.reply(stored.id, stored.token, body);
    },
    async similar(page = {}) {
      const url = page.url ?? (browser ? redactor.redactUrl(location.href) : "");
      return url ? transport.similar(url, page.selector) : [];
    },
    plusOne: (id) => transport.plusOne(id, lookupReport(id)?.token),
    captureForReport,
    submitFromWidget,
    discardCapture: (id) => void captures.delete(id),
    devDetails,
    preload,
    startRecording,
    async fetchRemote() {
      if (remoteFetched || cfg().remoteConfig === false || !cfg().project) return;
      remoteFetched = true;
      try {
        const remote = await transport.config();
        if (!remote || destroyed) return;
        const applied = applyRemoteConfig(host.baseConfig(), remote);
        for (const i of applied.ignored) devWarn(`remote config asked for ${i}, which this build or your code config doesn't allow; ignored.`);
        host.setRemote(applied.config, remote);
        core.reconfigure();
      } catch (error) {
        host.emit("error", { error, stage: "config" });
      }
    },
    reapplyRemote,
    drain() {
      return drainQueue(queue, transport, {
        delivered: (pendingId, receipt) => {
          if (browser) resolvePending(pendingId, receipt);
          host.emit("sent", receipt);
          host.emit("statusChange", { reportId: receipt.id, status: "received" });
        },
        failed: (_item, error) => host.emit("error", { error, stage: "submit" }),
      }).catch(() => 0);
    },
    destroy() {
      destroyed = true;
      if (FEATURE_FLAGS) {
        void flagger?.flush(true);
        flagger?.destroy();
      }
      captures.clear();
    },
  };
}
