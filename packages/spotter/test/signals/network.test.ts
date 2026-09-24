// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractTraceparent,
  installNetwork,
  isSpotterUrl,
  noteNetworkActivity,
  onNetworkActivity,
  urlMatches,
  type NetworkSignal,
} from "../../src/core/capture/network.ts";
import { setUrl, testRuntime, type TestRuntime } from "./helpers.ts";

const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

class FakeXHR extends EventTarget {
  static last: FakeXHR | null = null;
  method = "";
  url = "";
  headers: [string, string][] = [];
  status = 0;
  statusText = "";
  responseType: XMLHttpRequestResponseType = "";
  responseText = "";
  response: unknown = null;
  respHeaders = "";
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
    FakeXHR.last = this;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }
  send(_body?: unknown) {}
  getAllResponseHeaders() {
    return this.respHeaders;
  }
  respond(status: number, text: string, headers: string) {
    this.status = status;
    this.statusText = status === 200 ? "OK" : "Error";
    this.responseText = text;
    this.respHeaders = headers;
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }
  fail(kind: "error" | "timeout" | "abort") {
    this.dispatchEvent(new Event(kind));
    this.dispatchEvent(new Event("loadend"));
  }
}

let rt: TestRuntime;
let sig: NetworkSignal | null = null;
let calls: FetchArgs[] = [];
let respond: (args: FetchArgs) => Promise<Response>;
const saved = { fetch: window.fetch, xhr: window.XMLHttpRequest, beacon: navigator.sendBeacon };

beforeEach(() => {
  setUrl("https://app.example.com/start");
  calls = [];
  respond = async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "content-length": "11" } });
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return respond([input, init]);
  }) as typeof fetch;
  window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true, writable: true });
  rt = testRuntime({ endpoint: "https://ingest.example.net/custom" });
});

afterEach(() => {
  sig?.destroy();
  sig = null;
  window.fetch = saved.fetch;
  window.XMLHttpRequest = saved.xhr;
  Object.defineProperty(navigator, "sendBeacon", { value: saved.beacon, configurable: true, writable: true });
});

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("helpers", () => {
  it("recognises Spotter's own traffic", () => {
    expect(isSpotterUrl("https://app.example.com/api/spotter/v1/reports")).toBe(true);
    expect(isSpotterUrl("https://console.trusplex.com/hooks/spotter/v1/events")).toBe(true);
    expect(isSpotterUrl("https://ingest.example.net/custom/v1/x", "https://ingest.example.net/custom")).toBe(true);
    expect(isSpotterUrl("https://app.example.com/api/orders")).toBe(false);
  });

  it("matches body allowlist patterns", () => {
    expect(urlMatches("https://app.example.com/api/orders?x=1", ["/api/*"])).toBe(true);
    expect(urlMatches("https://app.example.com/api/orders", ["https://app.example.com/api/*"])).toBe(true);
    expect(urlMatches("https://app.example.com/other", ["/api/*"])).toBe(false);
    expect(urlMatches("https://x.com/graphql", [/graphql$/])).toBe(true);
    expect(urlMatches("https://x.com/a", [])).toBe(false);
  });

  it("extracts traceparents", () => {
    expect(extractTraceparent(TP)).toBe(TP);
    expect(extractTraceparent(`traceparent;desc="${TP}"`)).toBe(TP);
    expect(extractTraceparent("nope")).toBeUndefined();
  });

  it("broadcasts network activity", () => {
    const fn = vi.fn();
    const off = onNetworkActivity(fn);
    noteNetworkActivity();
    off();
    noteNetworkActivity();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("fetch", () => {
  it("records a HAR entry with redacted URL and no headers/bodies by default", async () => {
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    const res = await window.fetch("/api/orders?token=abc&page=2", { method: "post", body: '{"card":"4242424242424242"}', headers: { authorization: "Bearer x" } });
    expect(await res.json()).toEqual({ ok: true }); // host still gets its body
    await flush();
    const har = sig.snapshot();
    expect(har.log.version).toBe("1.2");
    const [e] = har.log.entries;
    expect(e?.request.method).toBe("POST");
    expect(e?.request.url).toBe("https://app.example.com/api/orders?token=[redacted]&page=2");
    expect(e?.request.queryString).toEqual([
      { name: "token", value: "[redacted]" },
      { name: "page", value: "2" },
    ]);
    expect(e?.request.headers).toEqual([]);
    expect(e?.request.postData).toBeUndefined();
    expect(e?.request.bodySize).toBe(27);
    expect(e?.response.status).toBe(200);
    expect(e?.response.content).toEqual({ size: 11, mimeType: "application/json" });
    expect(e?._initiator).toBe("fetch");
    expect(typeof e?.time).toBe("number");
  });

  it("adds x-spotter-session to same-origin requests only", async () => {
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    await window.fetch("/api/a");
    await window.fetch("https://api.other.com/b", { headers: { "x-custom": "1" } });
    const sameInit = calls[0]?.[1];
    expect(new Headers(sameInit?.headers).get("x-spotter-session")).toBe("sess-123");
    const crossInit = calls[1]?.[1];
    expect(new Headers(crossInit?.headers).get("x-spotter-session")).toBeNull();
    expect(crossInit).toEqual({ headers: { "x-custom": "1" } }); // untouched object
  });

  it("captures allowlisted headers and bodies, redacted and capped; never auth headers", async () => {
    respond = async () =>
      new Response(JSON.stringify({ email: "a@b.co", big: "x".repeat(20_000) }), {
        status: 201,
        headers: { "content-type": "application/json", "set-cookie": "sid=1", "x-request-id": "r-1" },
      });
    sig = installNetwork(rt, { max: 10, bodies: ["/api/*"], headers: ["content-type", "x-request-id", "authorization", "set-cookie"] });
    await window.fetch("/api/users", { method: "POST", body: '{"password":"hunter2","email":"me@x.io"}', headers: { "content-type": "application/json", authorization: "Bearer abcdefghijk" } });
    await flush();
    const [e] = sig.snapshot().log.entries;
    expect(e?.request.headers.map((h) => h.name)).toEqual(["content-type"]);
    expect(e?.request.postData?.text).toBe('{"password":"[redacted:secret]","email":"[redacted:email]"}');
    expect(e?.response.headers).toEqual(expect.arrayContaining([{ name: "x-request-id", value: "r-1" }]));
    expect(e?.response.headers.find((h) => h.name === "set-cookie")).toBeUndefined();
    expect(e?.response.content.text?.length).toBeLessThan(8300);
    expect(e?.response.content.text).toContain("[redacted:email]");
    expect(e?.response.content.text).toContain("[truncated");
  });

  it("records failures and error statuses as breadcrumbs, rethrowing to the host", async () => {
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    respond = async () => new Response("no", { status: 502 });
    await window.fetch("/api/charge", { method: "POST" });
    respond = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(window.fetch("/api/down")).rejects.toThrow("Failed to fetch");
    await flush();
    const entries = sig.snapshot().log.entries;
    expect(entries.map((e) => e.response.status)).toEqual([502, 0]);
    expect(entries[1]?._error).toBe("Failed to fetch");
    const crumbs = rt.crumbs.filter((c) => c.category === "network");
    expect(crumbs.map((c) => c.message)).toEqual(["POST /api/charge 502", "GET /api/down failed (Failed to fetch)"]);
  });

  it("collects traceparents from requests and responses", async () => {
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    await window.fetch("/api/a", { headers: { traceparent: TP } });
    const other = "00-11111111111111111111111111111111-2222222222222222-01";
    respond = async () => new Response("", { status: 200, headers: { "server-timing": `traceparent;desc="${other}"` } });
    await window.fetch("/api/b");
    await flush();
    expect(sig.traceparents()).toEqual([TP, other]);
    expect(sig.snapshot().log.entries[0]?._traceparent).toBe(TP);
  });

  it("ignores Spotter's own requests entirely", async () => {
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    await window.fetch("/api/spotter/v1/reports", { method: "POST" });
    await window.fetch("https://ingest.example.net/custom/v1/events", { method: "POST" });
    await flush();
    expect(sig.snapshot().log.entries).toEqual([]);
    expect(calls[0]?.[1]).toEqual({ method: "POST" }); // no session header added
  });

  it("restores fetch on destroy", () => {
    const before = window.fetch;
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    expect(window.fetch).not.toBe(before);
    sig.destroy();
    sig = null;
    expect(window.fetch).toBe(before);
  });

  it("is bounded by count", async () => {
    sig = installNetwork(rt, { max: 2, bodies: [], headers: [] });
    for (let i = 0; i < 5; i++) await window.fetch(`/api/${i}`);
    await flush();
    expect(sig.snapshot().log.entries.map((e) => e.request.url)).toEqual(["https://app.example.com/api/3", "https://app.example.com/api/4"]);
  });
});

describe("XMLHttpRequest", () => {
  it("records XHR with session header on same origin and failure crumbs", () => {
    sig = installNetwork(rt, { max: 10, bodies: ["/api/*"], headers: [] });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXHR;
    xhr.open("GET", "/api/items?secret=s");
    xhr.send();
    expect(xhr.headers).toContainEqual(["x-spotter-session", "sess-123"]);
    xhr.respond(500, '{"error":"db"}', "content-type: application/json\r\ncontent-length: 14\r\n");
    const [e] = sig.snapshot().log.entries;
    expect(e?.request.url).toBe("https://app.example.com/api/items?secret=[redacted]");
    expect(e?.response.status).toBe(500);
    expect(e?.response.content.text).toBe('{"error":"db"}');
    expect(e?._initiator).toBe("xhr");
    expect(rt.crumbs.at(-1)?.message).toBe("GET /api/items?secret=[redacted] 500");

    const cross = new window.XMLHttpRequest() as unknown as FakeXHR;
    cross.open("GET", "https://api.other.com/x");
    cross.send();
    expect(cross.headers).toEqual([]);
    cross.fail("timeout");
    expect(sig.snapshot().log.entries[1]?._error).toBe("timeout");
  });

  it("unpatches the prototype on destroy", () => {
    const open = FakeXHR.prototype.open;
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    expect(FakeXHR.prototype.open).not.toBe(open);
    sig.destroy();
    sig = null;
    expect(FakeXHR.prototype.open).toBe(open);
  });
});

describe("sendBeacon", () => {
  it("records beacons but not Spotter's own", () => {
    sig = installNetwork(rt, { max: 10, bodies: [], headers: [] });
    expect(navigator.sendBeacon("/collect", "abc")).toBe(true);
    navigator.sendBeacon("/api/spotter/v1/events", "{}");
    const entries = sig.snapshot().log.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ _initiator: "beacon", request: { method: "POST", bodySize: 3 } });
  });
});
