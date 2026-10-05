/**
 * The public API of `@trusplex/spotter/core`: config, the client, hooks.
 * Shapes on the wire and in the ticket live in `schema.ts`.
 */
import type {
  Appearance,
  ArtifactKind,
  Breadcrumb,
  Category,
  ErrorEntry,
  CustomFieldDeclaration,
  FlagOccurrence,
  Issue,
  IssueLink,
  Json,
  PublicStatus,
  RemoteConfig,
  ReportReceipt,
  ReportStatusView,
  ReportSubmission,
  ReporterType,
  Severity,
  SimilarIssue,
  SpotterReportV1,
  TargetingRule,
  AnalyticsEvent,
  FieldValue,
  AnnotationShape,
  PageInfo,
} from "./schema.ts";
import type { FeatureName } from "./features.ts";
import type { ScreenshotResult } from "./internal.ts";

// -- config -------------------------------------------------------------------------

export type ReplayMode = "buffer" | "on_error" | "sampled" | "off";
export type MaskText = "none" | "inputs" | "all";

export interface ReplayConfig {
  mode?: ReplayMode;
  /** Rolling window for buffer / on-error modes: 15–300 s, default 60. */
  windowSeconds?: number;
  /** Sampled mode: fraction of sessions fully recorded (0–1). */
  sampleRate?: number;
  /** Per-route / per-segment / per-release sample rates (sampled mode), e.g. `{ routes: { '/checkout/*': 1 } }`. */
  sampling?: { routes?: Record<string, number>; segments?: Record<string, number>; releases?: Record<string, number> };
  /** Opt specific canvases / videos / iframes back in, by selector. */
  recordCanvas?: string[];
  recordMedia?: string[];
  recordIframes?: string[];
}

export interface PrivacyConfig {
  /** Replay and screenshot text masking. Default `inputs`. */
  maskText?: MaskText;
  /** Extra selectors to mask / block beside `data-spotter-mask` / `data-spotter-block`. */
  maskSelectors?: string[];
  blockSelectors?: string[];
  /** Network capture: allowlisted URL patterns (glob or RegExp) whose bodies may be captured. Default none. */
  networkBodies?: (string | RegExp)[];
  /** Extra request/response headers to capture (Authorization, Cookie, Set-Cookie never are). */
  networkHeaders?: string[];
  /** Storage keys whose values may be captured (localStorage / sessionStorage / cookies). */
  storageValues?: string[];
  /** Extra URL query parameter names to strip (beside token, key, secret, password, code, …). */
  stripQueryParams?: string[];
  /** Show the reporter everything attached and let them remove items before sending. */
  reviewBeforeSend?: boolean;
}

export interface AnalyticsConfig {
  /** Cookieless (default) or a first-party cookie for longer-lived visitors. */
  mode?: "cookieless" | "cookie";
  /** Link analytics to `identify()`'s id. Requires analytics consent. */
  identify?: boolean;
  honorGpc?: boolean;
  honorDnt?: boolean;
  sampleRate?: number;
  /** Automatic events; all on by default. */
  autoEvents?: Partial<Record<"outbound" | "download" | "form_submit" | "404" | "js_error", boolean>>;
  /** File extensions counted as downloads. */
  downloadExtensions?: string[];
  /** Report a 404: a function of the document, or a selector whose presence means 404. */
  notFound?: string | (() => boolean);
  /**
   * Send pointer clicks (`click` events: page-relative position and a
   * selector, never text) so Console can draw an activity heatmap. Default on.
   */
  heatmap?: boolean;
}

export interface CaptureConfig {
  consoleEntries?: number;
  networkEntries?: number;
  breadcrumbs?: number;
  navigationHistory?: number;
  /** Slow-resource threshold, ms. */
  slowResourceMs?: number;
  /** Turn individual signals off. */
  disable?: ("console" | "errors" | "network" | "navigation" | "actions" | "environment" | "performance" | "storage" | "trace")[];
}

export interface TriggerConfig {
  /** `floating` (default), a selector to bind to, or `none` for headless. */
  type?: "floating" | "none" | string;
  /** e.g. `Shift+Alt+B`. Default off. */
  shortcut?: string | null;
  /** Mobile web shake / long-press, opt-in. */
  shake?: boolean;
  longPress?: boolean;
  targeting?: TargetingRule;
}

// -- automatic reports -----------------------------------------------------------------

/** What an automatic report can be triggered by. */
export type AutoReportKind =
  /** Uncaught errors and unhandled promise rejections. */
  | "error"
  /** fetch / XHR responses with an error status, and requests that failed outright (offline, CORS, DNS). */
  | "network"
  /** The page itself: the document's HTTP status, or a client-side (RSC) navigation's. */
  | "page"
  /** `console.error` / `console.warn` calls. */
  | "console"
  /** `<img>`, `<script>`, `<link>`, `<video>`… that failed to load. */
  | "resource"
  /** Content-Security-Policy violations. */
  | "csp"
  /** Server-side errors (`createOnRequestError()` in instrumentation.ts). */
  | "server";

/**
 * An HTTP status, a class (`"4xx"`, `"5xx"`), or an inclusive range
 * (`"400-403"`). Prefix with `!` to exclude (`"!404"`).
 */
export type StatusSpec = number | string;

/**
 * One rule for a kind of problem. Every field set must match (AND); leave a
 * field out to match anything. Patterns are case-insensitive substrings for
 * messages and globs (`*`, a leading `/` matches the path) for URLs; RegExps
 * work too (from client code: they can't cross the server → client boundary).
 */
export interface AutoReportMatcher {
  /** `network`, `page`, `resource`, `server`: which statuses count. */
  status?: StatusSpec | StatusSpec[];
  /** Only these URLs (the request, the page, the resource or the blocked URI). */
  urls?: (string | RegExp)[];
  ignoreUrls?: (string | RegExp)[];
  /** `network`: only these HTTP methods. */
  methods?: string[];
  /** Only problems whose message contains / matches one of these. */
  messages?: (string | RegExp)[];
  ignoreMessages?: (string | RegExp)[];
  /** `error` / `console` / `server`: error class names (`TypeError`, `ChunkLoadError`). */
  types?: string[];
  /** `error`: `uncaught`, `unhandledrejection`. */
  mechanisms?: ("uncaught" | "unhandledrejection")[];
  /** `console`: levels. Default `["error"]`. */
  levels?: ("error" | "warn")[];
  /** `console`: only calls that pass an `Error` (how React, Next and most apps log caught exceptions). Default true. */
  withError?: boolean;
  /** `network` / `resource`: requests that never got a response (offline, CORS, DNS, blocked). Default true. */
  failed?: boolean;
  /** `network`: count aborted requests (`AbortController`, navigation away). Default false. */
  aborted?: boolean;
  /** Severity of reports this rule files (defaults by kind and status). */
  severity?: Severity;
}

/** `true` → the kind's defaults, `false` → off, or one or more matchers (any may match). */
export type AutoReportRule = boolean | AutoReportMatcher | AutoReportMatcher[];

/** A problem Spotter noticed, as `autoReport.filter` sees it. */
export interface AutoReportEvent {
  kind: AutoReportKind;
  /** ISO timestamp. */
  at: string;
  /** Human-readable, unredacted (redaction runs before anything is sent). */
  message: string;
  /** Error class name, `HTTP 502`, `ResourceError`, `CSPViolation`… */
  type: string;
  status?: number;
  statusText?: string;
  url?: string;
  method?: string;
  /** Request duration, ms. */
  duration?: number;
  mechanism?: ErrorEntry["mechanism"];
  level?: "error" | "warn";
  /** `resource`: the element's tag (`img`, `script`, …). `csp`: the violated directive. */
  element?: string;
  directive?: string;
  /** `page`: true for a client-side navigation (RSC request) rather than the document load. */
  soft?: boolean;
  /** The thrown value, when there is one. */
  error?: unknown;
  /** Raw stack, when there is one. */
  stack?: string;
}

export interface AutoReportConfig {
  /** Default true once `autoReport` is set; `false` turns it off without removing the rules. */
  enabled?: boolean;
  /** Uncaught errors and unhandled rejections. Default on. */
  errors?: AutoReportRule;
  /** Failed requests. Default `{ status: "5xx", failed: true }`: 4xx (404, 401, 422…) are not reported. */
  network?: AutoReportRule;
  /** The page's own HTTP status. Default `{ status: "5xx" }`; add `404` to report broken links. */
  page?: AutoReportRule;
  /** `console.error` calls that pass an Error (React error boundaries, `catch (e) { console.error(e) }`). Default on. */
  console?: AutoReportRule;
  /** Failed `<img>` / `<script>` / `<link>` loads. Default off. */
  resources?: AutoReportRule;
  /** CSP violations. Default off. */
  csp?: AutoReportRule;
  /** Server errors, for `createOnRequestError()`. Default `{ status: "5xx" }`. */
  server?: AutoReportRule;
  /** Messages or URLs never reported, whatever the kind (substring / glob / RegExp). */
  ignore?: (string | RegExp)[];
  /**
   * Last word on every problem Spotter notices (bar `ignore`d ones), matched or not: return
   * `true` to report it, `false` to drop it, nothing to keep the rules'
   * decision. Client code only (a function can't be passed from a server
   * component).
   */
  filter?: (event: AutoReportEvent, matched: boolean) => boolean | void;
  /**
   * Problems within this window (ms) of the first one go into the same report
   * (a failed request, the rejection it caused and the error it logged are
   * one report). Default 1000.
   */
  delayMs?: number;
  limits?: {
    /** Reports per distinct problem per tab session (server: per process per hour). Default 1. */
    perIssue?: number;
    /** Automatic reports per tab session (server: per process per hour). Default 10. */
    perSession?: number;
  };
  /** What to attach. Default everything on: screenshot, replay, console, network, storage, DOM. */
  include?: ReportInput["include"];
  /** Tags on every automatic report (beside `spotter.auto` / `spotter.trigger`). */
  tags?: Record<string, string>;
  /** Severity for every automatic report (overrides the per-kind defaults). */
  severity?: Severity;
}

export interface SpotterConfig {
  /**
   * File a report automatically when something goes wrong: uncaught errors,
   * 5xx responses, failed page loads and more, each configurable (see
   * `AutoReportConfig`). `true` uses the defaults. Default off.
   */
  autoReport?: boolean | AutoReportConfig;
  /** The public project key (`pk_live_…` / `pk_test_…`). */
  project?: string;
  /** Server only: the secret key (`sk_…`), from `SPOTTER_SECRET_KEY`. Never ship it to the browser. */
  secretKey?: string;
  /** Ingest base URL. Browser default `/api/spotter`; server default Console's hosted ingest. */
  endpoint?: string;
  /**
   * End request paths with a slash (`/api/spotter/v1/events/`), for a Next app
   * with `trailingSlash: true` that would otherwise redirect every call.
   * `<SpotterProvider>` turns it on when `withSpotter()` saw `trailingSlash: true`
   * and the endpoint is on the same origin (a path).
   */
  trailingSlash?: boolean;
  /** `development` sends to the test inbox and shows a Test ribbon. */
  environment?: string;
  release?: { version?: string; commit?: string; deployId?: string };
  replay?: ReplayConfig;
  privacy?: PrivacyConfig;
  analytics?: AnalyticsConfig;
  capture?: CaptureConfig;
  trigger?: TriggerConfig;
  fields?: CustomFieldDeclaration[];
  appearance?: Appearance;
  locale?: string;
  /** String overrides by key (see `ui/next` locales). */
  localization?: Record<string, string>;
  /** Runtime narrowing of compiled features: only `false` has an effect. */
  features?: Partial<Record<FeatureName, boolean>>;
  /** Fetch remote config from Console on idle. Default true when `project` is set. */
  remoteConfig?: boolean;
  /** Expose `window.__trusplexSpotter`. Default true. */
  globalHandle?: boolean;
  /** Show "Others reported something similar". Defaults: public off, team and guest on. */
  duplicates?: { public?: boolean; team?: boolean; guest?: boolean };
  /** Client-side flag rate limit per fingerprint per minute. Default 10. */
  flagRateLimit?: number;
  /** Hooks that may mutate or drop data (`null` drops). */
  beforeCapture?: (capture: CaptureRequest) => CaptureRequest | null;
  beforeSend?: (report: ReportSubmission) => ReportSubmission | null | Promise<ReportSubmission | null>;
  beforeReplayEvent?: (event: unknown) => unknown | null;
  /** Custom transport (tests, self-hosted targets). */
  transport?: Transport;
  /** Debug logging. */
  debug?: boolean;
}

// -- reporting API ---------------------------------------------------------------------

export interface IdentifyInput {
  id: string;
  email?: string;
  name?: string;
  plan?: string;
  [trait: string]: Json | undefined;
}

export interface FlagOptions {
  severity?: Severity;
  data?: Record<string, Json>;
  /** Upload the replay buffer with this flag. */
  captureReplay?: boolean;
  fingerprint?: string[];
}

/** `spotter.goal()` and funnel steps. */
export interface ConversionOptions {
  /**
   * Your id for what converted — a checkout session, an order. When one
   * checkout reports to several goals or funnels (a specific funnel and a
   * broad one), give each the same id: Console counts it once in its
   * aggregates (conversions, revenue, event counts). Console stores only a
   * hash of it.
   */
  id?: string;
  props?: Record<string, string | number | boolean>;
  revenue?: { value: number; currency: string };
  /**
   * Any JSON about this conversion — the plan, a coupon, the line items.
   * Report it on whichever goal or step knows it: Console merges it per `id`
   * (later keys win) and shows it with the conversion's revenue. Redacted
   * like a context; bounded (depth 8, 50 keys an object, 8 KB in all).
   */
  metadata?: Record<string, Json>;
}

/** A funnel declared in code: `spotter.funnel("checkout", ["cart", "shipping", "paid"])`. */
export interface SpotterFunnel<S extends string = string> {
  readonly name: string;
  readonly steps: readonly S[];
  /** The visitor reached `step` (sent as the event `<funnel>:<step>`). */
  step(step: S, options?: ConversionOptions): void;
}

export interface ReportInput {
  title: string;
  description?: string;
  expected?: string;
  severity?: Severity;
  category?: Category;
  fields?: Record<string, FieldValue>;
  include?: Partial<Record<"screenshot" | "replay" | "network" | "console" | "storage" | "dom", boolean>>;
  /** Attach an element (selector or node) — becomes `page.selector` / `domExcerpt`. */
  element?: string | Element;
  /** Extra tags for this report only. */
  tags?: Record<string, string>;
  /** Reporter contact for this report (when not identified). */
  email?: string;
  /**
   * Server-side: the incoming request. Its `x-spotter-session` and
   * `traceparent` headers link this report to the browser session and trace
   * (see also `spotter.withRequest(request)`).
   */
  request?: RequestLike;
}

/** `captureException` context: structured extras plus the same `tags` / `request` as `report()`. */
export type ExceptionContext = {
  tags?: Record<string, string>;
  request?: RequestLike;
  [key: string]: Json | RequestLike | undefined;
};

/** Anything with headers: a Fetch `Request`, `NextRequest`, or Node's `IncomingMessage`. */
export interface RequestLike {
  headers: Headers | Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
}

export interface OpenOptions {
  prefill?: Partial<Pick<ReportInput, "title" | "description" | "category" | "expected" | "fields">>;
  mode?: "report" | "text" | "feature" | "recording" | "picker";
}

/** What `beforeCapture` sees before signals are snapshotted. */
export interface CaptureRequest {
  source: SpotterReportV1["source"];
  include: Required<NonNullable<ReportInput["include"]>>;
}

export interface Attachment {
  name: string;
  kind: ArtifactKind;
  contentType: string;
  data: Blob | Uint8Array | string;
}

export type SpotterState = "idle" | "capturing" | "annotating" | "submitting" | "sent" | "error";

export interface SpotterEvents {
  open: OpenOptions;
  close: void;
  submit: ReportSubmission;
  sent: ReportReceipt;
  error: { error: unknown; stage: "capture" | "submit" | "upload" | "config" };
  statusChange: { state: SpotterState } | { reportId: string; status: PublicStatus };
  /** Client-side issue event: the redacted payload; cannot run credentialed hooks. */
  issue: ReportSubmission & { receipt: ReportReceipt };
  flag: FlagOccurrence;
  track: AnalyticsEvent;
  consent: ConsentState;
  config: RemoteConfig;
  /** An automatic report was filed (`autoReport`): what triggered it, and the receipt. */
  autoReport: { trigger: AutoReportEvent; events: AutoReportEvent[]; receipt: ReportReceipt };
}

export interface ConsentState {
  replay?: boolean;
  analytics?: boolean;
}

/** The team/guest identity the widget detected. */
export interface ReporterMode {
  type: ReporterType;
  name?: string;
}

export interface SpotterClient {
  /** Returns the same client, so `const s = spotter.init({...})` keeps its full type. */
  init(config: SpotterConfig): this;
  readonly initialized: boolean;
  readonly config: Readonly<SpotterConfig>;
  readonly state: SpotterState;
  /** Session id (tab-scoped), also sent as `x-spotter-session` on same-origin requests. */
  readonly sessionId: string;

  identify(user: IdentifyInput | null): void;
  setContext(key: string, value: Record<string, Json> | null): void;
  setTags(tags: Record<string, string>): void;
  setFlags(flags: Record<string, Json>): void;
  addBreadcrumb(crumb: Omit<Breadcrumb, "at"> & { at?: string }): void;
  attach(name: string, data: Blob | Uint8Array | string | Record<string, Json>, contentType?: string): void;
  setRedactor(fn: ((value: string, where: RedactionSite) => string) | null): void;
  setConsent(consent: ConsentState): void;

  flag(name: string, options?: FlagOptions): void;
  assert(condition: unknown, name: string, data?: Record<string, Json>): asserts condition;
  report(input: ReportInput): Promise<ReportReceipt>;
  /** Extra keys become the `exception` context; `tags` and (server) `request` are applied like `report()`'s. */
  captureException(error: unknown, context?: ExceptionContext): Promise<ReportReceipt | null>;
  status(id: string): Promise<ReportStatusView | null>;
  reply(id: string, body: string): Promise<ReportStatusView | null>;
  similar(page?: { url?: string; selector?: string }): Promise<SimilarIssue[]>;
  plusOne(id: string): Promise<number | null>;

  track(name: string, props?: Record<string, string | number | boolean>, revenue?: { value: number; currency: string }): void;
  /**
   * A conversion of the goal `name`, declared here in code: Console lists the
   * goal on its own from the first one, no setup there. The event is `name`.
   */
  goal(name: string, options?: ConversionOptions): void;
  /**
   * Declare a funnel — its steps, in order — and get a handle to report the
   * steps with. Console builds the funnel from the declaration. Cheap: call it
   * at module scope and share the handle.
   */
  funnel<const S extends string>(name: string, steps: readonly S[]): SpotterFunnel<S>;
  pageview(url?: string, routePattern?: string): void;

  open(options?: OpenOptions): void;
  close(): void;

  on<E extends keyof SpotterEvents>(event: E, fn: (payload: SpotterEvents[E]) => void): () => void;
  off<E extends keyof SpotterEvents>(event: E, fn: (payload: SpotterEvents[E]) => void): void;

  /** Feature available in this build and not narrowed away at runtime. */
  enabled(feature: FeatureName): boolean;
  /** Undo every patch (console, fetch, XHR, history), stop recording, remove the global handle. */
  destroy(): void;
}

export type RedactionSite = "console" | "network" | "text" | "url" | "breadcrumb" | "error" | "context";

// -- widget flow (used by ui/next; public so custom UIs can drive the same flow) -----------

export type PreloadableFeature = "widget" | "screenshot" | "annotate" | "replay" | "recording";

export interface WidgetCaptureOptions {
  /** The element being reported (element picker / `trigger` element reports). */
  element?: Element;
  /** Or a point: the element under it becomes `page.selector`. */
  point?: { x: number; y: number };
  /** `false` for text-only / feature-request flows. Default `viewport` when the screenshot feature is on. */
  screenshot?: boolean | "viewport" | "full" | "element";
  /** Elements to leave out of the screenshot (the Spotter UI host is always left out). */
  exclude?: Element[];
}

/** What to show the reporter: plain-language list of what will be attached. */
export interface AttachmentSummary {
  kind: "screenshot" | "replay" | "console" | "network" | "errors" | "environment" | "dom" | "storage" | "attachment";
  /** Stable, locale-free label key; the UI localizes it. */
  label: string;
  count?: number;
}

/** The moment the trigger was pressed: taken before the panel opens, so the panel is never in it. */
export interface WidgetCapture {
  id: string;
  capturedAt: string;
  screenshot?: ScreenshotResult;
  page: Partial<PageInfo>;
  attachments: AttachmentSummary[];
  /** Test mode (`environment: 'development'`): show the Test ribbon. */
  test: boolean;
}

export interface WidgetDraft {
  /** From `captureForReport()`; without it the signals are snapshotted at submit time. */
  captureId?: string;
  title?: string;
  description: string;
  expected?: string;
  category?: Category;
  severity?: Severity;
  fields?: Record<string, FieldValue>;
  annotations?: AnnotationShape[];
  /** The screenshot with annotations burned in (PNG). */
  annotatedScreenshot?: Blob;
  /** Items the reporter removed in "review before send" (`false` drops it). */
  include?: Partial<Record<AttachmentSummary["kind"], boolean>>;
  /** Contact when not identified. */
  email?: string;
  recording?: { blob: Blob; contentType?: string; startedAt?: string; endedAt?: string };
  files?: (File | Attachment)[];
  turnstileToken?: string;
  mode?: "report" | "text" | "feature" | "recording";
}

/** A report this browser filed, kept (with its capability token) in localStorage for status and replies. */
export interface StoredReport {
  id: string;
  ref: string;
  title: string;
  createdAt: string;
  statusUrl?: string;
  queued?: boolean;
  lastStatus?: PublicStatus;
}

/** Team-mode "dev details" drawer: what the page recorded, without the full report. */
export interface DevDetails {
  consoleErrors: { message: string; at?: string }[];
  failedRequests: { method: string; url: string; status: number }[];
  environment: Record<string, string>;
}

export interface RecordingSession {
  /** Stop and get the recording. */
  stop(): Promise<{ blob: Blob; contentType: string; startedAt: string; endedAt: string }>;
  cancel(): void;
}

/**
 * The widget-facing half of the client. `ui/next` drives its flow through
 * these; a custom UI can too. Nothing here is needed for code-only reporting.
 */
export interface SpotterWidgetApi {
  /** Load a feature's lazy chunk ahead of use (trigger hover / focus). */
  preload(feature: PreloadableFeature): Promise<void>;
  /** Resolves once the core engine is loaded and signals are installed. */
  ready(): Promise<void>;
  captureForReport(options?: WidgetCaptureOptions): Promise<WidgetCapture>;
  submitFromWidget(draft: WidgetDraft): Promise<ReportReceipt>;
  discardCapture(id: string): void;
  /** Team mode: console errors, failed requests and environment for a capture (or now). Null before the session chunk loads. */
  devDetails(captureId?: string): DevDetails | null;
  /** UI state machine → `state` and `statusChange` events. */
  setState(state: SpotterState): void;
  /** Remote config as applied (already narrowed), or null before it's fetched. */
  remoteConfig(): RemoteConfig | null;
  reporterMode(): ReporterMode;
  /** Who `identify()` named, or null — the widget skips the Contact step when known. */
  identity(): { id: string; email?: string; name?: string } | null;
  /** Team mode: sign in with Console in a popup. Resolves with the new mode, or null if cancelled. */
  connectTeam(): Promise<ReporterMode | null>;
  disconnectTeam(): void;
  /** Reports filed from this browser (newest first), for `<SpotterStatus/>` and the portal link. */
  myReports(): StoredReport[];
  /** Route-pattern resolver from the framework integration (App Router). */
  setRouteResolver(fn: ((url: string) => string | undefined) | null): void;
  /** Screen recording (`features.recording`). */
  startRecording(options?: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void }): Promise<RecordingSession>;
  /** Send batched flags / events now. Await it at the end of a server action or route handler. */
  flush(): Promise<void>;
  /** Server: a scope whose reports link to the browser session and trace in `request`'s headers. */
  withRequest(request: RequestLike): SpotterRequestScope;
}

export interface SpotterRequestScope {
  report(input: ReportInput): Promise<ReportReceipt>;
  captureException(error: unknown, context?: ExceptionContext): Promise<ReportReceipt | null>;
  flag(name: string, options?: FlagOptions): void;
}

// -- transport ------------------------------------------------------------------------

export interface Transport {
  config(): Promise<RemoteConfig | null>;
  submit(report: ReportSubmission): Promise<ReportReceipt>;
  upload(receipt: ReportReceipt, name: string, data: Blob | Uint8Array, contentType: string): Promise<void>;
  complete(receipt: ReportReceipt): Promise<void>;
  status(id: string, token: string): Promise<ReportStatusView | null>;
  reply(id: string, token: string, body: string): Promise<ReportStatusView | null>;
  similar(url: string, selector?: string): Promise<SimilarIssue[]>;
  plusOne(id: string, token?: string): Promise<number | null>;
  flags(batch: import("./schema.ts").FlagBatch): Promise<{ promoted: ReportReceipt[] }>;
  /** `beacon: true` on page hide: fire-and-forget via `sendBeacon`. */
  events(batch: import("./schema.ts").AnalyticsBatch, options?: { beacon?: boolean }): Promise<void>;
  /** `reason`: why the segment was uploaded (sampled session, an error, a flag); `user`: the identified user id. */
  replaySegment(
    sessionId: string,
    seq: number,
    data: Uint8Array,
    meta?: { reason?: "sampled" | "on_error" | "flag"; user?: string },
  ): Promise<void>;
}

// -- hooks (server-side only) -------------------------------------------------------------

export interface HookResult {
  externalId: string;
  url: string;
}

export interface HookRetryPolicy {
  attempts?: number;
  /** First delay, ms; doubles each attempt. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface SpotterHook {
  /** Unique id, shown in Console and the audit log. */
  name: string;
  when?: (issue: Issue) => boolean;
  send: (issue: Issue, previous?: IssueLink) => Promise<HookResult | void>;
  onStatus?: (issue: Issue, status: PublicStatus, link?: IssueLink) => Promise<void>;
  /** `fingerprint` (default) comments on the existing external ticket; `none` always creates. */
  dedupe?: "fingerprint" | "none";
  retry?: HookRetryPolicy;
}
