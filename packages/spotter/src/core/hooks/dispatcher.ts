/**
 * The Dispatcher (TPX) hook: forwards the full issue — payload, artifacts and
 * the agent-readable timeline — to Trusplex Console's hosted ingest, which
 * classifies, groups, diagnoses and resolves it and sends status back.
 *
 * Two ways it runs:
 *
 * - Inside `createIngestHandler` (the usual case, auto-added when a project
 *   and secret key are set): the handler forwards the submission to Console
 *   first, so Console's id / ref / url become the canonical receipt, tees
 *   each artifact chunk upstream as it arrives, and `send()` just completes
 *   the upstream report. See `DISPATCHER_INGEST`.
 * - Standalone (`runHooks(issue, [dispatcher()])`): `send()` submits the
 *   issue, streams each artifact from its signed URL, and completes.
 *
 * Status comes back through Console (reporter notifications, `GET status`),
 * so `onStatus` is not needed here.
 */
import { HOSTED_ENDPOINT, readEnv } from "../config.ts";
import type { Issue, ReportReceipt, ReportSubmission } from "../schema.ts";
import type { HookResult, SpotterHook } from "../types.ts";
import { createHttpTransport } from "../transport/http.ts";
import { assertServer, defineHook } from "./define.ts";

export interface DispatcherOptions {
  /** Hosted ingest; default `SPOTTER_ENDPOINT` or `https://console.trusplex.com/hooks/spotter`. */
  endpoint?: string;
  /** Default `SPOTTER_SECRET_KEY`. */
  secretKey?: string;
  fetch?: typeof fetch;
  when?: SpotterHook["when"];
  retry?: SpotterHook["retry"];
}

/** What the ingest handler uses to make Console the source of truth for ids. */
export interface DispatcherIngest {
  readonly endpoint: string;
  readonly configured: boolean;
  submit(submission: ReportSubmission, forwarded: Record<string, string>): Promise<ReportReceipt>;
  upload(receipt: ReportReceipt, name: string, data: Uint8Array, contentType: string): Promise<void>;
  /** Remember the upstream receipt for a local issue id (so `send()` only completes). */
  bind(issueId: string, receipt: ReportReceipt): void;
}

export const DISPATCHER_INGEST: unique symbol = Symbol.for("trusplex.spotter.dispatcher");

export type DispatcherHook = SpotterHook & { [DISPATCHER_INGEST]: DispatcherIngest };

export function isDispatcherHook(hook: SpotterHook): hook is DispatcherHook {
  return DISPATCHER_INGEST in hook;
}

/** A submission rebuilt from a finished issue (standalone mode). */
export function submissionFromIssue(issue: Issue): ReportSubmission {
  const { id, ref: _ref, status: _status, artifacts, ...rest } = issue;
  return {
    ...rest,
    clientId: id,
    artifacts: artifacts.map(({ url: _u, state: _s, ...a }) => a),
  };
}

export function dispatcher(options: DispatcherOptions = {}): DispatcherHook {
  const endpoint = (options.endpoint ?? readEnv("SPOTTER_ENDPOINT") ?? HOSTED_ENDPOINT).replace(/\/+$/, "");
  const secretKey = options.secretKey ?? readEnv("SPOTTER_SECRET_KEY");
  const bound = new Map<string, ReportReceipt>();
  const doFetch: typeof fetch = (i, init) => (options.fetch ?? globalThis.fetch)(i, init);

  const transport = (headers: Record<string, string> = {}) =>
    createHttpTransport({ endpoint, secretKey, fetch: options.fetch, headers, retry: { attempts: 3 } });

  const ingest: DispatcherIngest = {
    endpoint,
    configured: !!secretKey,
    submit(submission, forwarded) {
      assertServer("dispatcher()");
      return transport(forwarded).submit(submission);
    },
    upload(receipt, name, data, contentType) {
      return transport().upload(receipt, name, data, contentType);
    },
    bind(issueId, receipt) {
      bound.set(issueId, receipt);
    },
  };

  const hook = defineHook({
    name: "dispatcher",
    when: options.when,
    retry: options.retry,
    dedupe: "none" as const, // Dispatcher groups by fingerprint itself
    async send(issue: Issue): Promise<HookResult> {
      assertServer("dispatcher()");
      if (!secretKey) throw Object.assign(new Error("dispatcher(): no secret key (set SPOTTER_SECRET_KEY)"), { retryable: false });
      const t = transport();
      let receipt = bound.get(issue.id);
      if (!receipt) {
        receipt = await t.submit(submissionFromIssue(issue));
        for (const a of issue.artifacts) {
          if (!a.url || a.state !== "stored") continue;
          const res = await doFetch(a.url);
          if (!res.ok) throw new Error(`dispatcher(): could not read artifact ${a.name} (${res.status})`);
          await t.upload(receipt, a.name, new Uint8Array(await res.arrayBuffer()), a.contentType);
        }
      }
      await t.complete(receipt);
      bound.delete(issue.id);
      return { externalId: receipt.id, url: receipt.url ?? `${endpoint}/reports/${receipt.id}` };
    },
  });
  return Object.assign(hook, { [DISPATCHER_INGEST]: ingest });
}
