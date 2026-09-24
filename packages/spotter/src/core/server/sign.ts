/**
 * HMAC-SHA256 over Web Crypto (Node ≥ 19, edge runtimes, Deno, Bun), used
 * for signed artifact URLs and GitHub webhook verification. No `node:crypto`,
 * so the handler bundles for the edge.
 */

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function subtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("Spotter: Web Crypto (crypto.subtle) is required on the server (Node ≥ 19 or an edge runtime).");
  return s;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = subtle().importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, k);
  }
  return k;
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < b.length; i++) out += (b[i] as number).toString(16).padStart(2, "0");
  return out;
}

export async function hmacHex(secret: string, message: string | Uint8Array): Promise<string> {
  const data = typeof message === "string" ? enc.encode(message) : message;
  return toHex(await subtle().sign("HMAC", await hmacKey(secret), data as BufferSource));
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await subtle().digest("SHA-256", bytes as BufferSource));
}
