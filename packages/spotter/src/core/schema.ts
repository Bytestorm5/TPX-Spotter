/**
 * `spotter.report.v1` — the ticket every report becomes, and the wire
 * protocol between the SDK, an ingest (the `/api/spotter` route handler that
 * `ui/next` installs, or Trusplex Console's hosted ingest) and the hooks.
 *
 * The published JSON Schema (`schema/spotter.report.v1.json`) describes
 * exactly `SpotterReportV1`; Dispatcher, Console, webhooks and third-party
 * trackers all consume that one shape. Additive changes only within v1:
 * a breaking change is `spotter.report.v2`, and deprecations warn for at
 * least one minor release.
 *
 * Timestamps on the wire are ISO-8601 strings; durations and offsets are
 * milliseconds.
 */

export const REPORT_SCHEMA_ID = "spotter.report.v1" as const;
export const PROTOCOL_VERSION = 1 as const;

// -- vocabulary -------------------------------------------------------------------

export const REPORT_SOURCES = ["widget", "api", "flag", "error", "server"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ["bug", "ux", "content", "performance", "question", "feature"] as const;
export type Category = (typeof CATEGORIES)[number];

/** What the reporter sees. */
export const PUBLIC_STATUSES = ["received", "in_progress", "needs_info", "resolved", "wont_fix"] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];

export const REPORTER_TYPES = ["public", "guest", "team"] as const;
export type ReporterType = (typeof REPORTER_TYPES)[number];

export const ARTIFACT_KINDS = [
  "screenshot",
  "annotated_screenshot",
  "replay",
  "recording",
  "attachment",
  "dom_snapshot",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const BREADCRUMB_CATEGORIES = [
  "click",
  "input",
  "scroll",
  "focus",
  "navigation",
  "network",
  "console",
  "error",
  "custom",
  "rage_click",
  "dead_click",
  "error_click",
] as const;
export type BreadcrumbCategory = (typeof BREADCRUMB_CATEGORIES)[number];

export const CUSTOM_FIELD_TYPES = ["text", "textarea", "select", "multiselect", "checkbox", "rating", "file"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

// -- the ticket -------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Reporter {
  /** From `identify({ id })`; absent for anonymous reporters. */
  id?: string;
  email?: string;
  name?: string;
  /** Everything else passed to `identify()` (plan, role, …). */
  traits: Record<string, Json>;
  type: ReporterType;
  /** How the reporter wants to hear back. `none` = no contact known or opted out. */
  contact: "email" | "in_app" | "none";
}

/** A value of a declared custom field; typed by the field's declaration. */
export type FieldValue = string | number | boolean | string[] | null;

export interface AnnotationShape {
  tool: "arrow" | "rect" | "freehand" | "text" | "pin" | "blur";
  /** Points in screenshot pixel space (arrow: 2 points, rect/blur: 2 corners, freehand: n, text/pin: 1). */
  points: { x: number; y: number }[];
  color?: string;
  /** Text for `text`, the number for `pin`. */
  label?: string;
}

export interface ReportContent {
  title: string;
  description: string;
  /** The optional "What did you expect?" answer. */
  expected?: string;
  category: Category;
  severity: Severity;
  /** Custom field values keyed by field id. */
  fields: Record<string, FieldValue>;
  annotations: AnnotationShape[];
}

export interface PageInfo {
  url: string;
  /** e.g. `/blog/[slug]` — from the App Router integration when available. */
  routePattern?: string;
  title?: string;
  referrer?: string;
  /** CSS selector of the element the report is about (element reports / the picker). */
  selector?: string;
  /** Redacted outerHTML excerpt around the selected element or annotation, ≤ 8 KB. */
  domExcerpt?: string;
  /** Visible text near the selection or annotation, redacted, ≤ 2 KB. */
  nearbyText?: string;
  /** The last ≤ 20 URLs visited in this tab, oldest first. */
  history: string[];
}

export interface EnvironmentInfo {
  runtime: "browser" | "node" | "edge";
  userAgent?: string;
  browser?: { name: string; version?: string };
  os?: { name: string; version?: string };
  device: "desktop" | "mobile" | "tablet" | "server" | "unknown";
  viewport?: { width: number; height: number };
  screen?: { width: number; height: number };
  dpr?: number;
  locale?: string;
  timeZone?: string;
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
  network?: { online: boolean; type?: string; effectiveType?: string; downlink?: number; rtt?: number };
}

export interface ReleaseInfo {
  version?: string;
  commit?: string;
  deployId?: string;
  /** production, preview, staging, development, … */
  environment?: string;
}

export interface ReportContext {
  /** Indexed, filterable string tags. */
  tags: Record<string, string>;
  /** Named structured context (`setContext`). */
  contexts: Record<string, Record<string, Json>>;
  /** Evaluated feature-flag values (`setFlags`, OpenFeature). */
  flags: Record<string, Json>;
}

export interface ConsoleEntry {
  level: ConsoleLevel;
  /** ISO timestamp. */
  at: string;
  /** Serialized, redacted arguments (strings truncated at 8 KB). */
  args: Json[];
  stack?: string;
}

export interface StackFrame {
  function?: string;
  file?: string;
  line?: number;
  column?: number;
  /** Set by the ingest once source maps are applied. */
  original?: { file: string; line: number; column: number; function?: string };
}

export interface ErrorEntry {
  at: string;
  type: string;
  message: string;
  stack?: string;
  frames: StackFrame[];
  /** uncaught | unhandledrejection | boundary | captured | server */
  mechanism: "uncaught" | "unhandledrejection" | "boundary" | "captured" | "server";
  componentStack?: string;
}

/** HAR 1.2, trimmed to what Spotter records (https://w3c.github.io/web-performance/specs/HAR/Overview.html). */
export interface Har {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: { name: string; value: string }[];
    queryString: { name: string; value: string }[];
    cookies: [];
    headersSize: -1;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: { name: string; value: string }[];
    cookies: [];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: -1;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number; blocked?: number; dns?: number; connect?: number };
  /** Spotter extensions (HAR allows `_`-prefixed custom fields). */
  _initiator?: "fetch" | "xhr" | "beacon";
  _traceparent?: string;
  _error?: string;
}

export interface Breadcrumb {
  at: string;
  category: BreadcrumbCategory;
  message: string;
  level?: "debug" | "info" | "warning" | "error";
  /** CSS selector of the target, for DOM breadcrumbs. */
  selector?: string;
  data?: Record<string, Json>;
}

export interface NavigationEntry {
  at: string;
  from?: string;
  to: string;
  /** push | replace | pop | load | hash */
  kind: "push" | "replace" | "pop" | "load" | "hash";
  routePattern?: string;
}

export interface PerformanceSnapshot {
  lcp?: number;
  inp?: number;
  cls?: number;
  ttfb?: number;
  fcp?: number;
  longTasks: { at: string; duration: number }[];
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  /** Resources slower than the threshold (default 1 s). */
  slowResources: { url: string; duration: number; initiatorType: string; transferSize?: number }[];
}

export interface StorageSnapshot {
  /** Keys only, unless a key is allowlisted (`privacy.storageValues`). */
  localStorage: { key: string; value?: string }[];
  sessionStorage: { key: string; value?: string }[];
  cookies: { key: string; value?: string }[];
}

export interface ReportSignals {
  console: ConsoleEntry[];
  errors: ErrorEntry[];
  network: Har;
  breadcrumbs: Breadcrumb[];
  navigation: NavigationEntry[];
  performance?: PerformanceSnapshot;
  storage?: StorageSnapshot;
}

export interface ArtifactRef {
  name: string;
  kind: ArtifactKind;
  contentType: string;
  /** Bytes, after compression (replay is gzip-compressed rrweb JSON). */
  size: number;
  /** A short-lived signed URL, set by the ingest. Absent while uploading. */
  url?: string;
  /** For replay/recording: covered time window. */
  startedAt?: string;
  endedAt?: string;
  /** `uploading` until the chunked upload completes. */
  state: "pending" | "uploading" | "stored" | "failed";
}

export interface TraceInfo {
  /** W3C `traceparent` values seen on recent requests. */
  traceparents: string[];
  /** The browser session id the server side can link to (`x-spotter-session`). */
  sessionId?: string;
  /** Server-side events linked to this report through the trace or session. */
  serverEvents: { at: string; kind: "error" | "report" | "flag"; message: string; traceparent?: string }[];
}

export interface StatusChange {
  status: PublicStatus;
  at: string;
  /** Shown to the reporter (e.g. "Fixed in v2.14, live now."). */
  message?: string;
  release?: string;
  /** Internal actor; never shown to the reporter. */
  actor?: string;
}

export interface ReportStatus {
  public: PublicStatus;
  history: StatusChange[];
}

export interface SdkInfo {
  name: "@trusplex/spotter";
  version: string;
  /** The features compiled into the reporting build. */
  features: string[];
}

export interface SpotterReportV1 {
  schema: typeof REPORT_SCHEMA_ID;
  id: string;
  /** Human reference, e.g. `SPT-4821`. */
  ref: string;
  createdAt: string;
  source: ReportSource;
  /** Test-mode reports (`environment: 'development'`) go to a separate inbox. */
  test: boolean;
  /** Grouping key; flags carry the caller's fingerprint, reports a derived one. */
  fingerprint: string;
  reporter: Reporter;
  content: ReportContent;
  page: PageInfo;
  environment: EnvironmentInfo;
  release: ReleaseInfo;
  context: ReportContext;
  signals: ReportSignals;
  artifacts: ArtifactRef[];
  trace: TraceInfo;
  /** The agent-readable timeline: one step per line, e.g. "clicked Pay → POST /api/charge 502 → error toast shown". */
  timeline: string[];
  status: ReportStatus;
  sdk: SdkInfo;
  /** When the report came from a promoted flag. */
  flag?: { name: string; occurrences: number };
}

// -- the issue event ----------------------------------------------------------------

/** What hooks receive: the ticket, as broadcast by the `issue` event. */
export type Issue = SpotterReportV1;

/** A link a hook stored on the issue (`send()`'s return). */
export interface IssueLink {
  hook: string;
  externalId: string;
  url: string;
}

// -- wire protocol --------------------------------------------------------------------
//
// Base URL: the first-party route handler (`/api/spotter`, default) or
// Console's hosted ingest (`https://console.trusplex.com/hooks/spotter`).
//
// Credentials:
//   x-spotter-key: pk_live_… | pk_test_…   public project key, origin-bound (browser)
//   authorization: Bearer sk_live_…        secret key (server-side SDK, the route handler, build uploads)
//   Beacon requests cannot set headers: `/v1/events` also accepts `key` in the body.
//
// A route handler forwarding browser traffic with a secret key may pass the
// browser's facts, which the hosted ingest trusts only alongside a valid
// secret key:
//   x-spotter-forwarded-for, x-spotter-forwarded-origin, x-spotter-forwarded-ua,
//   x-spotter-forwarded-country
//
//   GET  /v1/config                               → RemoteConfig
//   POST /v1/reports            ReportSubmission  → ReportReceipt (201)
//   HEAD /v1/reports/:id/artifacts/:name          → `upload-offset` header (resume)
//   PUT  /v1/reports/:id/artifacts/:name?offset=&total=   raw chunk; x-spotter-upload-token
//   POST /v1/reports/:id/complete                 → { ok: true } — fires the issue event
//   GET  /v1/reports/:id/status?token=            → ReportStatusView
//   POST /v1/reports/:id/replies    { token, body } → ReportStatusView
//   POST /v1/reports/:id/plus-one   { token? , reporter? } → { count }
//   GET  /v1/similar?url=&selector=               → SimilarIssue[]  (team/guest mode by default)
//   POST /v1/flags              FlagBatch         → { accepted, promoted: ReportReceipt[] }
//   POST /v1/events             AnalyticsBatch    → 202
//   POST /v1/sessions/:sessionId/replay?seq=      gzip rrweb segment (sampled / on-error)
//   POST /v1/releases           ReleaseDeclaration (secret key) → { release }
//   PUT  /v1/releases/:release/sourcemaps?file=   raw .map (secret key)
//   GET  /v1/portal?token=                        → PortalView (reporter portal)
//
// Errors are `{ error: string, code: string }` with the HTTP status.

/** The report as the SDK submits it: the ticket minus what the ingest assigns. */
export interface ReportSubmission {
  schema: typeof REPORT_SCHEMA_ID;
  /** Client-generated idempotency key: resubmitting the same key returns the first receipt. */
  clientId: string;
  createdAt: string;
  source: ReportSource;
  test: boolean;
  fingerprint?: string;
  reporter: Reporter;
  content: ReportContent;
  page: PageInfo;
  environment: EnvironmentInfo;
  release: ReleaseInfo;
  context: ReportContext;
  signals: ReportSignals;
  /** Artifacts the client will upload after the receipt (name, kind, contentType, size). */
  artifacts: Omit<ArtifactRef, "url" | "state">[];
  trace: TraceInfo;
  timeline: string[];
  sdk: SdkInfo;
  flag?: { name: string; occurrences: number };
  /** A team-mode token from Console (`/spotter/connect`), when the reporter is a signed-in Trusplex user. */
  teamToken?: string;
  /** A guest invite token, when the reporter came through a guest link. */
  guestToken?: string;
  /** Cloudflare Turnstile response, when the project requires it for anonymous submissions. */
  turnstileToken?: string;
}

export interface ReportReceipt {
  id: string;
  ref: string;
  /** Where the team sees it (Console, or the self-hosted handler's view). */
  url?: string;
  /** The reporter's status link / portal, when enabled. */
  statusUrl?: string;
  /** The reporter's capability token: required for status, replies and uploads. */
  token: string;
  /** One entry per declared artifact. */
  uploads: { name: string; url: string }[];
  /**
   * Client-side only: the submit failed and the report sits in the offline
   * queue. `id` is provisional (`pending_…`), `ref` is `SPT-PENDING-xxxx`;
   * the queue delivers it later and `status()` follows the real id.
   */
  queued?: boolean;
}

export interface ReportStatusView {
  id: string;
  ref: string;
  title: string;
  status: PublicStatus;
  history: StatusChange[];
  /** The conversation with the reporter (needs-info questions and replies). */
  messages: { at: string; from: "team" | "reporter"; body: string }[];
  updatedAt: string;
}

export interface SimilarIssue {
  id: string;
  ref: string;
  title: string;
  status: PublicStatus;
  /** Reporters who +1'd or filed a duplicate. */
  count: number;
}

export interface FlagOccurrence {
  name: string;
  severity: Severity;
  fingerprint: string[];
  at: string;
  data?: Record<string, Json>;
  page?: { url: string; routePattern?: string };
  release?: ReleaseInfo;
  reporter?: Pick<Reporter, "id" | "email">;
  sessionId?: string;
  /** Set when `captureReplay` uploaded the buffer under this session's replay. */
  replaySegment?: number;
  /** Local count since the last send, after client-side rate limiting. */
  count: number;
  environment?: Pick<EnvironmentInfo, "browser" | "os" | "device">;
  test?: boolean;
}

export interface FlagBatch {
  flags: FlagOccurrence[];
  sdk: SdkInfo;
}

// -- analytics ------------------------------------------------------------------------

export const ANALYTICS_EVENT_TYPES = ["pageview", "event", "engagement", "vitals"] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  /** For `event`: the event name (`signup_completed`, or an automatic one: `outbound`, `download`, `form_submit`, `404`, `js_error`). */
  name?: string;
  at: string;
  url: string;
  routePattern?: string;
  title?: string;
  referrer?: string;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  /** Click IDs present on the landing URL (gclid, fbclid, msclkid, …): names only. */
  clickIds?: string[];
  props?: Record<string, string | number | boolean>;
  revenue?: { value: number; currency: string };
  /** `engagement`: visible milliseconds on the page and max scroll depth (0–100). */
  engagedMs?: number;
  scrollDepth?: number;
  /** `vitals`: field data for the pageview. */
  vitals?: { lcp?: number; inp?: number; cls?: number; ttfb?: number; fcp?: number };
  /** Page-scoped id linking pageview, engagement and vitals. */
  pageviewId: string;
  /** Cookie mode only: the first-party visitor id. Cookieless mode never sends one. */
  visitorId?: string;
  /** Tab-session id (sessionStorage), cookieless-safe: not persisted across sessions. */
  sessionId?: string;
  /** Present only with `analytics.identify: true` and consent. */
  userId?: string;
  screen?: { width: number; height: number };
  language?: string;
  release?: ReleaseInfo;
  flags?: Record<string, Json>;
}

export interface AnalyticsBatch {
  /** Beacons cannot set headers. */
  key?: string;
  events: AnalyticsEvent[];
  sdk: SdkInfo;
}

// -- remote config ----------------------------------------------------------------------

export interface CustomFieldDeclaration {
  id: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** Show only when another field / the category has one of these values. */
  showWhen?: { field: string; equals: string | string[] };
  validation?: { pattern?: string; min?: number; max?: number; message?: string };
}

export interface TargetingRule {
  routes?: string[];
  excludeRoutes?: string[];
  environments?: string[];
  /** Reporter segments: `identified`, `anonymous`, `team`, `guest`, or `trait:<key>=<value>`. */
  segments?: string[];
  releases?: string[];
}

export interface Appearance {
  theme?: "light" | "dark" | "auto";
  preset?: "default" | "minimal" | "rounded" | "sharp";
  mode?: "inherit" | "styled" | "unstyled";
  variables?: Partial<{
    colorPrimary: string;
    colorBackground: string;
    colorText: string;
    colorDanger: string;
    fontFamily: string;
    borderRadius: string;
    spacingUnit: string;
  }>;
  elements?: Record<string, string | Record<string, string>>;
  layout?: Partial<{
    position: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    offset: number;
    density: "comfortable" | "compact";
    panelWidth: number;
    label: string;
  }>;
}

/**
 * Remote config from Console. It can only narrow what code config and the
 * compiled features allow: `features` entries can disable, never enable;
 * sample rates are capped by code; code config overrides everything else.
 */
export interface RemoteConfig {
  version: number;
  features?: Partial<Record<"widget" | "screenshot" | "annotate" | "replay" | "analytics" | "flags" | "recording", boolean>>;
  trigger?: {
    type?: "floating" | "none";
    shortcut?: string | null;
    targeting?: TargetingRule;
    shakeToReport?: boolean;
  };
  fields?: CustomFieldDeclaration[];
  appearance?: Appearance;
  replay?: {
    mode?: "buffer" | "on_error" | "sampled" | "off";
    windowSeconds?: number;
    sampleRate?: number;
    sampling?: { routes?: Record<string, number>; segments?: Record<string, number>; releases?: Record<string, number> };
  };
  analytics?: { sampleRate?: number; honorGpc?: boolean; honorDnt?: boolean };
  duplicates?: { public?: boolean; team?: boolean; guest?: boolean };
  poweredBy?: boolean;
  requireTurnstile?: boolean;
  turnstileSiteKey?: string;
  /** Console asks for a feature that isn't compiled in: shown as a warning there, ignored here. */
  warnings?: string[];
}

// -- builds -------------------------------------------------------------------------------

export interface ReleaseDeclaration {
  version: string;
  commit?: string;
  deployId?: string;
  environment?: string;
  /** Source map file names that will be uploaded. */
  files?: string[];
  features?: string[];
}

// -- reporter portal ------------------------------------------------------------------------

export interface PortalView {
  reporter: { name?: string; email?: string; type: ReporterType };
  reports: (ReportStatusView & { createdAt: string })[];
}
