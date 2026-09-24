/**
 * Body capture for `privacy.networkBodies` (opt-in, off by default). Loaded by
 * `installNetwork()` only when that allowlist is non-empty, so the default
 * build's init path doesn't carry it; requests that complete before it has
 * loaded are recorded without bodies.
 */
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

export function isTextual(mime: string): boolean {
  return /^(text\/|application\/(?:json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|x-www-form-urlencoded|javascript|graphql))/i.test(mime) || mime === "";
}

/** Describe a request body without reading streams: text for strings/params, a summary otherwise. */
export function describeBody(body: unknown): { text?: string; mime?: string } {
  try {
    if (typeof body === "string") return { text: body };
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return { text: body.toString(), mime: "application/x-www-form-urlencoded" };
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const keys: string[] = [];
      body.forEach((_v, k) => keys.push(k));
      return { text: `[FormData: ${keys.slice(0, 50).join(", ")}]`, mime: "multipart/form-data" };
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) return { text: `[Blob ${body.size} bytes]`, mime: body.type };
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { text: `[binary ${body.byteLength} bytes]` };
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return { text: "[stream]" };
  } catch {
    /* fall through */
  }
  return {};
}

/** Read about `max` chars of text from a (cloned) response, then cancel the rest (the caller truncates). */
export async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") return res.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length <= max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      void reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return text;
}
