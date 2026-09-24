/**
 * The widget-flow half of the bridge (submit, duplicates, status, replies,
 * recording, team mode). Split from `bridge.ts` only so the loader doesn't
 * carry it: the panel chunk is its only user.
 */
import type { AnnotationShape, Category, FieldValue, ReportReceipt, ReportStatusView, Severity, SimilarIssue } from "../../../core/schema.ts";
import type { AttachmentSummary, DevDetails, OpenOptions, ReporterMode, StoredReport } from "../../../core/types.ts";
import { loadClient, peekClient } from "./bridge.ts";

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

export async function connectTeam(): Promise<ReporterMode | null> {
  const c = await loadClient();
  return (await c.connectTeam?.()) ?? null;
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
    return peekClient()?.myReports?.() ?? [];
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

export async function startRecording(options: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void }) {
  const c = await loadClient();
  if (!c.startRecording) throw new Error("recording unavailable");
  return await c.startRecording(options);
}

/** Team-mode developer details: the client's `devDetails()`, else what the page itself knows. */
export function devDetails(captureId: string | undefined): DevDetails {
  try {
    const d = peekClient()?.devDetails?.(captureId);
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

