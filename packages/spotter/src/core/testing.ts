/**
 * `createTestTransport()`: an in-memory Transport that records everything
 * the SDK sends, for unit tests and Playwright.
 *
 * ```ts
 * const transport = createTestTransport();
 * spotter.init({ project: "pk_test_x", transport });
 * await spotter.report({ title: "Broken" });
 * expect(transport.reports[0].content.title).toBe("Broken");
 * ```
 *
 * `flags` and `events` are Transport methods, so the recorded flag
 * occurrences and analytics events live in `flagOccurrences` /
 * `analyticsEvents` (and, grouped, in `recorded.flags` / `recorded.events`).
 *
 * In Playwright, pass it in a test build and read it back through the
 * global handle: `window.__trusplexSpotter.config.transport.reports`.
 */
import type {
  AnalyticsEvent,
  FlagOccurrence,
  PublicStatus,
  RemoteConfig,
  ReportReceipt,
  ReportStatusView,
  ReportSubmission,
  SimilarIssue,
} from "./schema.ts";
import type { Transport } from "./types.ts";

export interface RecordedUpload {
  reportId: string;
  name: string;
  contentType: string;
  size: number;
  data: Uint8Array;
}

export interface TestTransport extends Transport {
  readonly reports: ReportSubmission[];
  readonly receipts: ReportReceipt[];
  readonly flagOccurrences: FlagOccurrence[];
  readonly analyticsEvents: AnalyticsEvent[];
  readonly uploads: RecordedUpload[];
  readonly recorded: { reports: ReportSubmission[]; flags: FlagOccurrence[]; events: AnalyticsEvent[]; uploads: RecordedUpload[] };
  /** Report ids whose `complete` was called. */
  readonly completed: string[];
  readonly replaySegments: { sessionId: string; seq: number; size: number }[];
  readonly replies: { id: string; body: string }[];
  /** Resolves with the first report (already sent or future) that matches. */
  waitForReport(match?: (r: ReportSubmission) => boolean, timeoutMs?: number): Promise<ReportSubmission>;
  waitForFlag(name?: string, timeoutMs?: number): Promise<FlagOccurrence>;
  waitForEvent(match?: string | ((e: AnalyticsEvent) => boolean), timeoutMs?: number): Promise<AnalyticsEvent>;
  /** Resolves once `complete` was called for the report (all artifacts uploaded). */
  waitForComplete(reportId?: string, timeoutMs?: number): Promise<string>;
  /** Make the next `n` calls of `method` fail with a network error (to exercise the offline queue). */
  failNext(method: keyof Transport, n?: number, error?: unknown): void;
  /** Change a report's public status (drives `status()` / `<SpotterStatus/>`). */
  setStatus(id: string, status: PublicStatus, message?: string): void;
  setRemoteConfig(config: RemoteConfig | null): void;
  setSimilar(issues: SimilarIssue[]): void;
  reset(): void;
}

async function bytes(data: Blob | Uint8Array): Promise<Uint8Array> {
  return data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
}

export function createTestTransport(options: { remoteConfig?: RemoteConfig | null; latencyMs?: number } = {}): TestTransport {
  const reports: ReportSubmission[] = [];
  const receipts: ReportReceipt[] = [];
  const flags: FlagOccurrence[] = [];
  const events: AnalyticsEvent[] = [];
  const uploads: RecordedUpload[] = [];
  const completed: string[] = [];
  const replaySegments: { sessionId: string; seq: number; size: number }[] = [];
  const replies: { id: string; body: string }[] = [];
  const statuses = new Map<string, ReportStatusView>();
  const byClientId = new Map<string, ReportReceipt>();
  const failures = new Map<string, { n: number; error: unknown }>();
  const waiters = new Set<() => void>();
  let remote = options.remoteConfig ?? null;
  let similar: SimilarIssue[] = [];
  let seq = 0;

  const notify = () => waiters.forEach((w) => w());
  const delay = () => (options.latencyMs ? new Promise((r) => setTimeout(r, options.latencyMs)) : Promise.resolve());
  const maybeFail = (method: string) => {
    const f = failures.get(method);
    if (f && f.n > 0) {
      f.n--;
      throw f.error;
    }
  };

  function waitFor<T>(find: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const found = find();
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = find();
        if (v !== undefined) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`createTestTransport: timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      waiters.add(check);
    });
  }

  const t: TestTransport = {
    reports,
    receipts,
    flagOccurrences: flags,
    analyticsEvents: events,
    recorded: { reports, flags, events, uploads },
    uploads,
    completed,
    replaySegments,
    replies,
    async config() {
      await delay();
      maybeFail("config");
      return remote;
    },
    async submit(report) {
      await delay();
      maybeFail("submit");
      const existing = byClientId.get(report.clientId);
      if (existing) return existing;
      seq++;
      const receipt: ReportReceipt = {
        id: `test_${seq}`,
        ref: `SPT-TEST-${seq}`,
        url: `https://console.test/spotter/reports/test_${seq}`,
        token: `tok_${seq}`,
        uploads: report.artifacts.map((a) => ({ name: a.name, url: `/v1/reports/test_${seq}/artifacts/${a.name}` })),
      };
      reports.push(report);
      receipts.push(receipt);
      byClientId.set(report.clientId, receipt);
      statuses.set(receipt.id, {
        id: receipt.id,
        ref: receipt.ref,
        title: report.content.title,
        status: "received",
        history: [{ status: "received", at: new Date().toISOString() }],
        messages: [],
        updatedAt: new Date().toISOString(),
      });
      notify();
      return receipt;
    },
    async upload(receipt, name, data, contentType) {
      await delay();
      maybeFail("upload");
      const b = await bytes(data);
      uploads.push({ reportId: receipt.id, name, contentType, size: b.byteLength, data: b });
      notify();
    },
    async complete(receipt) {
      await delay();
      maybeFail("complete");
      completed.push(receipt.id);
      notify();
    },
    async status(id, token) {
      await delay();
      maybeFail("status");
      const r = receipts.find((x) => x.id === id);
      if (!r || r.token !== token) return null;
      return statuses.get(id) ?? null;
    },
    async reply(id, token, body) {
      await delay();
      maybeFail("reply");
      const view = statuses.get(id);
      const r = receipts.find((x) => x.id === id);
      if (!view || !r || r.token !== token) return null;
      replies.push({ id, body });
      view.messages.push({ at: new Date().toISOString(), from: "reporter", body });
      return view;
    },
    async similar() {
      maybeFail("similar");
      return similar;
    },
    async plusOne(id) {
      maybeFail("plusOne");
      const s = similar.find((x) => x.id === id);
      if (!s) return null;
      s.count++;
      return s.count;
    },
    async flags(batch) {
      await delay();
      maybeFail("flags");
      flags.push(...batch.flags);
      notify();
      return { promoted: [] };
    },
    async events(batch) {
      maybeFail("events");
      events.push(...batch.events);
      notify();
    },
    async replaySegment(sessionId, s, data) {
      maybeFail("replaySegment");
      replaySegments.push({ sessionId, seq: s, size: data.byteLength });
      notify();
    },
    waitForReport(match = () => true, timeoutMs = 5000) {
      return waitFor(() => reports.find(match), "a report", timeoutMs);
    },
    waitForFlag(name, timeoutMs = 5000) {
      return waitFor(() => flags.find((f) => !name || f.name === name), `flag ${name ?? ""}`, timeoutMs);
    },
    waitForEvent(match, timeoutMs = 5000) {
      const pred =
        typeof match === "function" ? match : (e: AnalyticsEvent) => !match || e.name === match || e.type === match;
      return waitFor(() => events.find(pred), "an analytics event", timeoutMs);
    },
    waitForComplete(reportId, timeoutMs = 5000) {
      return waitFor(() => completed.find((id) => !reportId || id === reportId), "complete", timeoutMs);
    },
    failNext(method, n = 1, error = new TypeError("Failed to fetch")) {
      failures.set(method, { n, error });
    },
    setStatus(id, status, message) {
      const view = statuses.get(id);
      if (!view) return;
      const at = new Date().toISOString();
      view.status = status;
      view.history.push({ status, at, message });
      view.updatedAt = at;
      if (message) view.messages.push({ at, from: "team", body: message });
    },
    setRemoteConfig(c) {
      remote = c;
    },
    setSimilar(issues) {
      similar = issues;
    },
    reset() {
      for (const list of [reports, receipts, flags, events, uploads, completed, replaySegments, replies] as unknown[][])
        list.length = 0;
      statuses.clear();
      byClientId.clear();
      failures.clear();
      seq = 0;
    },
  };
  return t;
}
