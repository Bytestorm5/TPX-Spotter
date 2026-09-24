/**
 * Request/response helpers for the ingest handler: JSON errors in the
 * protocol's `{ error, code }` shape, CORS, client facts (IP, country) from
 * the usual proxy headers, and a fixed-window rate limiter.
 */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function error(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: message, code }, status, headers);
}

/** First hop of x-forwarded-for, else the CDN-specific headers. */
export function clientIp(request: Request): string | undefined {
  const h = request.headers;
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || h.get("cf-connecting-ip") || h.get("x-real-ip") || undefined;
}

export function clientCountry(request: Request): string | undefined {
  const h = request.headers;
  return h.get("x-vercel-ip-country") || h.get("cf-ipcountry") || h.get("cloudfront-viewer-country") || undefined;
}

/** The browser's facts, forwarded to the hosted ingest alongside the secret key. */
export function forwardedHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const ip = clientIp(request);
  const origin = request.headers.get("origin");
  const ua = request.headers.get("user-agent");
  const country = clientCountry(request);
  if (ip) out["x-spotter-forwarded-for"] = ip;
  if (origin) out["x-spotter-forwarded-origin"] = origin;
  if (ua) out["x-spotter-forwarded-ua"] = ua;
  if (country) out["x-spotter-forwarded-country"] = country;
  return out;
}

export const CORS_ALLOW_HEADERS =
  "content-type, x-spotter-key, x-spotter-upload-token, x-spotter-content-type, x-spotter-session, x-spotter-sdk, x-spotter-features, x-spotter-mask, x-spotter-team-token, x-spotter-guest-token, authorization, traceparent";
export const CORS_EXPOSE_HEADERS = "upload-offset, retry-after, x-spotter-request-id";

/**
 * CORS for the configured origins. Same-origin requests are always allowed;
 * with no `allowedOrigins`, cross-origin requests are refused (the handler is
 * meant to be first-party).
 */
export function corsHeaders(request: Request, allowed: string[] | undefined): { allowed: boolean; headers: Record<string, string> } {
  const origin = request.headers.get("origin");
  if (!origin) return { allowed: true, headers: {} };
  let self: string | undefined;
  try {
    self = new URL(request.url).origin;
  } catch {
    /* relative url in some test harnesses */
  }
  const ok = origin === self || !!allowed?.some((a) => a === "*" || a === origin || matchWildcard(a, origin));
  if (!ok) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      "access-control-allow-origin": origin,
      vary: "origin",
      "access-control-allow-methods": "GET, POST, PUT, HEAD, OPTIONS",
      "access-control-allow-headers": CORS_ALLOW_HEADERS,
      "access-control-expose-headers": CORS_EXPOSE_HEADERS,
      "access-control-max-age": "86400",
    },
  };
}

/** `https://*.acme.com` matches one subdomain level. */
function matchWildcard(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) return false;
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^./]+")}$`);
  return re.test(origin);
}

export interface RateLimiter {
  /** `ok: false` with the ms until the window resets. */
  hit(key: string, cost?: number): { ok: boolean; retryAfterMs: number; remaining: number };
}

/** In-memory fixed window per key. Per process: behind several instances use your platform's limiter too. */
export function fixedWindowLimiter(max: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return {
    hit(key, cost = 1) {
      const t = now();
      if (t - lastSweep > windowMs * 2) {
        for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
        lastSweep = t;
      }
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += cost;
      return { ok: w.count <= max, retryAfterMs: w.start + windowMs - t, remaining: Math.max(0, max - w.count) };
    },
  };
}

/** Read a body with a hard byte cap (checks content-length first, then the actual bytes). */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  return buf.byteLength > maxBytes ? null : buf;
}
