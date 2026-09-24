/**
 * `createSpotter()` and the `spotter` singleton — the reporting API.
 *
 * This file is the *loader*: what an app pays for up front (< 6 KB gzip with
 * the trigger shell). It holds config, state, events and enrichment, and
 * schedules everything else:
 *
 * - `init()` does no network and < 5 ms of work: resolve config, read the
 *   tab session id and a guest token from the URL, buffer early errors,
 *   expose `window.__trusplexSpotter`. Nothing touches `window` at import,
 *   so it is SSR / RSC safe.
 * - On idle the engine chunk (`engine.ts`) loads and installs the capture
 *   signals; replay starts there in buffer mode when enabled and consented.
 * - The first user interaction (or `open()`) schedules, on idle, the remote
 *   config fetch and the offline-queue replay — so there are zero Spotter
 *   requests before the user engages.
 * - On the server (Node / edge) the same API works: `report()`, `flag()` and
 *   `captureException()` load the engine on first use and send with the
 *   secret key (`SPOTTER_SECRET_KEY`) to `SPOTTER_ENDPOINT` or the hosted
 *   ingest, with `source: "server"`. Pass `{ request }` (or use
 *   `spotter.withRequest(request)`) so the report links to the browser
 *   session (`x-spotter-session`) and trace (`traceparent`).
 *
 * Widget API (the `SpotterWidgetApi` half; `ui/next` drives its flow with it,
 * custom UIs can too):
 *
 * - `preload(feature)` — load the screenshot / replay / recording chunk on
 *   trigger hover or focus.
 * - `captureForReport({ element?, point?, screenshot?, exclude? })` — the
 *   moment the trigger is pressed, *before* the panel opens: screenshot,
 *   page facts, signal snapshot, replay flush. Returns `{ id, screenshot?,
 *   page, attachments, test }`; `attachments` is the plain-language "what's
 *   attached" list for the report screen.
 * - `submitFromWidget({ captureId, description, category?, annotations?,
 *   annotatedScreenshot?, include?, email?, recording?, files? })` — files the
 *   report from that capture; resolves with the receipt (provisional and
 *   `queued: true` when offline) and drives `state`.
 * - `setState(state)` / `on("statusChange")` — the UI state machine
 *   (`idle → capturing → annotating → submitting → sent | error`).
 * - `connectTeam()` / `reporterMode()` — team mode via Console; guest mode
 *   from `?spotter_guest=` links.
 * - `myReports()` / `status(id)` / `reply(id, body)` — the closed loop.
 * - `remoteConfig()` — applied (narrowed) remote config for fields,
 *   appearance and trigger targeting.
 */
import { CONSOLE_ORIGIN, detectRuntime, resolveConfig, type ResolvedConfig } from "./config.ts";
import { devCheckConfig, devWarn } from "./dev.ts";
import type { Engine, EngineHost, Scope } from "./engine.ts";
import type { Session } from "./session.ts";
import { COMPILED_FEATURES, DEV, type FeatureName } from "./features.ts";
import { iso, tabSessionId } from "./ids.ts";
import { storedReports } from "./stored-reports.ts";
import type { Breadcrumb, RemoteConfig } from "./schema.ts";
import type {
  ConsentState,
  ExceptionContext,
  FlagOptions,
  ReporterMode,
  ReportInput,
  RequestLike,
  SpotterClient,
  SpotterConfig,
  SpotterEvents,
  SpotterRequestScope,
  SpotterState,
  SpotterWidgetApi,
} from "./types.ts";

export type SpotterInstance = SpotterClient & SpotterWidgetApi;

// Read inline at each `if`: a bundler define then folds dev-only branches (and their
// strings) while this file is parsed; the imported DEV is only known after linking.
declare const __SPOTTER_DEV__: boolean | undefined;

const GUEST_PARAM = "spotter_guest";
const GUEST_KEY = "spotter:guest";
const TEAM_KEY = "spotter:team";
const MAX_EARLY = 20;

type Listener = (payload: never) => void;

function idle(fn: () => void): void {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout: 3000 });
  else setTimeout(fn, 1);
}

function session(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSession(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* blocked storage: the mode lasts for this page only */
  }
}

/** Create an independent client. Most apps use the exported `spotter` singleton. */
export function createSpotter(): SpotterInstance {
  let config: ResolvedConfig | null = null;
  let userConfig: SpotterConfig = {};
  let remote: RemoteConfig | null = null;
  let consent: ConsentState = {};
  let state: SpotterState = "idle";
  let sessionId = "";
  let enginePromise: Promise<Engine> | null = null;
  let engine: Engine | null = null;
  let guestToken: string | undefined;
  let team: { token: string; name?: string; expiresAt?: string } | undefined;
  let interacted = false;
  let initialized = false;
  /** Bumped by destroy(): idle callbacks scheduled before it become no-ops. */
  let generation = 0;
  const listeners = new Map<keyof SpotterEvents, Set<Listener>>();
  const cleanups: (() => void)[] = [];
  const early: ReturnType<EngineHost["takeEarly"]> = { errors: [], crumbs: [] };
  const scope: Scope = { user: null, contexts: {}, tags: {}, flags: {}, attachments: [], redactor: null, routeResolver: null };
  /** Calls made before the engine arrived, replayed in order. */
  const pending: ((e: Engine) => void)[] = [];

  const cfg = (): ResolvedConfig => (config ??= resolveConfig(userConfig));
  const browser = () => cfg().runtime === "browser";

  function emit<E extends keyof SpotterEvents>(event: E, payload: SpotterEvents[E]): void {
    for (const fn of listeners.get(event) ?? []) {
      try {
        (fn as (p: SpotterEvents[E]) => void)(payload);
      } catch (error) {
        if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn(`a "${event}" listener threw: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  function reporterMode(): ReporterMode & { teamToken?: string; guestToken?: string } {
    if (team && (!team.expiresAt || Date.parse(team.expiresAt) > Date.now()))
      return { type: "team", ...(team.name ? { name: team.name } : {}), teamToken: team.token };
    if (guestToken) return { type: "guest", guestToken };
    return { type: "public" };
  }

  const host: EngineHost = {
    config: cfg,
    get sessionId() {
      return sessionId || (sessionId = browser() ? tabSessionId() : "");
    },
    scope,
    consent: () => consent,
    emit,
    setState,
    reporter: reporterMode,
    takeEarly() {
      const out = { errors: early.errors.splice(0), crumbs: early.crumbs.splice(0) };
      return out;
    },
    setRemote(c, r) {
      config = c;
      remote = r;
      emit("config", r);
    },
    baseConfig: () => resolveConfig(userConfig),
    remote: () => remote,
  };

  function loadEngine(): Promise<Engine> {
    if (!enginePromise) {
      const gen = generation;
      enginePromise = import("./engine.ts").then((m) => {
        if (gen !== generation) throw new Error("Spotter: destroyed");
        const e = m.createEngine(host);
        engine = e;
        e.start();
        for (const call of pending.splice(0)) call(e);
        return e;
      });
      enginePromise.catch((error) => {
        if (gen === generation) emit("error", { error, stage: "capture" });
      });
    }
    return enginePromise;
  }

  /** Run now if the engine is here, else queue for when it loads (and make sure it loads). */
  function later(fn: (e: Engine) => void): void {
    if (engine) return fn(engine);
    if (pending.length < 200) pending.push(fn);
    if (config && !browser()) void loadEngine();
  }

  function onFirstInteraction(): void {
    if (interacted || !config) return;
    interacted = true;
    const gen = generation;
    idle(() => {
      if (gen !== generation) return;
      void loadEngine().then((e) => e.engage());
    });
  }

  function setState(next: SpotterState): void {
    if (state === next) return;
    state = next;
    emit("statusChange", { state: next });
  }

  const featureOn = (f: FeatureName) => (config ? config.features[f] : COMPILED_FEATURES[f]);

  function off(f: FeatureName, api: string): boolean {
    if (featureOn(f)) return false;
    if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn(`spotter.${api}() was called but the "${f}" feature is ${COMPILED_FEATURES[f] ? "disabled at runtime" : "not compiled into this build"}; it does nothing.`);
    return true;
  }

  function ensureInit(api: string): boolean {
    if (config) return true;
    if (detectRuntime() !== "browser") {
      // Server: zero-config from env (SPOTTER_SECRET_KEY / SPOTTER_PROJECT / SPOTTER_ENDPOINT).
      config = resolveConfig(userConfig);
      return true;
    }
    if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn(`spotter.${api}() was called before spotter.init(); it was ignored.`);
    return false;
  }

  function installBrowser(c: ResolvedConfig): void {
    // Guest links: ?spotter_guest=<token>, stored for the tab, then removed from the URL.
    try {
      const url = new URL(location.href);
      const token = url.searchParams.get(GUEST_PARAM);
      if (token) {
        setSession(GUEST_KEY, token);
        url.searchParams.delete(GUEST_PARAM);
        history.replaceState(history.state, "", url.toString());
      }
    } catch {
      /* sandboxed */
    }
    guestToken = session(GUEST_KEY) ?? undefined;
    try {
      const t = session(TEAM_KEY);
      if (t) team = JSON.parse(t) as typeof team;
    } catch {
      team = undefined;
    }

    // Early errors, until the engine's error capture takes over.
    const onError = (ev: ErrorEvent) => {
      if (!engine && early.errors.length < MAX_EARLY) early.errors.push({ error: ev.error ?? ev.message, mechanism: "uncaught", at: Date.now() });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      if (!engine && early.errors.length < MAX_EARLY) early.errors.push({ error: ev.reason, mechanism: "unhandledrejection", at: Date.now() });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() => window.removeEventListener("error", onError), () => window.removeEventListener("unhandledrejection", onRejection));

    const first = () => onFirstInteraction();
    const opts = { capture: true, passive: true, once: true } as const;
    for (const t of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(t, first, opts);
    cleanups.push(() => {
      for (const t of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(t, first, opts);
    });

    if (c.globalHandle !== false) {
      (window as unknown as { __trusplexSpotter?: SpotterInstance }).__trusplexSpotter = client;
      cleanups.push(() => {
        const w = window as unknown as { __trusplexSpotter?: SpotterInstance };
        if (w.__trusplexSpotter === client) delete w.__trusplexSpotter;
      });
    }
    const gen = generation;
    idle(() => {
      if (gen === generation) void loadEngine().catch(() => {});
    });
  }

  /** Report / widget / closed-loop calls go straight to the session chunk (loading engine and session as needed). */
  function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    return loadEngine()
      .then((e) => e.session())
      .then(fn);
  }

  function scoped(request: RequestLike): SpotterRequestScope {
    return {
      report: (input) => client.report({ ...input, request }),
      captureException: (error, context) => client.captureException(error, { ...context, request }),
      flag(name, options) {
        if (!ensureInit("flag") || off("flags", "flag")) return;
        later((e) => e.flag(name, options, request));
      },
    };
  }

  const client: SpotterInstance = {
    init(c: SpotterConfig) {
      if (initialized) {
        // A second init (e.g. a provider re-render) updates config in place; listeners stay installed.
        userConfig = { ...userConfig, ...c };
        config = resolveConfig(userConfig);
        engine?.reconfigure(); // re-narrows with the last remote config

        return client;
      }
      initialized = true;
      userConfig = { ...c };
      config = resolveConfig(userConfig);
      if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devCheckConfig(config, config.runtime);
      if (config.runtime === "browser") installBrowser(config);
      return client;
    },
    get initialized() {
      return initialized;
    },
    get config() {
      return cfg();
    },
    get state() {
      return state;
    },
    get sessionId() {
      return host.sessionId;
    },

    identify(user) {
      scope.user = user ? { ...user } : null;
    },
    setContext(key, value) {
      if (value === null) delete scope.contexts[key];
      else scope.contexts[key] = value;
    },
    setTags(tags) {
      Object.assign(scope.tags, tags);
    },
    setFlags(flags) {
      Object.assign(scope.flags, flags);
    },
    addBreadcrumb(crumb) {
      const c: Breadcrumb = { ...crumb, at: crumb.at ?? iso() };
      if (engine) engine.breadcrumb(c);
      else if (early.crumbs.length < 100) early.crumbs.push(c);
    },
    attach(name, data, contentType) {
      const isBin = typeof Blob !== "undefined" && data instanceof Blob;
      const payload: Blob | Uint8Array | string =
        isBin || data instanceof Uint8Array || typeof data === "string" ? (data as Blob | Uint8Array | string) : JSON.stringify(data);
      const bytes = typeof payload === "string" ? new TextEncoder().encode(payload).byteLength : payload instanceof Uint8Array ? payload.byteLength : payload.size;
      if (bytes > 10 * 1024 * 1024) {
        if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn(`attach("${name}") is over 10 MB and was ignored.`);
        return;
      }
      const type = contentType ?? (isBin ? (payload as Blob).type : "") ?? "";
      scope.attachments = scope.attachments.filter((a) => a.name !== name);
      if (scope.attachments.length >= 10) {
        if (typeof __SPOTTER_DEV__ === "boolean" ? __SPOTTER_DEV__ : DEV) devWarn("at most 10 attachments are kept; the oldest was dropped.");
        scope.attachments.shift();
      }
      scope.attachments.push({
        name,
        kind: "attachment",
        contentType: type || (typeof data === "object" && !(data instanceof Uint8Array) && !isBin ? "application/json" : "application/octet-stream"),
        data: payload,
      });
    },
    setRedactor(fn) {
      scope.redactor = fn;
    },
    setConsent(c) {
      consent = { ...consent, ...c };
      emit("consent", consent);
      engine?.reconfigure();
    },

    flag(name, options?: FlagOptions) {
      if (!ensureInit("flag") || off("flags", "flag")) return;
      later((e) => e.flag(name, options));
    },
    assert(condition, name, data) {
      if (!condition) client.flag(name, { severity: "error", ...(data ? { data } : {}) });
    },
    async report(input: ReportInput) {
      if (!ensureInit("report")) throw new Error("Spotter: call spotter.init() before report().");
      return withSession((s) => s.report(input));
    },
    async captureException(error, context?: ExceptionContext) {
      if (!ensureInit("captureException")) return null;
      return withSession((s) => s.captureException(error, context));
    },
    async status(id) {
      if (!ensureInit("status")) return null;
      return withSession((s) => s.status(id));
    },
    async reply(id, body) {
      if (!ensureInit("reply")) return null;
      return withSession((s) => s.reply(id, body));
    },
    async similar(page) {
      if (!ensureInit("similar")) return [];
      return withSession((s) => s.similar(page));
    },
    async plusOne(id) {
      if (!ensureInit("plusOne")) return null;
      return withSession((s) => s.plusOne(id));
    },

    track(name, props, revenue) {
      if (!ensureInit("track") || off("analytics", "track")) return;
      later((e) => e.track(name, props, revenue));
    },
    pageview(url, routePattern) {
      if (!ensureInit("pageview") || off("analytics", "pageview")) return;
      later((e) => e.pageview(url, routePattern));
    },

    open(options = {}) {
      if (off("widget", "open")) return;
      onFirstInteraction();
      emit("open", options);
    },
    close() {
      emit("close", undefined);
      setState("idle");
    },

    on(event, fn) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(fn as Listener);
      listeners.set(event, set);
      return () => client.off(event, fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn as Listener);
    },
    enabled: featureOn,

    destroy() {
      generation++;
      engine?.destroy();
      for (const c of cleanups.splice(0)) c();
      engine = null;
      enginePromise = null;
      pending.length = 0;
      config = null;
      remote = null;
      interacted = false;
      initialized = false;
      state = "idle";
      scope.attachments = [];
    },

    // -- widget API --------------------------------------------------------------------------
    async preload(feature) {
      if (!config || !browser()) return;
      await withSession((s) => s.preload(feature));
    },
    async ready() {
      if (!config) return;
      await loadEngine();
    },
    captureForReport(options) {
      setState("capturing");
      onFirstInteraction();
      return withSession((s) => s.captureForReport(options)).catch((error) => {
        emit("error", { error, stage: "capture" });
        setState("error");
        throw error;
      });
    },
    submitFromWidget(draft) {
      return withSession((s) => s.submitFromWidget(draft));
    },
    discardCapture(id) {
      engine?.discardCapture(id);
    },
    devDetails: (captureId) => engine?.devDetails(captureId) ?? null,
    setState,
    remoteConfig: () => remote,
    reporterMode() {
      const { teamToken: _t, guestToken: _g, ...mode } = reporterMode();
      return mode;
    },
    connectTeam() {
      if (!config || !browser()) return Promise.resolve(null);
      const endpoint = cfg().endpoint;
      const consoleOrigin = /^https?:\/\//.test(endpoint) ? new URL(endpoint).origin : CONSOLE_ORIGIN;
      const url = `${consoleOrigin}/spotter/connect?key=${encodeURIComponent(cfg().project ?? "")}&origin=${encodeURIComponent(location.origin)}`;
      const popup = window.open(url, "spotter-connect", "width=480,height=640");
      if (!popup) return Promise.reject(new Error("Spotter: the sign-in popup was blocked."));
      return new Promise<ReporterMode | null>((resolve) => {
        const done = (mode: ReporterMode | null) => {
          window.removeEventListener("message", onMessage);
          clearInterval(poll);
          resolve(mode);
        };
        const onMessage = (ev: MessageEvent) => {
          const d = ev.data as { type?: string; token?: string; name?: string; expiresAt?: string } | null;
          if (ev.origin !== consoleOrigin || d?.type !== "spotter:team-token" || !d.token) return;
          team = { token: d.token, ...(d.name ? { name: d.name } : {}), ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}) };
          setSession(TEAM_KEY, JSON.stringify(team));
          try {
            popup.close();
          } catch {
            /* cross-origin */
          }
          done({ type: "team", ...(d.name ? { name: d.name } : {}) });
        };
        const poll = setInterval(() => {
          if (popup.closed) done(null);
        }, 500);
        window.addEventListener("message", onMessage);
      });
    },
    disconnectTeam() {
      team = undefined;
      setSession(TEAM_KEY, null);
    },
    myReports: () => storedReports(),
    setRouteResolver(fn) {
      scope.routeResolver = fn;
    },
    async startRecording(options) {
      if (off("recording", "startRecording")) throw new Error("Spotter: screen recording is not enabled.");
      return withSession((s) => s.startRecording(options));
    },
    async flush() {
      if (engine) await engine.flush();
      else if (pending.length && config) await loadEngine().then((e) => e.flush());
    },
    withRequest(request) {
      return scoped(request);
    },
  };
  return client;
}
