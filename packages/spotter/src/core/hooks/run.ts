/**
 * `runHooks()`: deliver one issue to every hook, applying `when`, `dedupe`
 * and `retry`, and record every delivery.
 *
 * Nothing is dropped silently: a delivery that exhausts its retries is
 * recorded as `failed` (with the issue, so it can be retried later) in the
 * delivery store, which the ingest handler exposes at `GET /v1/deliveries`.
 */
import { iso, shortId } from "../ids.ts";
import type { Issue, IssueLink, PublicStatus } from "../schema.ts";
import type { HookRetryPolicy, SpotterHook } from "../types.ts";
import { assertServer } from "./define.ts";

export interface Delivery {
  id: string;
  hook: string;
  kind: "send" | "status";
  issueId: string;
  ref: string;
  fingerprint: string;
  state: "delivered" | "failed" | "skipped";
  attempts: number;
  error?: string;
  link?: IssueLink;
  /** For status deliveries. */
  status?: PublicStatus;
  at: string;
}

export interface DeliveryStore {
  record(delivery: Delivery, issue?: Issue): Promise<void>;
  list(filter?: { state?: Delivery["state"]; issueId?: string; hook?: string }): Promise<Delivery[]>;
  /** The issue a failed delivery was for (kept so it can be retried). */
  issueFor(deliveryId: string): Promise<Issue | undefined>;
  /** The external ticket for this issue, or for an earlier issue with the same fingerprint. */
  link(hook: string, key: { issueId?: string; fingerprint?: string }): Promise<IssueLink | undefined>;
  saveLink(issue: Pick<Issue, "id" | "fingerprint">, link: IssueLink): Promise<void>;
  /** Issue ids linked to an external ticket (for status sync coming back, e.g. GitHub webhooks). */
  issuesFor(hook: string, externalId: string): Promise<string[]>;
}

export function memoryDeliveryStore(limit = 1000): DeliveryStore {
  const deliveries: Delivery[] = [];
  const issues = new Map<string, Issue>();
  const byIssue = new Map<string, IssueLink>();
  const byFingerprint = new Map<string, IssueLink>();
  const byExternal = new Map<string, Set<string>>();
  return {
    async record(d, issue) {
      deliveries.push(d);
      if (issue && d.state === "failed") issues.set(d.id, issue);
      while (deliveries.length > limit) {
        const old = deliveries.shift();
        if (old) issues.delete(old.id);
      }
    },
    async list(filter = {}) {
      return deliveries.filter(
        (d) =>
          (!filter.state || d.state === filter.state) &&
          (!filter.issueId || d.issueId === filter.issueId) &&
          (!filter.hook || d.hook === filter.hook),
      );
    },
    async issueFor(id) {
      return issues.get(id);
    },
    async link(hook, key) {
      return (key.issueId && byIssue.get(`${hook}|${key.issueId}`)) || (key.fingerprint && byFingerprint.get(`${hook}|${key.fingerprint}`)) || undefined;
    },
    async saveLink(issue, link) {
      byIssue.set(`${link.hook}|${issue.id}`, link);
      if (issue.fingerprint) byFingerprint.set(`${link.hook}|${issue.fingerprint}`, link);
      const k = `${link.hook}|${link.externalId}`;
      const set = byExternal.get(k) ?? new Set<string>();
      set.add(issue.id);
      byExternal.set(k, set);
    },
    async issuesFor(hook, externalId) {
      return [...(byExternal.get(`${hook}|${externalId}`) ?? [])];
    },
  };
}

export interface RunHooksOptions {
  store?: DeliveryStore;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each delivery is recorded (logging, metrics). */
  onDelivery?: (delivery: Delivery) => void;
}

export interface RunHooksResult {
  links: IssueLink[];
  deliveries: Delivery[];
}

const DEFAULT_RETRY: Required<HookRetryPolicy> = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 };

async function attempt<T>(
  fn: () => Promise<T>,
  policy: HookRetryPolicy | undefined,
  wait: (ms: number) => Promise<void>,
): Promise<{ value?: T; attempts: number; error?: unknown }> {
  const p = { ...DEFAULT_RETRY, ...policy };
  let lastError: unknown;
  for (let i = 0; i < Math.max(1, p.attempts); i++) {
    try {
      return { value: await fn(), attempts: i + 1 };
    } catch (error) {
      lastError = error;
      if ((error as { retryable?: boolean } | null)?.retryable === false) return { attempts: i + 1, error };
      if (i < p.attempts - 1) {
        const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** i);
        await wait(Math.round(exp / 2 + (Math.random() * exp) / 2));
      }
    }
  }
  return { attempts: Math.max(1, p.attempts), error: lastError };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deliver `issue` to each hook. Hooks run concurrently; one hook's failure never blocks another. */
export async function runHooks(issue: Issue, hooks: SpotterHook[], options: RunHooksOptions = {}): Promise<RunHooksResult> {
  assertServer("runHooks()");
  const store = options.store;
  const wait = options.sleep ?? defaultSleep;
  const names = new Set<string>();
  for (const h of hooks) {
    if (names.has(h.name)) throw new Error(`Spotter: two hooks are named "${h.name}"; hook names must be unique.`);
    names.add(h.name);
  }

  const results = await Promise.all(
    hooks.map(async (hook): Promise<Delivery> => {
      const base = { id: shortId("dlv_"), hook: hook.name, kind: "send" as const, issueId: issue.id, ref: issue.ref, fingerprint: issue.fingerprint, at: iso() };
      let wanted = true;
      try {
        wanted = hook.when ? hook.when(issue) : true;
      } catch (error) {
        const d: Delivery = { ...base, state: "failed", attempts: 0, error: `when() threw: ${message(error)}` };
        await store?.record(d, issue);
        return d;
      }
      if (!wanted) {
        const d: Delivery = { ...base, state: "skipped", attempts: 0 };
        await store?.record(d);
        return d;
      }
      const previous =
        hook.dedupe === "none" ? undefined : await store?.link(hook.name, { issueId: issue.id, fingerprint: issue.fingerprint });
      const r = await attempt(() => hook.send(issue, previous), hook.retry, wait);
      let d: Delivery;
      if (r.error !== undefined) d = { ...base, state: "failed", attempts: r.attempts, error: message(r.error) };
      else {
        const link = r.value ? { hook: hook.name, externalId: r.value.externalId, url: r.value.url } : undefined;
        if (link) await store?.saveLink(issue, link);
        d = { ...base, state: "delivered", attempts: r.attempts, link };
      }
      await store?.record(d, issue);
      return d;
    }),
  );
  for (const d of results) options.onDelivery?.(d);
  return { links: results.flatMap((d) => (d.link ? [d.link] : [])), deliveries: results };
}

/** Tell hooks that follow status (`onStatus`) about a change, with the link they stored. */
export async function runStatusHooks(
  issue: Issue,
  status: PublicStatus,
  hooks: SpotterHook[],
  options: RunHooksOptions & { skip?: string } = {},
): Promise<Delivery[]> {
  assertServer("runStatusHooks()");
  const wait = options.sleep ?? defaultSleep;
  const out = await Promise.all(
    hooks
      .filter((h) => h.onStatus && h.name !== options.skip)
      .map(async (hook): Promise<Delivery> => {
        const link = await options.store?.link(hook.name, { issueId: issue.id });
        const r = await attempt(() => hook.onStatus!(issue, status, link), hook.retry, wait);
        const d: Delivery = {
          id: shortId("dlv_"),
          hook: hook.name,
          kind: "status",
          issueId: issue.id,
          ref: issue.ref,
          fingerprint: issue.fingerprint,
          state: r.error !== undefined ? "failed" : "delivered",
          attempts: r.attempts,
          error: r.error !== undefined ? message(r.error) : undefined,
          status,
          link,
          at: iso(),
        };
        await options.store?.record(d, issue);
        options.onDelivery?.(d);
        return d;
      }),
  );
  return out;
}
