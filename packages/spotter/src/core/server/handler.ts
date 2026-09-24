/**
 * `createIngestHandler()`: the whole wire protocol (see `schema.ts`) as one
 * framework-agnostic `(request: Request) => Promise<Response>`, for
 * self-hosting and for proxying to Trusplex's hosted ingest from a
 * first-party route (`/api/spotter`), which keeps ad blockers out of the way.
 *
 * ```ts
 * // any Fetch-API server (Next route handler, Hono, Bun, Deno, Workers)
 * const handler = createIngestHandler({ hooks: [github({ repo, token })] });
 * export const { GET, POST, PUT, HEAD, OPTIONS } = handler.handlers;
 * ```
 *
 * Modes, decided per request:
 *
 * - **Proxy** (a secret key and an upstream — the hosted ingest by default
 *   when a project key is set): config, events, flags, similar, plus-one,
 *   replay segments, releases and the portal go straight upstream with
 *   `authorization: Bearer sk_…` and the `x-spotter-forwarded-*` facts.
 *   Reports are still received here, so self-run hooks (GitHub, custom) see
 *   them; the auto-added `dispatcher()` hook makes Console's id / ref / url
 *   the canonical receipt and tees artifacts upstream.
 * - **Self-hosted** (no upstream): everything is served locally from
 *   `storage`; hooks are the only delivery path.
 *
 * Reports: POST → receipt; PUT chunks into `storage` (resumable, HEAD for the
 * offset); POST complete (or no artifacts declared, or 15 min without a
 * complete) → the full `spotter.report.v1` with signed artifact URLs is
 * built, `on('issue')` / `onReport` fire and hooks run.
 *
 * Self-hosting extras (secret key required, `authorization: Bearer sk_…`):
 *   GET  /v1/admin/reports, GET /v1/admin/reports/:id
 *   POST /v1/admin/reports/:id/status  { status, message?, release? }
 *   GET  /v1/admin/deliveries?state=failed, POST /v1/admin/deliveries/:id/retry
 * and the signed artifact route GET /v1/artifacts/:id/:name?exp=&sig=, and
 * POST /v1/webhooks/github when `githubWebhookSecret` is set.
 */
import { HOSTED_ENDPOINT, readEnv } from "../config.ts";
import { flagFingerprint } from "../fingerprint.ts";
import { assertServer } from "../hooks/define.ts";
import { DISPATCHER_INGEST, dispatcher, isDispatcherHook } from "../hooks/dispatcher.ts";
import { githubWebhookHandler, type GitHubStatusUpdate } from "../hooks/github.ts";
import { memoryDeliveryStore, runHooks, runStatusHooks, type Delivery, type DeliveryStore } from "../hooks/run.ts";
import { iso, randomId, SDK_VERSION } from "../ids.ts";
import {
  type FlagBatch,
  type FlagOccurrence,
  type Issue,
  type PortalView,
  type PublicStatus,
  PUBLIC_STATUSES,
  type RemoteConfig,
  type ReportReceipt,
  type ReportSubmission,
  type SimilarIssue,
} from "../schema.ts";
import type { SpotterHook } from "../types.ts";
import { corsHeaders, clientIp, error, fixedWindowLimiter, forwardedHeaders, json, readBody, type RateLimiter } from "./http.ts";
import { buildIssue, statusView, submissionFromFlag, type ReportRecord } from "./report.ts";
import { hmacHex, timingSafeEqual } from "./sign.ts";
import { memoryStorage, type ArtifactStorage } from "./storage.ts";
import { artifactLimit, LIMITS, validateFlagBatch, validateSubmission } from "./validate.ts";

export interface IngestHandlerOptions {
  /** Hooks run on every issue. `dispatcher()` is added automatically in proxy mode. */
  hooks?: SpotterHook[];
  /** Default `SPOTTER_SECRET_KEY`. */
  secretKey?: string;
  /** Public project key; default `SPOTTER_PROJECT` / `NEXT_PUBLIC_SPOTTER_PROJECT`. */
  project?: string;
  /** Hosted ingest to proxy to. Default `SPOTTER_ENDPOINT`, else Console's when a project key is set. `false` = fully self-hosted. */
  upstream?: string | false;
  /** Set `false` to proxy without auto-adding the dispatcher hook. */
  dispatcher?: boolean;
  storage?: ArtifactStorage;
  deliveries?: DeliveryStore;
  /** Extra origins allowed cross-origin (same-origin always is). `https://*.acme.com` wildcards work. */
  allowedOrigins?: string[];
  /** The handler's public URL including its path (`https://acme.com/api/spotter`), for signed artifact URLs. Default: from the request. */
  publicBaseUrl?: string;
  /** Signed artifact URL lifetime, seconds. Default 3600. */
  artifactUrlTtl?: number;
  /** HMAC key for artifact URLs. Default the secret key, else a per-process random key (URLs die with the process). */
  signingKey?: string;
  onReport?: (issue: Issue) => void | Promise<void>;
  /** Self-hosted analytics sink. Without it events are accepted and discarded. */
  onEvents?: (batch: { events: unknown[] }, facts: Record<string, string>) => void | Promise<void>;
  /** Self-hosted remote config (`GET /v1/config`). */
  remoteConfig?: RemoteConfig | (() => RemoteConfig | Promise<RemoteConfig>);
  /** Self-hosted flag promotion; default: any `critical` flag, once per fingerprint. */
  promoteFlag?: (group: FlagGroup) => boolean;
  /** Requests per IP per minute; `false` disables. Default reports 20, everything else 600. */
  rateLimit?: { reports?: number; other?: number; windowMs?: number } | false;
  /** Default `TURNSTILE_SECRET_KEY`: anonymous submissions must carry a valid Turnstile token. */
  turnstileSecret?: string;
  turnstileSiteKey?: string;
  /** Default `GITHUB_WEBHOOK_SECRET`: serve GitHub's webhook at POST /v1/webhooks/github. */
  githubWebhookSecret?: string;
  /** Serverless: keep hooks running after the response (`ctx.waitUntil`, `after()` in Next). Default: await them. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Finalize reports whose client never called complete after this long. Default 15 min. */
  staleAfterMs?: number;
  fetch?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface FlagGroup {
  fingerprint: string;
  name: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  severity: FlagOccurrence["severity"];
  promoted?: string;
  latest: FlagOccurrence;
}

type Handler = (request: Request) => Promise<Response>;

export interface IngestEvents {
  issue: Issue;
  status: { issue: Issue; status: PublicStatus };
  reply: { id: string; body: string };
  flag: FlagGroup;
}

export interface IngestHandler extends Handler {
  /** Method handlers for frameworks that export them separately (Next route handlers). */
  readonly handlers: { GET: Handler; POST: Handler; PUT: Handler; HEAD: Handler; OPTIONS: Handler; PATCH: Handler; DELETE: Handler };
  on<E extends keyof IngestEvents>(event: E, fn: (payload: IngestEvents[E]) => void | Promise<void>): () => void;
  /** Change a report's public status: notifies hooks' `onStatus` and the reporter's status view. */
  setStatus(id: string, status: PublicStatus, details?: { message?: string; release?: string; actor?: string }): Promise<Issue | null>;
  /** Ask the reporter a question (status → needs_info). */
  ask(id: string, question: string): Promise<Issue | null>;
  getIssue(id: string): Promise<Issue | null>;
  deliveries(filter?: { state?: Delivery["state"]; issueId?: string }): Promise<Delivery[]>;
  retryDelivery(id: string): Promise<Delivery | null>;
  readonly storage: ArtifactStorage;
  readonly mode: "proxy" | "self-hosted";
}

interface Route {
  name: string;
  params: string[];
}

const ROUTES: [string, string, RegExp][] = [
  ["GET", "config", /^\/v1\/config$/],
  ["POST", "submit", /^\/v1\/reports$/],
  ["HEAD", "offset", /^\/v1\/reports\/([^/]+)\/artifacts\/([^/]+)$/],
  ["PUT", "chunk", /^\/v1\/reports\/([^/]+)\/artifacts\/([^/]+)$/],
  ["POST", "complete", /^\/v1\/reports\/([^/]+)\/complete$/],
  ["GET", "status", /^\/v1\/reports\/([^/]+)\/status$/],
  ["POST", "reply", /^\/v1\/reports\/([^/]+)\/replies$/],
  ["POST", "plusOne", /^\/v1\/reports\/([^/]+)\/plus-one$/],
  ["GET", "similar", /^\/v1\/similar$/],
  ["POST", "flags", /^\/v1\/flags$/],
  ["POST", "events", /^\/v1\/events$/],
  ["POST", "replay", /^\/v1\/sessions\/([^/]+)\/replay$/],
  ["POST", "release", /^\/v1\/releases$/],
  ["PUT", "sourcemap", /^\/v1\/releases\/([^/]+)\/sourcemaps$/],
  ["GET", "portal", /^\/v1\/portal$/],
  ["GET", "artifact", /^\/v1\/artifacts\/([^/]+)\/([^/]+)$/],
  ["POST", "githubWebhook", /^\/v1\/webhooks\/github$/],
  ["GET", "adminReports", /^\/v1\/admin\/reports$/],
  ["GET", "adminReport", /^\/v1\/admin\/reports\/([^/]+)$/],
  ["POST", "adminStatus", /^\/v1\/admin\/reports\/([^/]+)\/status$/],
  ["GET", "adminDeliveries", /^\/v1\/admin\/deliveries$/],
  ["POST", "adminRetry", /^\/v1\/admin\/deliveries\/([^/]+)\/retry$/],
];

/** Proxied verbatim in proxy mode. */
const PROXIED = new Set(["config", "similar", "flags", "events", "replay", "release", "sourcemap", "portal"]);

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

export function createIngestHandler(options: IngestHandlerOptions = {}): IngestHandler {
  const now = options.now ?? Date.now;
  const secretKey = options.secretKey ?? readEnv("SPOTTER_SECRET_KEY");
  const project = options.project ?? readEnv("SPOTTER_PROJECT") ?? readEnv("NEXT_PUBLIC_SPOTTER_PROJECT");
  const upstream =
    options.upstream === false
      ? undefined
      : (options.upstream ?? readEnv("SPOTTER_ENDPOINT") ?? (project ? HOSTED_ENDPOINT : undefined))?.replace(/\/+$/, "");
  const proxying = !!(upstream && secretKey);
  const hooks = [...(options.hooks ?? [])];
  if (proxying && options.dispatcher !== false && !hooks.some(isDispatcherHook))
    hooks.unshift(dispatcher({ endpoint: upstream, secretKey, fetch: options.fetch }));
  const dispatcherHook = hooks.find(isDispatcherHook);
  const ingest = dispatcherHook?.[DISPATCHER_INGEST];
  const storage = options.storage ?? memoryStorage();
  const deliveryStore = options.deliveries ?? memoryDeliveryStore();
  const signingKey = options.signingKey ?? secretKey ?? randomId(32);
  const ttl = options.artifactUrlTtl ?? 3600;
  const staleAfter = options.staleAfterMs ?? 15 * 60_000;
  const turnstileSecret = options.turnstileSecret ?? readEnv("TURNSTILE_SECRET_KEY");
  const turnstileSiteKey = options.turnstileSiteKey ?? readEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  const githubSecret = options.githubWebhookSecret ?? readEnv("GITHUB_WEBHOOK_SECRET");
  const doFetch: typeof fetch = (i, init) => (options.fetch ?? globalThis.fetch)(i, init);
  const limits = options.rateLimit === false ? undefined : options.rateLimit;
  const reportLimiter: RateLimiter | undefined =
    options.rateLimit === false ? undefined : fixedWindowLimiter(limits?.reports ?? 20, limits?.windowMs ?? 60_000, now);
  const otherLimiter: RateLimiter | undefined =
    options.rateLimit === false ? undefined : fixedWindowLimiter(limits?.other ?? 600, limits?.windowMs ?? 60_000, now);

  const records = new Map<string, ReportRecord>();
  const byClientId = new Map<string, string>();
  const flagGroups = new Map<string, FlagGroup>();
  const listeners = new Map<keyof IngestEvents, Set<(p: never) => void | Promise<void>>>();
  const finalizing = new Map<string, Promise<void>>();
  let lastSweep = now();

  if (project && !secretKey && options.upstream !== false)
    console.warn("[spotter] A project key is set but SPOTTER_SECRET_KEY is not: reports stay in this handler and are not forwarded to Trusplex.");

  async function emit<E extends keyof IngestEvents>(event: E, payload: IngestEvents[E]): Promise<void> {
    for (const fn of listeners.get(event) ?? []) {
      try {
        await (fn as (p: IngestEvents[E]) => void | Promise<void>)(payload);
      } catch (e) {
        console.error(`[spotter] ${event} listener failed`, e);
      }
    }
  }

  // -- records -----------------------------------------------------------------------

  const recordKey = (id: string) => `reports/${id}.json`;
  const artifactKey = (id: string, name: string) => `artifacts/${id}/${name}`;

  async function save(record: ReportRecord): Promise<void> {
    records.set(record.id, record);
    await storage.put(recordKey(record.id), new TextEncoder().encode(JSON.stringify(record)));
  }

  async function load(id: string): Promise<ReportRecord | null> {
    if (!SAFE_SEGMENT.test(id)) return null;
    const cached = records.get(id);
    if (cached) return cached;
    const raw = await storage.read(recordKey(id));
    if (!raw) return null;
    const record = JSON.parse(new TextDecoder().decode(raw)) as ReportRecord;
    records.set(id, record);
    return record;
  }

  async function nextRef(): Promise<string> {
    const raw = await storage.read("meta/ref-counter");
    const n = (raw ? Number(new TextDecoder().decode(raw)) : 1000) + 1;
    await storage.put("meta/ref-counter", new TextEncoder().encode(String(n)));
    return `SPT-${n}`;
  }

  async function signedUrl(base: string, id: string, name: string): Promise<string> {
    const exp = Math.floor(now() / 1000) + ttl;
    const sig = await hmacHex(signingKey, `${id}/${name}/${exp}`);
    return `${base}/v1/artifacts/${encodeURIComponent(id)}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
  }

  async function issueOf(record: ReportRecord, base = record.baseUrl): Promise<Issue> {
    return buildIssue(record, (a) => signedUrl(base, record.id, a.name));
  }

  function finalize(record: ReportRecord, base: string): Promise<void> {
    if (record.completed) return Promise.resolve();
    const pending = finalizing.get(record.id);
    if (pending) return pending;
    const run = (async () => {
      for (const a of record.artifacts) {
        const size = await storage.size(artifactKey(record.id, a.name));
        a.state = size === a.size ? "stored" : "failed";
      }
      // retry any artifact that didn't make it upstream while streaming
      if (ingest && record.upstream && record.upstreamPending?.length) {
        for (const name of [...record.upstreamPending]) {
          const a = record.artifacts.find((x) => x.name === name);
          const data = await storage.read(artifactKey(record.id, name));
          if (!a || !data) continue;
          try {
            await ingest.upload(record.upstream, name, data, a.contentType);
            record.upstreamPending = record.upstreamPending.filter((n) => n !== name);
          } catch {
            /* the report still completes upstream; the artifact stays local */
          }
        }
      }
      record.completed = true;
      record.completedAt = iso(now());
      await save(record);
      const issue = await issueOf(record, base);
      if (ingest && record.upstream) ingest.bind(record.id, record.upstream);
      await emit("issue", issue);
      try {
        await options.onReport?.(issue);
      } catch (e) {
        console.error("[spotter] onReport failed", e);
      }
      const delivery = runHooks(issue, hooks, { store: deliveryStore }).then(async (res) => {
        record.links = res.links;
        await save(record);
      });
      if (options.waitUntil) options.waitUntil(delivery.catch((e) => console.error("[spotter] hooks failed", e)));
      else await delivery;
    })().finally(() => finalizing.delete(record.id));
    finalizing.set(record.id, run);
    return run;
  }

  /** Reports whose tab closed before `complete`: finalize with what arrived. */
  async function sweep(): Promise<void> {
    if (now() - lastSweep < 60_000) return;
    lastSweep = now();
    for (const r of records.values())
      if (!r.completed && now() - Date.parse(r.receivedAt) > staleAfter) await finalize(r, r.baseUrl).catch(() => {});
  }

  async function setStatus(
    id: string,
    status: PublicStatus,
    details: { message?: string; release?: string; actor?: string; skipHook?: string } = {},
  ): Promise<Issue | null> {
    const record = await load(id);
    if (!record) return null;
    const at = iso(now());
    const same = record.status.public === status;
    record.status.public = status;
    record.status.history.push({ status, at, message: details.message, release: details.release, actor: details.actor });
    if (details.message) record.messages.push({ at, from: "team", body: details.message });
    await save(record);
    const issue = await issueOf(record);
    await emit("status", { issue, status });
    if (!same) {
      const run = runStatusHooks(issue, status, hooks, { store: deliveryStore, skip: details.skipHook });
      if (options.waitUntil) options.waitUntil(run.catch(() => {}));
      else await run;
    }
    return issue;
  }

  // -- request plumbing ---------------------------------------------------------------

  function trusted(request: Request): boolean {
    const auth = request.headers.get("authorization");
    return !!secretKey && !!auth && timingSafeEqual(auth, `Bearer ${secretKey}`);
  }

  function keyMismatch(request: Request, bodyKey?: string): boolean {
    const presented = request.headers.get("x-spotter-key") ?? bodyKey;
    if (!presented) return false;
    if (presented.startsWith("sk_")) return true;
    return !!project && presented !== project;
  }

  async function proxy(request: Request, path: string, search: string, body?: Uint8Array): Promise<Response> {
    const headers = new Headers();
    for (const h of [
      "content-type",
      "x-spotter-key",
      "x-spotter-upload-token",
      "x-spotter-content-type",
      "x-spotter-session",
      "x-spotter-sdk",
      "x-spotter-features",
      "x-spotter-mask",
      "x-spotter-team-token",
      "x-spotter-guest-token",
      "traceparent",
    ]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has("x-spotter-key") && project) headers.set("x-spotter-key", project);
    headers.set("authorization", `Bearer ${secretKey}`);
    for (const [k, v] of Object.entries(forwardedHeaders(request))) headers.set(k, v);
    const method = request.method.toUpperCase();
    const payload = method === "GET" || method === "HEAD" ? undefined : (body ?? new Uint8Array(await request.arrayBuffer()));
    let res: Response;
    try {
      res = await doFetch(`${upstream}${path}${search}`, { method, headers, body: payload as BodyInit | undefined });
    } catch {
      return error(502, "upstream_unreachable", "The Spotter ingest could not reach Trusplex.", { "retry-after": "5" });
    }
    const out: Record<string, string> = {};
    for (const h of ["content-type", "upload-offset", "retry-after", "cache-control"]) {
      const v = res.headers.get(h);
      if (v) out[h] = v;
    }
    return new Response(method === "HEAD" ? null : await res.arrayBuffer(), { status: res.status, headers: out });
  }

  function match(method: string, path: string): Route | null {
    for (const [m, name, re] of ROUTES) {
      if (m !== method) continue;
      const hit = re.exec(path);
      if (hit) return { name, params: hit.slice(1).map((p) => decodeURIComponent(p)) };
    }
    return null;
  }

  async function parseJson<T>(request: Request, max: number): Promise<{ value?: T; response?: Response }> {
    const body = await readBody(request, max);
    if (!body) return { response: error(413, "too_large", `Request body exceeds ${max} bytes.`) };
    try {
      return { value: JSON.parse(new TextDecoder().decode(body)) as T };
    } catch {
      return { response: error(400, "invalid_json", "Body is not valid JSON.") };
    }
  }

  async function verifyTurnstile(token: string | undefined, ip: string | undefined): Promise<boolean> {
    if (!turnstileSecret) return true;
    if (!token) return false;
    try {
      const form = new URLSearchParams({ secret: turnstileSecret, response: token });
      if (ip) form.set("remoteip", ip);
      const res = await doFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
      return ((await res.json()) as { success?: boolean }).success === true;
    } catch {
      return false;
    }
  }

  // -- endpoints ---------------------------------------------------------------------

  async function submit(request: Request, base: string): Promise<Response> {
    const { value, response } = await parseJson<unknown>(request, LIMITS.reportBytes);
    if (response) return response;
    const v = validateSubmission(value);
    if (!v.ok) return json({ error: "Invalid report.", code: "invalid_report", details: v.errors }, 422);
    const submission = v.value;

    const existingId = byClientId.get(submission.clientId);
    const existing = existingId ? await load(existingId) : null;
    if (existing) return json(receiptOf(existing), 200);

    if (!trusted(request) && submission.reporter.type === "public" && turnstileSecret) {
      if (!(await verifyTurnstile(submission.turnstileToken, clientIp(request))))
        return error(403, "turnstile_failed", "Turnstile verification failed.");
    }
    delete submission.turnstileToken;

    let upstreamReceipt: ReportReceipt | undefined;
    if (ingest?.configured && proxying) {
      try {
        upstreamReceipt = await ingest.submit(submission, forwardedHeaders(request));
      } catch (e) {
        // Trusplex unreachable: accept locally, the dispatcher hook submits later.
        console.warn("[spotter] could not reach the hosted ingest; accepting locally", (e as Error).message);
      }
    }

    const at = iso(now());
    const id = upstreamReceipt?.id && SAFE_SEGMENT.test(upstreamReceipt.id) ? upstreamReceipt.id : `rep_${randomId(10)}`;
    const record: ReportRecord = {
      id,
      ref: upstreamReceipt?.ref ?? (await nextRef()),
      token: upstreamReceipt?.token ?? randomId(24),
      clientId: submission.clientId,
      receivedAt: at,
      submission,
      artifacts: submission.artifacts.map((a) => ({ ...a, state: "pending" as const })),
      completed: false,
      status: { public: "received", history: [{ status: "received", at }] },
      messages: [],
      plusOnes: 0,
      upstream: upstreamReceipt,
      upstreamPending: upstreamReceipt ? submission.artifacts.map((a) => a.name) : undefined,
      links: [],
      baseUrl: base,
      url: upstreamReceipt?.url,
    };
    byClientId.set(submission.clientId, id);
    await save(record);
    if (!record.artifacts.length) await finalize(record, base);
    return json(receiptOf(record), 201);
  }

  function receiptOf(record: ReportRecord): ReportReceipt {
    return {
      id: record.id,
      ref: record.ref,
      ...(record.url ? { url: record.url } : {}),
      ...(record.upstream?.statusUrl ? { statusUrl: record.upstream.statusUrl } : {}),
      token: record.token,
      uploads: record.artifacts.map((a) => ({
        name: a.name,
        url: `/v1/reports/${encodeURIComponent(record.id)}/artifacts/${encodeURIComponent(a.name)}`,
      })),
    };
  }

  async function uploadTarget(request: Request, id: string, name: string) {
    const record = await load(id);
    if (!record) return { response: error(404, "not_found", "Unknown report.") };
    const token = request.headers.get("x-spotter-upload-token") ?? "";
    if (!timingSafeEqual(token, record.token)) return { response: error(403, "bad_token", "Invalid upload token.") };
    const artifact = record.artifacts.find((a) => a.name === name);
    if (!artifact) return { response: error(404, "unknown_artifact", "Artifact was not declared in the report.") };
    return { record, artifact };
  }

  async function chunk(request: Request, id: string, name: string, url: URL): Promise<Response> {
    const t = await uploadTarget(request, id, name);
    if (t.response) return t.response;
    const { record, artifact } = t;
    if (record.completed) return error(409, "completed", "Report already completed.");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const total = Number(url.searchParams.get("total") ?? artifact.size);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(total) || total < 0)
      return error(400, "bad_offset", "offset and total must be non-negative integers.");
    if (total > artifactLimit(artifact.kind)) return error(413, "too_large", `Artifact exceeds ${artifactLimit(artifact.kind)} bytes.`);
    if (total !== artifact.size) return error(400, "size_mismatch", `total ${total} ≠ declared size ${artifact.size}.`);
    const body = await readBody(request, Math.min(8 * 1024 * 1024, total - offset + 1));
    if (!body) return error(413, "too_large", "Chunk too large.");
    const key = artifactKey(id, name);
    const current = (await storage.size(key)) ?? 0;
    if (offset !== current) return error(409, "offset_mismatch", "Offset does not match.", { "upload-offset": String(current) });
    if (offset + body.byteLength > total) return error(400, "overflow", "Chunk runs past total.");
    const size = await storage.append(key, offset, body);
    artifact.state = size >= total ? "stored" : "uploading";
    if (artifact.state === "stored" && ingest && record.upstream) {
      const data = await storage.read(key);
      try {
        if (data) await ingest.upload(record.upstream, name, data, artifact.contentType);
        record.upstreamPending = (record.upstreamPending ?? []).filter((n) => n !== name);
      } catch {
        /* retried at finalize */
      }
    }
    await save(record);
    return new Response(null, { status: 204, headers: { "upload-offset": String(size) } });
  }

  async function offsetOf(request: Request, id: string, name: string): Promise<Response> {
    const t = await uploadTarget(request, id, name);
    if (t.response) return new Response(null, { status: t.response.status });
    const size = (await storage.size(artifactKey(id, name))) ?? 0;
    return new Response(null, { status: 200, headers: { "upload-offset": String(size), "cache-control": "no-store" } });
  }

  async function complete(request: Request, id: string, base: string): Promise<Response> {
    const record = await load(id);
    if (!record) return error(404, "not_found", "Unknown report.");
    const { value, response } = await parseJson<{ token?: string }>(request, 16 * 1024);
    if (response) return response;
    const token = value?.token ?? request.headers.get("x-spotter-upload-token") ?? "";
    if (!timingSafeEqual(token, record.token) && !trusted(request)) return error(403, "bad_token", "Invalid token.");
    await finalize(record, base);
    return json({ ok: true });
  }

  async function status(id: string, url: URL, request: Request): Promise<Response> {
    const record = await load(id);
    if (!record) return error(404, "not_found", "Unknown report.");
    const token = url.searchParams.get("token") ?? "";
    if (!timingSafeEqual(token, record.token) && !trusted(request)) return error(403, "bad_token", "Invalid token.");
    return json(statusView(record));
  }

  async function reply(request: Request, id: string): Promise<Response> {
    const record = await load(id);
    if (!record) return error(404, "not_found", "Unknown report.");
    const { value, response } = await parseJson<{ token?: string; body?: string }>(request, 64 * 1024);
    if (response) return response;
    if (!timingSafeEqual(value?.token ?? "", record.token)) return error(403, "bad_token", "Invalid token.");
    const body = (value?.body ?? "").trim();
    if (!body || body.length > 20_000) return error(422, "invalid_reply", "Reply must be 1–20000 characters.");
    record.messages.push({ at: iso(now()), from: "reporter", body });
    await save(record);
    await emit("reply", { id, body });
    return json(statusView(record));
  }

  async function plusOne(request: Request, id: string): Promise<Response> {
    const record = await load(id);
    if (!record) return error(404, "not_found", "Unknown report.");
    record.plusOnes++;
    await save(record);
    return json({ count: record.plusOnes + 1 });
  }

  async function similar(url: URL): Promise<Response> {
    const target = url.searchParams.get("url");
    const selector = url.searchParams.get("selector");
    if (!target) return json([]);
    let path: string;
    try {
      path = new URL(target, "http://_").pathname;
    } catch {
      return json([]);
    }
    const out: SimilarIssue[] = [];
    for (const key of await storage.list("reports/")) {
      const r = await load(key.slice("reports/".length, -".json".length));
      if (!r || r.status.public === "resolved" || r.status.public === "wont_fix") continue;
      let rp: string;
      try {
        rp = new URL(r.submission.page.url, "http://_").pathname;
      } catch {
        continue;
      }
      const samePage = rp === path || (!!r.submission.page.routePattern && r.submission.page.routePattern === url.searchParams.get("route"));
      if (!samePage || (selector && r.submission.page.selector && r.submission.page.selector !== selector)) continue;
      out.push({ id: r.id, ref: r.ref, title: r.submission.content.title, status: r.status.public, count: r.plusOnes + 1 });
      if (out.length >= 5) break;
    }
    return json(out);
  }

  async function flags(request: Request): Promise<Response> {
    const { value, response } = await parseJson<FlagBatch>(request, 256 * 1024);
    if (response) return response;
    const v = validateFlagBatch(value);
    if (!v.ok) return json({ error: "Invalid flags.", code: "invalid_flags", details: v.errors }, 422);
    const promoted: ReportReceipt[] = [];
    const base = baseFor(request);
    for (const f of v.value.flags) {
      const fp = flagFingerprint(f.fingerprint.length ? f.fingerprint : [f.name]);
      const g: FlagGroup = flagGroups.get(fp) ?? { fingerprint: fp, name: f.name, count: 0, firstSeen: f.at, lastSeen: f.at, severity: f.severity, latest: f };
      g.count += Math.max(1, f.count);
      g.lastSeen = f.at;
      g.latest = f;
      if (["info", "warning", "error", "critical"].indexOf(f.severity) > ["info", "warning", "error", "critical"].indexOf(g.severity)) g.severity = f.severity;
      flagGroups.set(fp, g);
      await emit("flag", g);
      const promote = options.promoteFlag ?? ((x: FlagGroup) => x.severity === "critical");
      if (!g.promoted && promote(g)) {
        const sub = submissionFromFlag(f, g.count, v.value.sdk);
        const at = iso(now());
        const record: ReportRecord = {
          id: `rep_${randomId(10)}`,
          ref: await nextRef(),
          token: randomId(24),
          clientId: sub.clientId,
          receivedAt: at,
          submission: sub,
          artifacts: [],
          completed: false,
          status: { public: "received", history: [{ status: "received", at }] },
          messages: [],
          plusOnes: 0,
          links: [],
          baseUrl: base,
        };
        g.promoted = record.id;
        await save(record);
        await finalize(record, base);
        promoted.push(receiptOf(record));
      }
    }
    return json({ accepted: v.value.flags.length, promoted });
  }

  async function events(request: Request): Promise<Response> {
    const { value, response } = await parseJson<{ key?: string; events?: unknown[] }>(request, 256 * 1024);
    if (response) return response;
    if (keyMismatch(request, value?.key)) return error(401, "invalid_key", "Invalid project key.");
    if (!Array.isArray(value?.events) || value.events.length > 500) return error(422, "invalid_events", "events must be an array of ≤ 500.");
    if (options.onEvents) await options.onEvents({ events: value.events }, forwardedHeaders(request));
    return new Response(null, { status: 202 });
  }

  async function replay(request: Request, sessionId: string, url: URL): Promise<Response> {
    const seq = Number(url.searchParams.get("seq"));
    if (!SAFE_SEGMENT.test(sessionId) || !Number.isInteger(seq) || seq < 0) return error(400, "bad_segment", "Invalid session or seq.");
    const body = await readBody(request, LIMITS.replayBytes);
    if (!body) return error(413, "too_large", "Replay segment too large.");
    await storage.put(`sessions/${sessionId}/replay/${seq}.bin`, body);
    return json({ ok: true }, 201);
  }

  async function portal(url: URL): Promise<Response> {
    const token = url.searchParams.get("token") ?? "";
    let owner: ReportRecord | undefined;
    const all: ReportRecord[] = [];
    for (const key of await storage.list("reports/")) {
      const r = await load(key.slice("reports/".length, -".json".length));
      if (!r) continue;
      all.push(r);
      if (timingSafeEqual(r.token, token)) owner = r;
    }
    if (!owner) return error(404, "not_found", "Unknown portal token.");
    const who = owner.submission.reporter;
    const mine = all.filter(
      (r) =>
        r === owner ||
        (who.id && r.submission.reporter.id === who.id) ||
        (who.email && r.submission.reporter.email?.toLowerCase() === who.email.toLowerCase()),
    );
    const view: PortalView = {
      reporter: { name: who.name, email: who.email, type: who.type },
      reports: mine.map((r) => ({ ...statusView(r), createdAt: r.submission.createdAt })),
    };
    return json(view);
  }

  async function serveArtifact(id: string, name: string, url: URL): Promise<Response> {
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!Number.isFinite(exp) || exp * 1000 < now()) return error(403, "expired", "Link expired.");
    if (!timingSafeEqual(await hmacHex(signingKey, `${id}/${name}/${exp}`), sig)) return error(403, "bad_signature", "Invalid signature.");
    const record = await load(id);
    const artifact = record?.artifacts.find((a) => a.name === name);
    const data = artifact ? await storage.read(artifactKey(id, name)) : null;
    if (!artifact || !data) return error(404, "not_found", "Artifact not found.");
    return new Response(data as BodyInit, {
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(data.byteLength),
        "cache-control": "private, max-age=300",
        "content-disposition": `inline; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  async function admin(route: Route, request: Request, url: URL): Promise<Response> {
    if (!secretKey) return error(403, "no_secret", "Admin endpoints need SPOTTER_SECRET_KEY on the handler.");
    if (!trusted(request)) return error(401, "unauthorized", "Bearer secret key required.");
    switch (route.name) {
      case "adminReports": {
        const keys = (await storage.list("reports/")).slice(-200);
        const out = [];
        for (const k of keys) {
          const r = await load(k.slice("reports/".length, -".json".length));
          if (r) out.push({ id: r.id, ref: r.ref, title: r.submission.content.title, status: r.status.public, createdAt: r.submission.createdAt, completed: r.completed });
        }
        return json(out.reverse());
      }
      case "adminReport": {
        const r = await load(route.params[0]!);
        return r ? json(await issueOf(r, baseFor(request))) : error(404, "not_found", "Unknown report.");
      }
      case "adminStatus": {
        const { value, response } = await parseJson<{ status?: PublicStatus; message?: string; release?: string; actor?: string }>(request, 64 * 1024);
        if (response) return response;
        if (!value?.status || !PUBLIC_STATUSES.includes(value.status)) return error(422, "invalid_status", `status must be one of ${PUBLIC_STATUSES.join(", ")}`);
        const issue = await setStatus(route.params[0]!, value.status, value);
        return issue ? json(issue) : error(404, "not_found", "Unknown report.");
      }
      case "adminDeliveries":
        return json(await deliveryStore.list({ state: (url.searchParams.get("state") as Delivery["state"]) ?? undefined }));
      case "adminRetry": {
        const d = await retryDelivery(route.params[0]!);
        return d ? json(d) : error(404, "not_found", "Unknown or non-retryable delivery.");
      }
    }
    return error(404, "not_found", "Not found.");
  }

  async function retryDelivery(id: string): Promise<Delivery | null> {
    const d = (await deliveryStore.list()).find((x) => x.id === id);
    const issue = d ? await deliveryStore.issueFor(id) : undefined;
    const hook = d ? hooks.find((h) => h.name === d.hook) : undefined;
    if (!d || !issue || !hook || d.state !== "failed") return null;
    if (d.kind === "status" && d.status) return (await runStatusHooks(issue, d.status, [hook], { store: deliveryStore }))[0] ?? null;
    return (await runHooks(issue, [hook], { store: deliveryStore })).deliveries[0] ?? null;
  }

  const github = githubSecret
    ? githubWebhookHandler({
        secret: githubSecret,
        onStatus: async (u: GitHubStatusUpdate) => {
          const ids = u.issueId ? [u.issueId] : await deliveryStore.issuesFor("github", u.externalId);
          for (const id of ids) await setStatus(id, u.status, { message: u.message, release: u.release, actor: "github", skipHook: "github" });
        },
      })
    : undefined;

  function baseFor(request: Request, path?: string): string {
    if (options.publicBaseUrl) return options.publicBaseUrl.replace(/\/+$/, "");
    const url = new URL(request.url);
    const p = path ?? url.pathname;
    const i = p.indexOf("/v1/");
    return `${url.origin}${i >= 0 ? p.slice(0, i) : p.replace(/\/+$/, "")}`;
  }

  // -- the handler ----------------------------------------------------------------------

  async function handle(request: Request): Promise<Response> {
    assertServer("createIngestHandler()");
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const cors = corsHeaders(request, options.allowedOrigins);
    const withCors = (res: Response): Response => {
      for (const [k, v] of Object.entries(cors.headers)) res.headers.set(k, v);
      return res;
    };

    if (method === "OPTIONS") return cors.allowed ? withCors(new Response(null, { status: 204 })) : error(403, "origin_not_allowed", "Origin not allowed.");
    if (!cors.allowed) return error(403, "origin_not_allowed", "Origin not allowed.");

    const i = url.pathname.indexOf("/v1/");
    const path = i >= 0 ? url.pathname.slice(i) : "";
    const base = baseFor(request, url.pathname);
    if (!path) return withCors(json({ ok: true, name: "@trusplex/spotter ingest", version: SDK_VERSION, mode: proxying ? "proxy" : "self-hosted" }));

    const route = match(method === "HEAD" && !path.includes("/artifacts/") ? "GET" : method, path);
    if (!route) return withCors(error(404, "not_found", `No route for ${method} ${path}.`));

    try {
      void sweep();
      if (route.name === "githubWebhook") return github ? await github(request) : error(404, "not_found", "GitHub webhook not configured.");
      if (route.name.startsWith("admin")) return withCors(await admin(route, request, url));
      if (route.name === "artifact") return await serveArtifact(route.params[0]!, route.params[1]!, url);

      const isTrusted = trusted(request);
      if (!isTrusted && route.name !== "events" && keyMismatch(request)) return withCors(error(401, "invalid_key", "Invalid project key."));
      const limiter = route.name === "submit" ? reportLimiter : otherLimiter;
      if (limiter && !isTrusted) {
        const hit = limiter.hit(`${clientIp(request) ?? "local"}|${route.name === "submit" ? "r" : "o"}`);
        if (!hit.ok)
          return withCors(error(429, "rate_limited", "Too many requests.", { "retry-after": String(Math.ceil(hit.retryAfterMs / 1000)) }));
      }

      if ((route.name === "release" || route.name === "sourcemap") && !isTrusted)
        return withCors(error(401, "unauthorized", "Releases need the secret key."));

      if (proxying && PROXIED.has(route.name)) {
        const res = await proxy(request, path, url.search);
        if (route.name === "config" && !res.ok) return withCors(json(await localConfig()));
        return withCors(res);
      }

      const id = route.params[0] ?? "";
      if (proxying && ["status", "reply", "plusOne"].includes(route.name)) {
        const r = await load(id);
        if (!r || r.upstream) return withCors(await proxy(request, path, url.search));
      }

      switch (route.name) {
        case "config":
          return withCors(json(await localConfig()));
        case "submit":
          return withCors(await submit(request, base));
        case "offset":
          return withCors(await offsetOf(request, id, route.params[1]!));
        case "chunk":
          return withCors(await chunk(request, id, route.params[1]!, url));
        case "complete":
          return withCors(await complete(request, id, base));
        case "status":
          return withCors(await status(id, url, request));
        case "reply":
          return withCors(await reply(request, id));
        case "plusOne":
          return withCors(await plusOne(request, id));
        case "similar":
          return withCors(await similar(url));
        case "flags":
          return withCors(await flags(request));
        case "events":
          return withCors(await events(request));
        case "replay":
          return withCors(await replay(request, id, url));
        case "portal":
          return withCors(await portal(url));
        case "release": {
          const { value, response } = await parseJson<{ version?: string }>(request, 256 * 1024);
          if (response) return withCors(response);
          if (!value?.version || !SAFE_SEGMENT.test(value.version)) return withCors(error(422, "invalid_release", "version is required ([A-Za-z0-9._-])."));
          await storage.put(`releases/${value.version}/release.json`, new TextEncoder().encode(JSON.stringify(value)));
          return withCors(json({ release: value.version }, 201));
        }
        case "sourcemap": {
          const file = (url.searchParams.get("file") ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
          if (!SAFE_SEGMENT.test(id) || !file) return withCors(error(400, "bad_file", "Invalid release or file."));
          const body = await readBody(request, 50 * 1024 * 1024);
          if (!body) return withCors(error(413, "too_large", "Source map too large."));
          await storage.put(`releases/${id}/maps/${file}`, body);
          return withCors(json({ ok: true }, 201));
        }
      }
      return withCors(error(404, "not_found", "Not found."));
    } catch (e) {
      console.error("[spotter] ingest error", e);
      return withCors(error(500, "internal", "Internal error."));
    }
  }

  async function localConfig(): Promise<RemoteConfig> {
    const rc = typeof options.remoteConfig === "function" ? await options.remoteConfig() : options.remoteConfig;
    const base: RemoteConfig = rc ?? { version: 0 };
    return turnstileSecret && turnstileSiteKey ? { ...base, requireTurnstile: true, turnstileSiteKey } : base;
  }

  const handler = handle as IngestHandler;
  Object.assign(handler, {
    handlers: { GET: handle, POST: handle, PUT: handle, HEAD: handle, OPTIONS: handle, PATCH: handle, DELETE: handle },
    on<E extends keyof IngestEvents>(event: E, fn: (payload: IngestEvents[E]) => void | Promise<void>) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn as (p: never) => void);
      listeners.set(event, set);
      return () => set.delete(fn as (p: never) => void);
    },
    setStatus: (id: string, s: PublicStatus, d?: { message?: string; release?: string; actor?: string }) => setStatus(id, s, d),
    ask: (id: string, question: string) => setStatus(id, "needs_info", { message: question }),
    async getIssue(id: string) {
      const r = await load(id);
      return r ? issueOf(r) : null;
    },
    deliveries: (filter?: { state?: Delivery["state"]; issueId?: string }) => deliveryStore.list(filter),
    retryDelivery,
    storage,
    mode: proxying ? "proxy" : "self-hosted",
  });
  return handler;
}
