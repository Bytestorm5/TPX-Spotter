/**
 * Turning a stored submission into the `spotter.report.v1` ticket.
 */
import { deriveFingerprint, flagFingerprint } from "../fingerprint.ts";
import { SDK_NAME } from "../ids.ts";
import {
  REPORT_SCHEMA_ID,
  type ArtifactRef,
  type FlagOccurrence,
  type Har,
  type IssueLink,
  type ReportReceipt,
  type ReportSignals,
  type ReportStatus,
  type ReportStatusView,
  type ReportSubmission,
  type SdkInfo,
  type SpotterReportV1,
} from "../schema.ts";
import { buildTimeline } from "../timeline.ts";

export interface ReportRecord {
  id: string;
  ref: string;
  token: string;
  clientId: string;
  receivedAt: string;
  submission: ReportSubmission;
  artifacts: ArtifactRef[];
  completed: boolean;
  completedAt?: string;
  status: ReportStatus;
  messages: ReportStatusView["messages"];
  plusOnes: number;
  /** Console's receipt when the dispatcher made Console the source of truth. */
  upstream?: ReportReceipt;
  /** Artifacts not yet copied upstream. */
  upstreamPending?: string[];
  links: IssueLink[];
  /** Public base URL of the handler, for signing artifact URLs later. */
  baseUrl: string;
  url?: string;
}

export function emptyHar(): Har {
  return { log: { version: "1.2", creator: { name: SDK_NAME, version: "0" }, entries: [] } };
}

export function emptySignals(): ReportSignals {
  return { console: [], errors: [], network: emptyHar(), breadcrumbs: [], navigation: [] };
}

export async function buildIssue(
  record: ReportRecord,
  artifactUrl: (artifact: ArtifactRef) => Promise<string | undefined>,
): Promise<SpotterReportV1> {
  const s = record.submission;
  const artifacts: ArtifactRef[] = [];
  for (const a of record.artifacts) {
    const url = a.state === "stored" ? await artifactUrl(a) : undefined;
    artifacts.push(url ? { ...a, url } : { ...a });
  }
  const fingerprint =
    s.fingerprint ??
    deriveFingerprint({
      source: s.source,
      error: s.signals.errors[s.signals.errors.length - 1],
      page: { url: s.page.url, routePattern: s.page.routePattern, selector: s.page.selector },
      category: s.content.category,
    });
  return {
    schema: REPORT_SCHEMA_ID,
    id: record.id,
    ref: record.ref,
    createdAt: s.createdAt,
    source: s.source,
    test: s.test,
    fingerprint,
    reporter: s.reporter,
    content: s.content,
    page: s.page,
    environment: s.environment,
    release: s.release,
    context: s.context,
    signals: s.signals,
    artifacts,
    trace: s.trace,
    timeline: s.timeline.length ? s.timeline : buildTimeline(s.signals, Date.parse(s.createdAt) || Date.now()),
    status: record.status,
    sdk: s.sdk,
    ...(s.flag ? { flag: s.flag } : {}),
  };
}

export function statusView(record: ReportRecord): ReportStatusView {
  const last = record.status.history[record.status.history.length - 1];
  return {
    id: record.id,
    ref: record.ref,
    title: record.submission.content.title,
    status: record.status.public,
    history: record.status.history.map(({ actor: _actor, ...h }) => h),
    messages: record.messages,
    updatedAt: last?.at ?? record.receivedAt,
  };
}

/** A promoted flag becomes a report with source `flag`. */
export function submissionFromFlag(f: FlagOccurrence, occurrences: number, sdk: SdkInfo): ReportSubmission {
  const fp = flagFingerprint(f.fingerprint.length ? f.fingerprint : [f.name]);
  return {
    schema: REPORT_SCHEMA_ID,
    clientId: `flag_${fp}_${Date.parse(f.at) || Date.now()}`,
    createdAt: f.at,
    source: "flag",
    test: !!f.test,
    fingerprint: fp,
    reporter: {
      ...(f.reporter?.id ? { id: f.reporter.id } : {}),
      ...(f.reporter?.email ? { email: f.reporter.email } : {}),
      traits: {},
      type: "public",
      contact: f.reporter?.email ? "email" : "none",
    },
    content: {
      title: `Flag: ${f.name}`,
      description: f.data ? `Flag data: ${JSON.stringify(f.data).slice(0, 4000)}` : "",
      category: "bug",
      severity: f.severity,
      fields: {},
      annotations: [],
    },
    page: { url: f.page?.url ?? "", ...(f.page?.routePattern ? { routePattern: f.page.routePattern } : {}), history: [] },
    environment: {
      runtime: "browser",
      device: f.environment?.device ?? "unknown",
      ...(f.environment?.browser ? { browser: f.environment.browser } : {}),
      ...(f.environment?.os ? { os: f.environment.os } : {}),
    },
    release: f.release ?? {},
    context: { tags: {}, contexts: f.data ? { flag: f.data } : {}, flags: {} },
    signals: emptySignals(),
    artifacts: [],
    trace: { traceparents: [], ...(f.sessionId ? { sessionId: f.sessionId } : {}), serverEvents: [] },
    timeline: [],
    sdk,
    flag: { name: f.name, occurrences },
  };
}
