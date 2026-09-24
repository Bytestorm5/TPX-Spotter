/**
 * Report-time half of network capture (session chunk): turns the raw request
 * records `installNetwork()` holds into a redacted HAR 1.2 log. URLs lose
 * their sensitive query parameters and are scrubbed, allowlisted header
 * values and captured bodies pass through redaction — before anything is
 * sent, since this runs when a report or capture is snapshotted.
 */
import type { Har, HarEntry } from "../schema.ts";
import type { Redactor } from "../redact.ts";
import { SDK_NAME, SDK_VERSION } from "../ids.ts";
import type { RawRequest } from "./network.ts";
import { iso } from "./util.ts";

function queryString(url: string): { name: string; value: string }[] {
  const q = url.indexOf("?");
  if (q === -1) return [];
  const h = url.indexOf("#", q);
  const query = url.slice(q + 1, h === -1 ? undefined : h);
  const out: { name: string; value: string }[] = [];
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    out.push({ name: dec(eq === -1 ? pair : pair.slice(0, eq)), value: eq === -1 ? "" : dec(pair.slice(eq + 1)) });
    if (out.length >= 50) break;
  }
  return out;
}

export function emptyHar(entries: HarEntry[] = []): Har {
  return { log: { version: "1.2", creator: { name: SDK_NAME, version: SDK_VERSION }, entries } };
}

/** Redact raw request records into a HAR 1.2 log. */
export function harFrom(raw: readonly RawRequest[], r: Redactor): Har {
  const headers = (pairs: [string, string][]) => pairs.map(([name, value]) => ({ name, value: r.redact(String(value), "network") }));
  return emptyHar(
    raw.map((p) => {
      const url = r.redactUrl(p.url);
      const entry: HarEntry = {
        startedDateTime: iso(p.at),
        time: p.time,
        request: {
          method: p.method,
          url,
          httpVersion: "HTTP/1.1",
          headers: headers(p.reqHeaders),
          queryString: queryString(url),
          cookies: [],
          headersSize: -1,
          bodySize: p.reqSize,
        },
        response: {
          status: p.status,
          statusText: p.statusText,
          httpVersion: "HTTP/1.1",
          headers: headers(p.resHeaders),
          cookies: [],
          content: { size: p.resSize, mimeType: p.mime || "x-unknown" },
          redirectURL: "",
          headersSize: -1,
          bodySize: p.resSize,
        },
        cache: {},
        timings: { send: 0, wait: p.time, receive: 0 },
        _initiator: p.initiator,
      };
      if (p.reqBody) entry.request.postData = { mimeType: p.reqBody.mime, text: r.redact(p.reqBody.text, "network") };
      if (p.resText !== undefined) entry.response.content.text = r.redact(p.resText, "network");
      if (p.traceparent) entry._traceparent = p.traceparent;
      if (p.error) entry._error = p.error;
      return entry;
    }),
  );
}
