/**
 * Identifiers: random ids, the tab-scoped session id, provisional refs.
 *
 * Nothing here runs at import time; every function tolerates a missing
 * `crypto`, `sessionStorage` or a storage that throws (Safari private mode,
 * sandboxed iframes, blocked cookies).
 */

/** Kept in sync with package.json (a test asserts it). */
export const SDK_VERSION = "0.1.0";
export const SDK_NAME = "@trusplex/spotter" as const;

const SESSION_KEY = "spotter:sid";

/** `bytes` random bytes as lowercase hex. Uses Web Crypto when present (browsers, Node ≥ 19, edge). */
export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(buf);
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += (buf[i] as number).toString(16).padStart(2, "0");
  return out;
}

/** Short, URL-safe, sortable-ish id: base36 time + random. */
export function shortId(prefix = ""): string {
  return prefix + Date.now().toString(36) + randomId(6);
}

/**
 * The tab-scoped session id. `sessionStorage` survives reloads but not new
 * tabs, which is exactly the scope a report's "what led up to this" needs;
 * it is never a cross-session identifier, so it stays cookieless-safe.
 */
export function tabSessionId(): string {
  try {
    const store = globalThis.sessionStorage;
    const existing = store?.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = randomId(12);
    store?.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return randomId(12);
  }
}

/** Provisional reference shown when the report is queued offline. */
export function pendingRef(clientId: string): string {
  return `SPT-PENDING-${clientId.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase()}`;
}

export function isPendingId(id: string): boolean {
  return id.startsWith("pending_");
}

export function iso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}
