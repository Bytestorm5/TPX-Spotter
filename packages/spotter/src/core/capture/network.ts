/**
 * Network capture for `fetch`, `XMLHttpRequest` and `navigator.sendBeacon`.
 *
 * This is the part that loads at init: the patches and a bounded buffer of
 * raw request records (method, URL, status, timing, sizes, initiator,
 * traceparent). By default only that shape is kept. Headers and bodies are
 * opt-in (`privacy.networkHeaders`, `privacy.networkBodies` URL patterns);
 * `Authorization`, `Cookie`, `Set-Cookie` and `Proxy-Authorization` are never
 * captured — they are dropped here, before anything is held.
 *
 * Redaction happens at snapshot time: `harFrom()` (network-har.ts, in the
 * session chunk) strips sensitive query parameters, scrubs URLs, header
 * values and bodies, and builds the HAR 1.2 log. Nothing in this buffer ever
 * leaves the page without going through it.
 *
 * Same-origin fetch/XHR requests carry `x-spotter-session` so the server side
 * can link its errors to this browser session. Cross-origin requests are left
 * untouched: a custom header would force a CORS preflight on someone else's
 * API.
 *
 * Spotter's own ingest traffic is never recorded (or tagged).
 */
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer, truncate, utf8Length } from "../buffer.ts";
import type * as BodyCapture from "./network-body.ts";
import { absoluteUrl, hasDom, iso, patchMethod, shortUrl } from "./util.ts";

export const SESSION_HEADER = "x-spotter-session";
const MAX_BODY = 8 * 1024;
const MAX_BYTES = 512 * 1024;
const MAX_TRACEPARENTS = 10;

/** Headers that are never captured, whatever the allowlist says. */
export const NEVER_CAPTURED_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);

/** A request as captured, before redaction. `harFrom()` turns these into HAR entries. */
export interface RawRequest {
  initiator: "fetch" | "xhr" | "beacon";
  method: string;
  /** Absolute and unredacted: `harFrom()` redacts it (and any crumb built from it) before it is sent. */
  url: string;
  /** Start, ms since epoch. */
  at: number;
  time: number;
  status: number;
  statusText: string;
  /** Allowlisted headers only (never the ones above). */
  reqHeaders: [string, string][];
  resHeaders: [string, string][];
  reqSize: number;
  resSize: number;
  mime: string;
  /** Bodies of allowlisted URLs, capped at 8 KB. */
  reqBody?: { text: string; mime: string };
  resText?: string;
  traceparent?: string;
  error?: string;
}

// -- network-activity bus (the dead-click detector listens) ---------------------------------

const activityListeners = new Set<() => void>();

/** Subscribe to "a request just started" — used to tell a dead click from one that fetched. */
export function onNetworkActivity(fn: () => void): () => void {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

/** Signal network activity (called for every captured request; exported for tests and custom transports). */
export function noteNetworkActivity(): void {
  for (const fn of activityListeners) {
    try {
      fn();
    } catch {
      /* a listener's fault is its own */
    }
  }
}

// -- helpers ---------------------------------------------------------------------------------

/** Spotter's own traffic: the first-party route handler, Console's hosted ingest, and the configured endpoint. */
export function isSpotterUrl(url: string, endpoint?: string): boolean {
  if (url.includes("/api/spotter") || url.includes("/hooks/spotter")) return true;
  if (endpoint) {
    const abs = absoluteUrl(endpoint);
    if (abs && absoluteUrl(url).startsWith(abs)) return true;
  }
  return false;
}

export function isSameOrigin(url: string): boolean {
  try {
    if (typeof location === "undefined") return false;
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

const TRACEPARENT = /\b([0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})\b/;

/** A W3C traceparent from a `traceparent` header value or a `server-timing` entry (`traceparent;desc="00-…"`). */
export function extractTraceparent(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT.exec(value.toLowerCase());
  return m?.[1];
}

/** Header pairs of a `Headers` (names come back lower-cased). */
function headerPairs(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((v, k) => out.push([k, v]));
  return out;
}

function parseRawHeaders(raw: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const i = line.indexOf(":");
    if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  return out;
}

interface Pending {
  initiator: "fetch" | "xhr" | "beacon";
  method: string;
  url: string;
  start: number;
  startedAt: number;
  reqHeaders: [string, string][];
  reqSize: number;
  reqBody?: { text?: string; mime?: string };
  traceparent?: string;
}

/** Request body size without reading it (bodies themselves are only kept for allowlisted URLs). */
function bodySize(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return utf8Length(body);
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return String(body).length;
  const n = (body as Blob).size ?? (body as ArrayBuffer).byteLength;
  return typeof n === "number" ? n : -1;
}

export type NetworkSignal = Signal<RawRequest[]> & {
  traceparents(): string[];
  /** Settles once body capture (only loaded for a non-empty `privacy.networkBodies`) is ready. */
  ready: Promise<void>;
};

export function installNetwork(
  rt: Runtime,
  opts: { max: number; bodies: (string | RegExp)[]; headers: string[] },
): NetworkSignal {
  const buffer = new RingBuffer<RawRequest>(Math.max(0, opts.max), MAX_BYTES);
  const traces: string[] = [];
  const undo: (() => void)[] = [];
  let active = true;
  const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const fault = (error: unknown) => {
    if (!active) return;
    active = false;
    rt.fault("network", error); // the engine's fault() never throws
  };

  const noteTrace = (tp: string | undefined) => {
    if (!tp) return;
    const i = traces.indexOf(tp);
    if (i !== -1) traces.splice(i, 1);
    traces.push(tp);
    if (traces.length > MAX_TRACEPARENTS) traces.shift();
  };

  const ignored = (url: string) => isSpotterUrl(url, rt.config.endpoint);

  // Bodies are opt-in: their code loads only when the allowlist is set.
  let bodies: typeof BodyCapture | null = null;
  const ready = opts.bodies.length
    ? import("./network-body.ts").then(
        (m) => void (bodies = m),
        () => {},
      )
    : Promise.resolve();
  const wantsBody = (url: string) => !!bodies?.urlMatches(url, opts.bodies);

  // Allowlisted headers only; the never-captured set (Authorization, Cookie, …) is dropped whatever the allowlist says.
  const allowHeaders = new Set(opts.headers.map((h) => h.toLowerCase()));
  const keepHeaders = (pairs: [string, string][]) => pairs.filter(([k]) => !NEVER_CAPTURED_HEADERS.has(k.toLowerCase()) && allowHeaders.has(k.toLowerCase()));

  const begin = (initiator: Pending["initiator"], method: string, rawUrl: string, reqHeaders: [string, string][], body: unknown): Pending => {
    const url = absoluteUrl(rawUrl);
    const p: Pending = {
      initiator,
      method: (method || "GET").toUpperCase(),
      url,
      start: perfNow(),
      startedAt: rt.now(),
      reqHeaders,
      reqSize: bodySize(body),
    };
    if (wantsBody(url)) p.reqBody = bodies?.describeBody(body);
    const tp = reqHeaders.find(([k]) => k.toLowerCase() === "traceparent");
    if (tp) p.traceparent = extractTraceparent(tp[1]);
    noteNetworkActivity();
    return p;
  };

  const finish = (
    p: Pending,
    res: { status: number; statusText: string; headers: [string, string][]; mime: string; size: number; text?: string; error?: string },
  ) => {
    if (!active) return;
    try {
      const time = Math.max(0, Math.round(perfNow() - p.start));
      const respTp =
        extractTraceparent(res.headers.find(([k]) => k === "traceparent")?.[1]) ??
        extractTraceparent(res.headers.find(([k]) => k === "server-timing")?.[1]);
      const traceparent = p.traceparent ?? respTp;
      noteTrace(traceparent);
      const entry: RawRequest = {
        initiator: p.initiator,
        method: p.method,
        url: p.url,
        at: p.startedAt,
        time,
        status: res.status,
        statusText: res.statusText,
        reqHeaders: keepHeaders(p.reqHeaders),
        resHeaders: keepHeaders(res.headers),
        reqSize: p.reqSize,
        resSize: res.size,
        mime: res.mime,
      };
      if (p.reqBody?.text !== undefined) {
        entry.reqBody = {
          mime: p.reqBody.mime ?? p.reqHeaders.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "text/plain",
          text: truncate(p.reqBody.text, MAX_BODY),
        };
      }
      if (res.text !== undefined) entry.resText = truncate(res.text, MAX_BODY);
      if (traceparent) entry.traceparent = traceparent;
      if (res.error) entry.error = res.error;
      buffer.push(entry);

      if (res.error || res.status >= 400) {
        // Raw URL here: crumbs are redacted with everything else at snapshot time.
        rt.breadcrumb({
          at: iso(rt.now()),
          category: "network",
          level: res.error || res.status >= 500 ? "error" : "warning",
          message: `${p.method} ${shortUrl(p.url)} ${res.error ? `failed (${res.error})` : res.status}`,
          data: { method: p.method, url: p.url, status: res.status, duration: time },
        });
      }
    } catch (error) {
      fault(error);
    }
  };

  if (hasDom()) {
    const w = window as Window & typeof globalThis;

    // -- fetch --------------------------------------------------------------------------
    if (typeof w.fetch === "function") {
      undo.push(
        patchMethod(w, "fetch", (original) =>
          function spotterFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            let pending: Pending | null = null;
            let args: [RequestInfo | URL, RequestInit | undefined] = [input, init];
            if (active) {
              try {
                const isRequest = typeof Request !== "undefined" && input instanceof Request;
                const rawUrl = isRequest ? (input as Request).url : String(input instanceof URL ? input.href : input);
                if (!ignored(rawUrl)) {
                  const method = init?.method ?? (isRequest ? (input as Request).method : "GET");
                  const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
                  if (isSameOrigin(rawUrl) && rt.sessionId && !headers.has(SESSION_HEADER)) {
                    headers.set(SESSION_HEADER, rt.sessionId);
                    args = [input, { ...init, headers }];
                  }
                  pending = begin("fetch", method, rawUrl, headerPairs(headers), init?.body);
                }
              } catch (error) {
                fault(error);
                args = [input, init];
                pending = null;
              }
            }
            const promise = (original as typeof fetch).apply(this ?? w, args);
            if (!pending) return promise;
            const p = pending;
            promise.then(
              (response) => {
                try {
                  const headers = headerPairs(response.headers);
                  const mime = response.headers.get("content-type") ?? "";
                  const size = Number(response.headers.get("content-length") ?? -1);
                  const base = {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                    mime,
                    size: Number.isFinite(size) ? size : -1,
                  };
                  if (bodies && wantsBody(p.url) && bodies.isTextual(mime) && response.type !== "opaque") {
                    let clone: Response | null = null;
                    try {
                      clone = response.clone();
                    } catch {
                      clone = null;
                    }
                    if (clone) {
                      bodies.readCapped(clone, MAX_BODY).then(
                        (text) => finish(p, { ...base, text }),
                        () => finish(p, base),
                      );
                      return;
                    }
                  }
                  finish(p, base);
                } catch (error) {
                  fault(error);
                }
              },
              (error: unknown) => {
                const aborted = (error as { name?: string } | null)?.name === "AbortError";
                finish(p, {
                  status: 0,
                  statusText: "",
                  headers: [],
                  mime: "",
                  size: -1,
                  error: aborted ? "aborted" : truncate(String((error as Error | null)?.message ?? error), 200),
                });
              },
            );
            return promise;
          } as typeof fetch,
        ),
      );
    }

    // -- XMLHttpRequest -------------------------------------------------------------------
    const XHR = w.XMLHttpRequest;
    if (typeof XHR === "function" && XHR.prototype) {
      const state = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: [string, string][]; ignored: boolean }>();
      const proto = XHR.prototype;
      const originalSetHeader = proto.setRequestHeader;
      undo.push(
        patchMethod(proto, "open", (original) =>
          function spotterOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
            if (active) {
              try {
                const u = String(url instanceof URL ? url.href : url);
                state.set(this, { method, url: u, headers: [], ignored: ignored(u) });
              } catch (error) {
                fault(error);
              }
            }
            return (original as (...a: unknown[]) => void).call(this, method, url, ...rest);
          } as XMLHttpRequest["open"],
        ),
      );
      undo.push(
        patchMethod(proto, "setRequestHeader", (original) =>
          function spotterSetHeader(this: XMLHttpRequest, name: string, value: string) {
            const s = active ? state.get(this) : undefined;
            if (s && s.headers.length < 100) s.headers.push([String(name), String(value)]);
            return original.call(this, name, value);
          },
        ),
      );
      undo.push(
        patchMethod(proto, "send", (original) =>
          function spotterSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
            const s = active ? state.get(this) : undefined;
            if (s && !s.ignored) {
              try {
                if (isSameOrigin(s.url) && rt.sessionId && !s.headers.some(([k]) => k.toLowerCase() === SESSION_HEADER)) {
                  originalSetHeader.call(this, SESSION_HEADER, rt.sessionId);
                }
                const p = begin("xhr", s.method, s.url, s.headers, body);
                const xhr = this;
                let error: string | undefined;
                const onFail = (kind: string) => () => {
                  error = kind;
                };
                const onError = onFail("error");
                const onTimeout = onFail("timeout");
                const onAbort = onFail("aborted");
                const onEnd = () => {
                  xhr.removeEventListener("error", onError);
                  xhr.removeEventListener("timeout", onTimeout);
                  xhr.removeEventListener("abort", onAbort);
                  xhr.removeEventListener("loadend", onEnd);
                  try {
                    const headers = parseRawHeaders(xhr.getAllResponseHeaders() || "");
                    const mime = headers.find(([k]) => k === "content-type")?.[1] ?? "";
                    let text: string | undefined;
                    if (!error && wantsBody(p.url) && bodies?.isTextual(mime)) {
                      if (xhr.responseType === "" || xhr.responseType === "text") text = xhr.responseText;
                      else if (xhr.responseType === "json") text = JSON.stringify(xhr.response);
                    }
                    const len = Number(headers.find(([k]) => k === "content-length")?.[1] ?? -1);
                    finish(p, {
                      status: error ? 0 : xhr.status,
                      statusText: error ? "" : xhr.statusText,
                      headers,
                      mime,
                      size: Number.isFinite(len) ? len : -1,
                      text,
                      error,
                    });
                  } catch (e) {
                    fault(e);
                  }
                };
                this.addEventListener("error", onError);
                this.addEventListener("timeout", onTimeout);
                this.addEventListener("abort", onAbort);
                this.addEventListener("loadend", onEnd);
              } catch (error) {
                fault(error);
              }
            }
            return original.call(this, body);
          },
        ),
      );
    }

    // -- sendBeacon ------------------------------------------------------------------------
    const nav = w.navigator as Navigator | undefined;
    if (nav && typeof nav.sendBeacon === "function") {
      undo.push(
        patchMethod(nav, "sendBeacon", (original) =>
          function spotterBeacon(this: Navigator, url: string | URL, data?: BodyInit | null) {
            const queued = original.call(this ?? nav, url, data);
            if (active) {
              try {
                const u = String(url instanceof URL ? url.href : url);
                if (!ignored(u)) {
                  const p = begin("beacon", "POST", u, [], data);
                  finish(p, {
                    status: 0,
                    statusText: queued ? "beacon queued" : "beacon rejected",
                    headers: [],
                    mime: "",
                    size: -1,
                    error: queued ? undefined : "beacon rejected",
                  });
                }
              } catch (error) {
                fault(error);
              }
            }
            return queued;
          },
        ),
      );
    }
  }

  return {
    name: "network",
    snapshot: () => buffer.toArray(),
    traceparents: () => traces.slice(),
    ready,
    destroy() {
      active = false;
      for (const fn of undo.splice(0)) fn();
      buffer.clear();
      traces.length = 0;
    },
  };
}
