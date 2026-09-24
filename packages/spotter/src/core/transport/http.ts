/**
 * The HTTP transport: the wire protocol in `schema.ts` over `fetch`.
 *
 * - Browser requests carry the public key in `x-spotter-key`; server requests
 *   carry `authorization: Bearer sk_…`.
 * - `/v1/events` goes out without custom headers (key in the body, body as
 *   `text/plain`) so it is a CORS "simple request" — no preflight — and can
 *   ride `sendBeacon` on page hide.
 * - Artifacts upload in resumable chunks: PUT `?offset=&total=`, the server
 *   answers with `upload-offset`; after a failure the client asks HEAD for
 *   the offset the server really has and continues from there.
 * - Retryable failures back off exponentially with jitter (see retry.ts).
 */
import type {
  AnalyticsBatch,
  FlagBatch,
  RemoteConfig,
  ReportReceipt,
  ReportStatusView,
  ReportSubmission,
  SimilarIssue,
} from "../schema.ts";
import type { Transport } from "../types.ts";
import { HttpError, parseRetryAfter, withRetry, type RetryOptions } from "./retry.ts";

export interface HttpTransportOptions {
  /** Ingest base URL, e.g. `/api/spotter` or `https://console.trusplex.com/hooks/spotter`. */
  endpoint: string;
  /** Public key (browser). */
  project?: string;
  /** Secret key (server). Takes precedence over `project` for auth. */
  secretKey?: string;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  /** Upload chunk size in bytes. Default 512 KB. */
  chunkSize?: number;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Extra headers on every non-beacon request (e.g. forwarded browser facts from a route handler). */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Override for tests / non-browser runtimes. */
  sendBeacon?: (url: string, data: Blob) => boolean;
}

export const DEFAULT_CHUNK_SIZE = 512 * 1024;

export interface UploadProgress {
  name: string;
  sent: number;
  total: number;
}

export interface HttpTransport extends Transport {
  readonly endpoint: string;
  /** Upload with progress reporting; `upload()` is this without a callback. */
  uploadWithProgress(
    receipt: ReportReceipt,
    name: string,
    data: Blob | Uint8Array,
    contentType: string,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<void>;
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

function withQuery(url: string, params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `${url}${url.includes("?") ? "&" : "?"}${q}` : url;
}

async function toError(res: Response): Promise<HttpError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body.error) message = body.error;
    code = body.code;
  } catch {
    /* not JSON */
  }
  return new HttpError(res.status, message, code, parseRetryAfter(res.headers.get("retry-after")));
}

function byteLength(data: Blob | Uint8Array): number {
  return data instanceof Uint8Array ? data.byteLength : data.size;
}

function slice(data: Blob | Uint8Array, start: number, end: number): Blob | Uint8Array {
  return data instanceof Uint8Array ? data.subarray(start, end) : data.slice(start, end);
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const base = options.endpoint.replace(/\/+$/, "");
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const chunkSize = Math.max(16 * 1024, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const timeoutMs = options.timeoutMs ?? 20_000;

  const authHeaders = (): Record<string, string> => {
    const extra = typeof options.headers === "function" ? options.headers() : (options.headers ?? {});
    if (options.secretKey) return { ...extra, authorization: `Bearer ${options.secretKey}` };
    if (options.project) return { ...extra, "x-spotter-key": options.project };
    return { ...extra };
  };

  const signal = (): AbortSignal | undefined => {
    const AS = globalThis.AbortSignal as (typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }) | undefined;
    return AS?.timeout ? AS.timeout(timeoutMs) : undefined;
  };

  async function send(
    method: string,
    path: string,
    init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; keepalive?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...authHeaders(), ...init.headers };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await doFetch(joinUrl(base, path), {
      method,
      headers,
      body,
      keepalive: init.keepalive,
      signal: init.keepalive ? undefined : signal(),
      credentials: "omit",
    });
    if (!res.ok) throw await toError(res);
    return res;
  }

  const retrying = <T>(fn: () => Promise<T>, extra?: Partial<RetryOptions>) =>
    withRetry(fn, { ...options.retry, ...extra });

  async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  async function currentOffset(url: string, token: string): Promise<number> {
    const res = await doFetch(url, { method: "HEAD", headers: { ...authHeaders(), "x-spotter-upload-token": token }, credentials: "omit" });
    if (res.status === 404) return 0;
    if (!res.ok) throw await toError(res);
    return Number(res.headers.get("upload-offset") ?? 0) || 0;
  }

  async function uploadWithProgress(
    receipt: ReportReceipt,
    name: string,
    data: Blob | Uint8Array,
    contentType: string,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<void> {
    const declared = receipt.uploads.find((u) => u.name === name)?.url;
    const url = joinUrl(base, declared ?? `/v1/reports/${encodeURIComponent(receipt.id)}/artifacts/${encodeURIComponent(name)}`);
    const total = byteLength(data);
    let offset = 0;
    let resync = false;
    do {
      await retrying(
        async () => {
          if (resync) {
            offset = await currentOffset(url, receipt.token);
            resync = false;
            if (offset >= total && total > 0) return;
          }
          const end = Math.min(total, offset + chunkSize);
          const res = await doFetch(withQuery(url, { offset, total }), {
            method: "PUT",
            headers: {
              ...authHeaders(),
              "content-type": "application/octet-stream",
              "x-spotter-upload-token": receipt.token,
              "x-spotter-content-type": contentType,
            },
            body: slice(data, offset, end) as BodyInit,
            signal: signal(),
            credentials: "omit",
          });
          if (res.status === 409) {
            // server has a different offset (a previous attempt landed): resync and go again
            resync = true;
            throw new HttpError(503, "upload offset mismatch");
          }
          if (!res.ok) throw await toError(res);
          const next = Number(res.headers.get("upload-offset"));
          offset = Number.isFinite(next) && next > 0 ? next : end;
          onProgress?.({ name, sent: offset, total });
        },
        { onRetry: () => void (resync = true) },
      );
    } while (offset < total);
  }

  return {
    endpoint: base,
    async config(): Promise<RemoteConfig | null> {
      try {
        return await json<RemoteConfig>(await send("GET", "/v1/config"));
      } catch {
        return null;
      }
    },
    async submit(report: ReportSubmission): Promise<ReportReceipt> {
      return retrying(async () => json<ReportReceipt>(await send("POST", "/v1/reports", { json: report })));
    },
    upload(receipt, name, data, contentType) {
      return uploadWithProgress(receipt, name, data, contentType);
    },
    uploadWithProgress,
    async complete(receipt) {
      await retrying(() =>
        send("POST", `/v1/reports/${encodeURIComponent(receipt.id)}/complete`, { json: { token: receipt.token } }),
      );
    },
    async status(id, token): Promise<ReportStatusView | null> {
      try {
        return await json<ReportStatusView>(await send("GET", withQuery(`/v1/reports/${encodeURIComponent(id)}/status`, { token })));
      } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }
    },
    async reply(id, token, body) {
      const res = await retrying(() => send("POST", `/v1/reports/${encodeURIComponent(id)}/replies`, { json: { token, body } }));
      return json<ReportStatusView>(res);
    },
    async similar(url, selector): Promise<SimilarIssue[]> {
      try {
        return await json<SimilarIssue[]>(await send("GET", withQuery("/v1/similar", { url, selector })));
      } catch {
        return [];
      }
    },
    async plusOne(id, token) {
      const res = await send("POST", `/v1/reports/${encodeURIComponent(id)}/plus-one`, { json: { token } });
      return (await json<{ count: number }>(res)).count ?? null;
    },
    async flags(batch: FlagBatch) {
      const body = JSON.stringify(batch);
      const res = await retrying(() =>
        send("POST", "/v1/flags", { body, headers: { "content-type": "application/json" }, keepalive: body.length < 60_000 }),
      );
      const out = await json<{ promoted?: ReportReceipt[] }>(res);
      return { promoted: out.promoted ?? [] };
    },
    async events(batch: AnalyticsBatch, opts) {
      // Simple request: no custom headers, text/plain, key in the body.
      const body = JSON.stringify({ ...batch, key: batch.key ?? options.project });
      const url = joinUrl(base, "/v1/events");
      if (opts?.beacon) {
        const beacon =
          options.sendBeacon ??
          (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
            ? (u: string, d: Blob) => navigator.sendBeacon(u, d)
            : undefined);
        try {
          if (beacon?.(url, new Blob([body], { type: "text/plain" }))) return;
        } catch {
          /* fall through to fetch */
        }
      }
      const headers: Record<string, string> = { "content-type": "text/plain" };
      if (options.secretKey) headers.authorization = `Bearer ${options.secretKey}`;
      const res = await doFetch(url, { method: "POST", body, headers, keepalive: body.length < 60_000, credentials: "omit" });
      if (!res.ok && res.status !== 202) throw await toError(res);
    },
    async replaySegment(sessionId, seq, data) {
      await retrying(() =>
        send("POST", withQuery(`/v1/sessions/${encodeURIComponent(sessionId)}/replay`, { seq }), {
          body: data as BodyInit,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    },
  };
}
