/**
 * Network capture for `fetch`, `XMLHttpRequest` and `navigator.sendBeacon`,
 * recorded as a HAR 1.2 log.
 *
 * By default only the shape of a request is kept: method, redacted URL,
 * status, timing, sizes, initiator. Headers and bodies are opt-in
 * (`privacy.networkHeaders`, `privacy.networkBodies` URL patterns) and pass
 * through redaction; `Authorization`, `Cookie`, `Set-Cookie` and
 * `Proxy-Authorization` are never captured.
 *
 * Same-origin fetch/XHR requests carry `x-spotter-session` so the server side
 * can link its errors to this browser session. Cross-origin requests are left
 * untouched: a custom header would force a CORS preflight on someone else's
 * API.
 *
 * Spotter's own ingest traffic is never recorded (or tagged).
 */
import type { Har, HarEntry } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer } from "../buffer.ts";
import { NEVER_CAPTURED_HEADERS } from "../redact.ts";
import { truncate, utf8Length } from "../serialize.ts";
import { absoluteUrl, hasDom, iso, patchMethod, shortUrl } from "./util.ts";

export const SESSION_HEADER = "x-spotter-session";
const MAX_BODY = 8 * 1024;
const MAX_BYTES = 512 * 1024;
const MAX_TRACEPARENTS = 10;
const SDK_VERSION = "0.1.0";

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

/** Glob (`*` any run, leading `/` = path match) or RegExp against the absolute URL. */
export function urlMatches(url: string, patterns: readonly (string | RegExp)[]): boolean {
  if (!patterns.length) return false;
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    /* not absolute */
  }
  for (const p of patterns) {
    try {
      if (p instanceof RegExp) {
        p.lastIndex = 0;
        if (p.test(url)) return true;
        continue;
      }
      const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`);
      if (re.test(p.startsWith("/") ? path : url) || (p.startsWith("/") && re.test(path.split("?")[0] ?? ""))) return true;
    } catch {
      /* bad pattern */
    }
  }
  return false;
}

const TRACEPARENT = /\b([0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})\b/;

/** A W3C traceparent from a `traceparent` header value or a `server-timing` entry (`traceparent;desc="00-…"`). */
export function extractTraceparent(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT.exec(value.toLowerCase());
  return m?.[1];
}

function isTextual(mime: string): boolean {
  return /^(text\/|application\/(?:json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|x-www-form-urlencoded|javascript|graphql))/i.test(mime) || mime === "";
}

/** Describe a request body without reading streams: text for strings/params, a summary otherwise. */
function describeBody(body: unknown): { text?: string; size: number; mime?: string } {
  if (body === undefined || body === null) return { size: 0 };
  try {
    if (typeof body === "string") return { text: body, size: utf8Length(body) };
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      const s = body.toString();
      return { text: s, size: s.length, mime: "application/x-www-form-urlencoded" };
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const keys: string[] = [];
      body.forEach((_v, k) => keys.push(k));
      return { text: `[FormData: ${keys.slice(0, 50).join(", ")}]`, size: -1, mime: "multipart/form-data" };
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) return { text: `[Blob ${body.size} bytes]`, size: body.size, mime: body.type };
    if (body instanceof ArrayBuffer) return { text: `[binary ${body.byteLength} bytes]`, size: body.byteLength };
    if (ArrayBuffer.isView(body)) return { text: `[binary ${body.byteLength} bytes]`, size: body.byteLength };
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return { text: "[stream]", size: -1 };
  } catch {
    /* fall through */
  }
  return { size: -1 };
}

function headerPairs(headers: unknown): [string, string][] {
  const out: [string, string][] = [];
  try {
    if (!headers) return out;
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      headers.forEach((v, k) => out.push([k, v]));
    } else if (Array.isArray(headers)) {
      for (const pair of headers) if (Array.isArray(pair) && pair.length >= 2) out.push([String(pair[0]), String(pair[1])]);
    } else if (typeof headers === "object") {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) out.push([k, String(v)]);
    }
  } catch {
    /* unreadable headers */
  }
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

function queryString(url: string): { name: string; value: string }[] {
  const q = url.indexOf("?");
  if (q === -1) return [];
  const h = url.indexOf("#", q);
  const query = url.slice(q + 1, h === -1 ? undefined : h);
  const out: { name: string; value: string }[] = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return s;
      }
    };
    out.push({ name: dec(eq === -1 ? pair : pair.slice(0, eq)), value: eq === -1 ? "" : dec(pair.slice(eq + 1)) });
    if (out.length >= 50) break;
  }
  return out;
}

/** Read at most `max` bytes of text from a (cloned) response, then cancel the rest. */
async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    return truncate(await res.text(), max);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (text.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (text.length >= max) truncated = true;
  } finally {
    try {
      void reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return truncated ? truncate(text, max) : text;
}

interface Pending {
  initiator: "fetch" | "xhr" | "beacon";
  method: string;
  url: string;
  start: number;
  startedAt: number;
  reqHeaders: [string, string][];
  reqBody?: { text?: string; size: number; mime?: string };
  traceparent?: string;
}

export type NetworkSignal = Signal<Har> & { traceparents(): string[] };

export function installNetwork(
  rt: Runtime,
  opts: { max: number; bodies: (string | RegExp)[]; headers: string[] },
): NetworkSignal {
  const buffer = new RingBuffer<HarEntry>(Math.max(0, opts.max), MAX_BYTES);
  const traces: string[] = [];
  const undo: (() => void)[] = [];
  let active = true;
  const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const fault = (error: unknown) => {
    if (!active) return;
    active = false;
    try {
      rt.fault("network", error);
    } catch {
      /* never throw into the host */
    }
  };

  const noteTrace = (tp: string | undefined) => {
    if (!tp) return;
    const i = traces.indexOf(tp);
    if (i !== -1) traces.splice(i, 1);
    traces.push(tp);
    if (traces.length > MAX_TRACEPARENTS) traces.shift();
  };

  const ignored = (url: string) => isSpotterUrl(url, rt.config.endpoint);

  // Allowlisted headers only; the never-captured set (Authorization, Cookie, …) is dropped whatever the allowlist says.
  const allowHeaders = new Set(opts.headers.map((h) => h.toLowerCase()));
  const redactHeadersFor = (pairs: [string, string][]) =>
    pairs
      .filter(([k]) => !NEVER_CAPTURED_HEADERS.has(k.toLowerCase()) && allowHeaders.has(k.toLowerCase()))
      .map(([name, value]) => ({ name, value: rt.redact(String(value), "network") }));

  const begin = (initiator: Pending["initiator"], method: string, rawUrl: string, reqHeaders: [string, string][], body: unknown): Pending => {
    const url = absoluteUrl(rawUrl);
    const p: Pending = {
      initiator,
      method: (method || "GET").toUpperCase(),
      url,
      start: perfNow(),
      startedAt: rt.now(),
      reqHeaders,
      reqBody: describeBody(body),
    };
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
      const duration = Math.max(0, Math.round(perfNow() - p.start));
      const url = rt.redactUrl(p.url);
      const withBodies = urlMatches(p.url, opts.bodies);
      const respTp =
        extractTraceparent(res.headers.find(([k]) => k === "traceparent")?.[1]) ??
        extractTraceparent(res.headers.find(([k]) => k === "server-timing")?.[1]);
      const traceparent = p.traceparent ?? respTp;
      noteTrace(traceparent);

      const entry: HarEntry = {
        startedDateTime: iso(p.startedAt),
        time: duration,
        request: {
          method: p.method,
          url,
          httpVersion: "HTTP/1.1",
          headers: redactHeadersFor(p.reqHeaders),
          queryString: queryString(url),
          cookies: [],
          headersSize: -1,
          bodySize: p.reqBody?.size ?? 0,
        },
        response: {
          status: res.status,
          statusText: res.statusText,
          httpVersion: "HTTP/1.1",
          headers: redactHeadersFor(res.headers),
          cookies: [],
          content: { size: res.size, mimeType: res.mime || "x-unknown" },
          redirectURL: "",
          headersSize: -1,
          bodySize: res.size,
        },
        cache: {},
        timings: { send: 0, wait: duration, receive: 0 },
        _initiator: p.initiator,
      };
      if (withBodies && p.reqBody?.text !== undefined) {
        entry.request.postData = {
          mimeType: p.reqBody.mime ?? p.reqHeaders.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "text/plain",
          text: rt.redact(truncate(p.reqBody.text, MAX_BODY), "network"),
        };
      }
      if (withBodies && res.text !== undefined) entry.response.content.text = rt.redact(truncate(res.text, MAX_BODY), "network");
      if (traceparent) entry._traceparent = traceparent;
      if (res.error) entry._error = res.error;
      buffer.push(entry);

      if (res.error || res.status >= 400) {
        rt.breadcrumb({
          at: iso(rt.now()),
          category: "network",
          level: res.error || res.status >= 500 ? "error" : "warning",
          message: `${p.method} ${shortUrl(url)} ${res.error ? `failed (${res.error})` : res.status}`,
          data: { method: p.method, url, status: res.status, duration },
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
                  const headers = headerPairs(response.headers).map(([k, v]) => [k.toLowerCase(), v] as [string, string]);
                  const mime = response.headers.get("content-type") ?? "";
                  const size = Number(response.headers.get("content-length") ?? -1);
                  const base = {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                    mime,
                    size: Number.isFinite(size) ? size : -1,
                  };
                  if (urlMatches(p.url, opts.bodies) && isTextual(mime) && response.type !== "opaque") {
                    let clone: Response | null = null;
                    try {
                      clone = response.clone();
                    } catch {
                      clone = null;
                    }
                    if (clone) {
                      readCapped(clone, MAX_BODY).then(
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
                    if (!error && urlMatches(p.url, opts.bodies) && isTextual(mime)) {
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
    snapshot: (): Har => ({
      log: { version: "1.2", creator: { name: "@trusplex/spotter", version: SDK_VERSION }, entries: buffer.toArray() },
    }),
    traceparents: () => traces.slice(),
    destroy() {
      active = false;
      for (const fn of undo.splice(0)) fn();
      buffer.clear();
      traces.length = 0;
    },
  };
}
