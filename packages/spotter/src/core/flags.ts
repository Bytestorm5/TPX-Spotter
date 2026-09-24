/**
 * `spotter.flag()`: "something looked wrong", lighter than a report.
 *
 * Occurrences are deduplicated per fingerprint into one pending entry with a
 * count, rate-limited per fingerprint on the client (default 10 a minute, to
 * protect quotas), and sent in batches — every 2 s in the browser (keepalive,
 * so a page hide doesn't lose them), almost immediately on the server, or on
 * `flush()`. A failed batch goes to the offline queue.
 *
 * Only reachable behind `FEATURE_FLAGS`, so a build with `flags: false`
 * contains none of this.
 */
import type { ReplayController } from "./internal.ts";
import type { EnvironmentInfo, FlagBatch, FlagOccurrence, Json, ReleaseInfo, SdkInfo } from "./schema.ts";
import type { FlagOptions, Transport } from "./types.ts";
import type { OfflineQueue } from "./transport/queue.ts";
import { isRetryable } from "./transport/retry.ts";
import { shortId } from "./ids.ts";

export interface FlaggerDeps {
  transport: () => Transport;
  queue: OfflineQueue;
  sdk: () => SdkInfo;
  limitPerMinute: () => number;
  server: boolean;
  now?: () => number;
  replay: () => ReplayController | null;
  context: () => {
    page?: { url: string; routePattern?: string };
    release: ReleaseInfo;
    reporter?: { id?: string; email?: string };
    sessionId?: string;
    environment?: Pick<EnvironmentInfo, "browser" | "os" | "device">;
    test: boolean;
  };
  redactData: (data: Record<string, Json>) => Record<string, Json>;
  emit: (occurrence: FlagOccurrence) => void;
  onError: (error: unknown) => void;
}

export interface Flagger {
  /** `extra.at`: when flag() was called (it may be processed after the chunk loads). */
  flag(name: string, options?: FlagOptions, extra?: { sessionId?: string; url?: string; at?: number }): void;
  flush(beacon?: boolean): Promise<void>;
  destroy(): void;
}

export function createFlagger(deps: FlaggerDeps): Flagger {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, FlagOccurrence>();
  const recent = new Map<string, number[]>();
  const replayUploads = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const schedule = () => {
    if (timer || destroyed) return;
    timer = setTimeout(
      () => {
        timer = null;
        void flush();
      },
      deps.server ? 25 : 2000,
    );
    (timer as { unref?: () => void }).unref?.();
  };

  async function flush(beacon = false): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!beacon && replayUploads.size) await Promise.allSettled([...replayUploads]);
    if (!pending.size) return;
    const batch: FlagBatch = { flags: [...pending.values()], sdk: deps.sdk() };
    pending.clear();
    try {
      await deps.transport().flags(batch);
    } catch (error) {
      if (isRetryable(error)) await deps.queue.put({ kind: "flags", id: shortId("f_"), at: now(), attempts: 0, batch });
      else deps.onError(new Error(`Spotter: the ingest rejected a batch of ${batch.flags.length} flag(s)`, { cause: error }));
    }
  }

  return {
    flag(name, options = {}, extra = {}) {
      if (destroyed || !name) return;
      const fingerprint = options.fingerprint?.length ? options.fingerprint.map(String) : [name];
      const key = `${name}\u0000${fingerprint.join("\u0000")}`;
      const t = extra.at ?? now();
      const times = (recent.get(key) ?? []).filter((x) => t - x < 60_000);
      if (times.length >= deps.limitPerMinute()) {
        recent.set(key, times);
        return;
      }
      times.push(t);
      recent.set(key, times);

      const ctx = deps.context();
      let occ = pending.get(key);
      if (occ) {
        occ.count++;
        occ.at = new Date(t).toISOString();
        if (options.data) occ.data = deps.redactData(options.data);
        if (options.severity) occ.severity = options.severity;
      } else {
        occ = {
          name,
          severity: options.severity ?? "warning",
          fingerprint,
          at: new Date(t).toISOString(),
          count: 1,
          release: ctx.release,
          test: ctx.test,
        };
        if (options.data) occ.data = deps.redactData(options.data);
        const url = extra.url ?? ctx.page?.url;
        if (url) occ.page = { url, ...(ctx.page?.routePattern ? { routePattern: ctx.page.routePattern } : {}) };
        if (ctx.reporter && (ctx.reporter.id || ctx.reporter.email)) occ.reporter = ctx.reporter;
        const sid = extra.sessionId ?? ctx.sessionId;
        if (sid) occ.sessionId = sid;
        if (ctx.environment) occ.environment = ctx.environment;
        pending.set(key, occ);
      }
      const current = occ;
      const replay = options.captureReplay ? deps.replay() : null;
      if (replay) {
        const p = replay
          .uploadSegment(`flag:${name}`)
          .then((seq) => {
            if (seq !== null) current.replaySegment = seq;
          })
          .catch(() => {})
          .finally(() => replayUploads.delete(p));
        replayUploads.add(p);
      }
      deps.emit(current);
      schedule();
    },
    flush,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
