/**
 * The one seam between `ui/next` and the core client.
 *
 * The UI drives the widget flow through the client's `SpotterWidgetApi`
 * (`captureForReport`, `submitFromWidget`, `setState`, …). Everything here is
 * feature-detected with a fallback, so a UI build against an older or
 * narrower client degrades instead of crashing, and any integration change
 * is a one-file edit.
 *
 * Core is reached only through a dynamic `import()`: the loader (Provider +
 * trigger) never carries the client; it loads on idle or first interaction.
 */
import type { AnnotationShape, Category, FieldValue, ReportReceipt, ReportStatusView, Severity, SimilarIssue } from "../../../core/schema.ts";
import type {
  AttachmentSummary,
  OpenOptions,
  ReporterMode,
  SpotterClient,
  SpotterConfig,
  SpotterState,
  SpotterWidgetApi,
  StoredReport,
  WidgetCapture,
} from "../../../core/types.ts";

export type Client = SpotterClient & Partial<SpotterWidgetApi>;

type CoreModule = { spotter: Client };

let clientPromise: Promise<Client> | null = null;
let client: Client | null = null;

/** Load core (once). Safe to call from event handlers and effects; never at import time. */
export function loadClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (import("../../../core/index.ts") as Promise<unknown>).then((m) => {
      client = (m as CoreModule).spotter;
      return client;
    });
    clientPromise.catch(() => {
      clientPromise = null; // A failed chunk load (offline) may be retried on the next interaction.
    });
  }
  return clientPromise;
}

export function peekClient(): Client | null {
  return client;
}

/** Init once; a second Provider (strict mode, HMR) reuses the initialised singleton. */
export async function initClient(config: SpotterConfig): Promise<Client> {
  const c = await loadClient();
  if (!c.initialized) c.init(config);
  return c;
}

export async function preload(feature: "widget" | "screenshot" | "annotate" | "recording"): Promise<void> {
  const c = await loadClient();
  try {
    await c.preload?.(feature);
  } catch {
    /* preload is an optimisation */
  }
}

export function setState(state: SpotterState): void {
  try {
    client?.setState?.(state);
  } catch {
    /* mirror only */
  }
}

// -- capture ------------------------------------------------------------------------------

export interface CaptureRequest {
  screenshot: boolean;
  element?: Element | null;
  exclude: Element[];
}

export async function capture(req: CaptureRequest): Promise<WidgetCapture> {
  const c = await loadClient();
  if (c.captureForReport) {
    return await c.captureForReport({
      screenshot: req.screenshot ? "viewport" : false,
      element: req.element ?? undefined,
      exclude: req.exclude,
    });
  }
  // Older client: no pre-capture; signals are snapshotted at submit time.
  return { id: "", capturedAt: new Date().toISOString(), page: {}, attachments: [], test: c.config.environment === "development" };
}

export function discardCapture(id: string | undefined): void {
  if (id) client?.discardCapture?.(id);
}

// -- submit --------------------------------------------------------------------------------

export interface UiDraft {
  captureId?: string;
  mode: NonNullable<OpenOptions["mode"]>;
  description: string;
  title?: string;
  expected?: string;
  category: Category;
  severity?: Severity;
  fields: Record<string, FieldValue>;
  annotations: AnnotationShape[];
  annotatedScreenshot?: Blob;
  include: Partial<Record<AttachmentSummary["kind"], boolean>>;
  email?: string;
  recording?: { blob: Blob; contentType?: string; startedAt?: string; endedAt?: string };
  files?: File[];
  /** Team mode. */
  assignee?: string;
  labels?: string[];
}

export async function submit(draft: UiDraft): Promise<ReportReceipt> {
  const c = await loadClient();
  // The widget draft has no assignee / labels yet: they travel as reserved custom fields.
  const fields: Record<string, FieldValue> = { ...draft.fields };
  if (draft.assignee) fields["spotter.assignee"] = draft.assignee;
  if (draft.labels && draft.labels.length > 0) fields["spotter.labels"] = draft.labels;
  if (c.submitFromWidget) {
    return await c.submitFromWidget({
      captureId: draft.captureId || undefined,
      title: draft.title,
      description: draft.description,
      expected: draft.expected,
      category: draft.category,
      severity: draft.severity,
      fields,
      annotations: draft.annotations,
      annotatedScreenshot: draft.annotatedScreenshot,
      include: draft.include,
      email: draft.email,
      recording: draft.recording,
      files: draft.files,
      mode: draft.mode === "picker" ? "report" : draft.mode,
    });
  }
  return await c.report({
    title: draft.title ?? draft.description.split("\n")[0]!.slice(0, 120),
    description: draft.description,
    expected: draft.expected,
    category: draft.category,
    severity: draft.severity,
    fields,
    email: draft.email,
    include: { screenshot: false },
  });
}

// -- reporter ------------------------------------------------------------------------------

export function reporterMode(): ReporterMode {
  try {
    return client?.reporterMode?.() ?? { type: "public" };
  } catch {
    return { type: "public" };
  }
}

/**
 * Whether `identify()` was called (the Contact step is skipped then).
 * Reads `identity()` when the client exposes it.
 */
export function identity(): { id?: string; email?: string; name?: string } | null {
  const c = client as (Client & { identity?: () => { id?: string; email?: string; name?: string } | null }) | null;
  try {
    return c?.identity?.() ?? null;
  } catch {
    return null;
  }
}

export async function connectTeam(): Promise<ReporterMode | null> {
  const c = await loadClient();
  return (await c.connectTeam?.()) ?? null;
}

export function remoteConfig() {
  try {
    return client?.remoteConfig?.() ?? null;
  } catch {
    return null;
  }
}

export async function similar(page: { url?: string; selector?: string }): Promise<SimilarIssue[]> {
  const c = await loadClient();
  try {
    return await c.similar(page);
  } catch {
    return [];
  }
}

export async function plusOne(id: string): Promise<number | null> {
  const c = await loadClient();
  try {
    return await c.plusOne(id);
  } catch {
    return null;
  }
}

export function myReports(): StoredReport[] {
  try {
    return client?.myReports?.() ?? [];
  } catch {
    return [];
  }
}

export async function status(id: string): Promise<ReportStatusView | null> {
  const c = await loadClient();
  try {
    return await c.status(id);
  } catch {
    return null;
  }
}

export async function reply(id: string, body: string): Promise<ReportStatusView | null> {
  const c = await loadClient();
  return await c.reply(id, body);
}

export function setRouteResolver(fn: ((url: string) => string | undefined) | null): void {
  client?.setRouteResolver?.(fn);
}

export async function startRecording(options: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void }) {
  const c = await loadClient();
  if (!c.startRecording) throw new Error("recording unavailable");
  return await c.startRecording(options);
}

/** Team-mode developer details. Uses the client's `devDetails()` when present, else what the page itself knows. */
export interface DevDetails {
  consoleErrors: { message: string; at?: string }[];
  failedRequests: { method: string; url: string; status: number }[];
  environment: Record<string, string>;
}

export function devDetails(captureId: string | undefined): DevDetails {
  const c = client as (Client & { devDetails?: (captureId?: string) => DevDetails | null }) | null;
  try {
    const d = c?.devDetails?.(captureId);
    if (d) return d;
  } catch {
    /* fall through */
  }
  const env: Record<string, string> = {};
  if (typeof window !== "undefined") {
    env.URL = location.href;
    env.Viewport = `${innerWidth}×${innerHeight} @${devicePixelRatio}x`;
    env["User agent"] = navigator.userAgent;
    env.Language = navigator.language;
  }
  return { consoleErrors: [], failedRequests: [], environment: env };
}

/** Subscribe to programmatic `spotter.open()` / `close()`. */
export function onOpenClose(c: Client, open: (o: OpenOptions) => void, close: () => void): () => void {
  const offOpen = c.on("open", (o) => open(o ?? {}));
  const offClose = c.on("close", () => close());
  return () => {
    offOpen();
    offClose();
  };
}
