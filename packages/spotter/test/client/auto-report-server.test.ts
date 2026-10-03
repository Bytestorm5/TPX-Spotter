import { describe, expect, it } from "vitest";
import { createSpotter } from "../../src/core/client.ts";
import { createTestTransport } from "../../src/core/testing.ts";
import { decide, eventKey, normalizeAutoReport, statusMatches, urlMatches } from "../../src/core/auto-report/rules.ts";
import { createOnRequestError } from "../../src/ui/next/request-error.ts";
import type { AutoReportEvent } from "../../src/core/types.ts";

const at = "2026-10-03T12:00:00.000Z";
const net = (status: number | undefined, url = "https://shop.test/api/charge", extra: Partial<AutoReportEvent> = {}): AutoReportEvent => ({
  kind: "network",
  at,
  type: status ? `HTTP ${status}` : "NetworkError",
  message: status ? String(status) : "Failed to fetch",
  url,
  method: "POST",
  ...(status ? { status } : {}),
  ...extra,
});

describe("status specs", () => {
  it("understands codes, classes, ranges and exclusions", () => {
    expect(statusMatches(404, 404)).toBe(true);
    expect(statusMatches("5xx", 503)).toBe(true);
    expect(statusMatches("5xx", 404)).toBe(false);
    expect(statusMatches("400-403", 401)).toBe(true);
    expect(statusMatches(["4xx", "!404"], 404)).toBe(false);
    expect(statusMatches(["4xx", "!404"], 422)).toBe(true);
    expect(statusMatches("!404", 500)).toBe(true);
  });

  it("matches URL globs by path or full URL", () => {
    expect(urlMatches("https://shop.test/api/orders/42?x=1", ["/api/*"])).toBe(true);
    expect(urlMatches("https://shop.test/images/a.png", ["/api/*"])).toBe(false);
    expect(urlMatches("https://cdn.other.com/x.js", ["https://cdn.other.com/*"])).toBe(true);
    expect(urlMatches("https://shop.test/a", [/shop\.test/])).toBe(true);
  });
});

describe("decide()", () => {
  it("defaults: 5xx and failures yes, 4xx and aborts no", () => {
    const r = normalizeAutoReport(true)!;
    expect(decide(r, net(502)).report).toBe(true);
    expect(decide(r, net(404)).report).toBe(false);
    expect(decide(r, net(undefined)).report).toBe(true);
    expect(decide(r, net(undefined, undefined, { message: "aborted" })).report).toBe(false);
    expect(decide(r, { kind: "resource", at, type: "ResourceError", message: "img", url: "/a.png" }).report).toBe(false);
    expect(decide(r, { kind: "page", at, type: "HTTP 404", message: "404", status: 404 }).report).toBe(false);
    expect(decide(r, { kind: "page", at, type: "HTTP 500", message: "500", status: 500 }).report).toBe(true);
  });

  it("per-kind rules, method filters and kind switches", () => {
    const r = normalizeAutoReport({ network: { status: ["4xx", "5xx", "!401"], methods: ["POST"] }, page: { status: ["5xx", 404] }, resources: true, errors: false })!;
    expect(decide(r, net(422)).report).toBe(true);
    expect(decide(r, net(401)).report).toBe(false);
    expect(decide(r, net(500, undefined, { method: "GET" })).report).toBe(false);
    expect(decide(r, { kind: "page", at, type: "HTTP 404", message: "404", status: 404 }).report).toBe(true);
    expect(decide(r, { kind: "resource", at, type: "ResourceError", message: "img", url: "/a.png" }).report).toBe(true);
    expect(decide(r, { kind: "error", at, type: "TypeError", message: "x" }).report).toBe(false);
  });

  it("groups the same endpoint and status together, ids aside", () => {
    expect(eventKey(net(502, "https://shop.test/api/orders/1"))).toBe(eventKey(net(502, "https://shop.test/api/orders/2")));
    expect(eventKey(net(502))).not.toBe(eventKey(net(503)));
  });

  it("is off unless asked", () => {
    expect(normalizeAutoReport(undefined)).toBeNull();
    expect(normalizeAutoReport(false)).toBeNull();
    expect(normalizeAutoReport({ enabled: false })).toBeNull();
  });
});

describe("createOnRequestError()", () => {
  const request = { path: "/checkout?token=abc", method: "GET", headers: { "x-spotter-session": "sess_abc", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } };
  const context = { routerKind: "App Router", routePath: "/checkout", routeType: "render", renderSource: "react-server-components" };

  function setup(options: Parameters<typeof createOnRequestError>[0] = {}) {
    const transport = createTestTransport();
    const client = createSpotter().init({ transport, release: { version: "1.0.0" } });
    return { transport, onRequestError: createOnRequestError({ client, ...options }) };
  }

  it("files a server report linked to the browser session, with the route", async () => {
    const { transport, onRequestError } = setup({ tags: { app: "shop" } });
    const err = Object.assign(new Error("db timeout"), { digest: "2349871" });
    await onRequestError(err, request, context);
    const r = transport.reports[0]!;
    expect(r.source).toBe("server");
    expect(r.trace.sessionId).toBe("sess_abc");
    expect(r.context.tags).toMatchObject({ "spotter.auto": "true", "spotter.trigger": "server", "next.routePath": "/checkout", "next.routeType": "render", app: "shop" });
    expect(r.context.contexts.exception).toMatchObject({ digest: "2349871", next: { routerKind: "App Router", routePath: "/checkout" } });
    expect(r.page.url).not.toContain("abc");
    expect(r.signals.errors.at(-1)).toMatchObject({ type: "Error", message: "db timeout", mechanism: "server" });
  });

  it("skips redirects and notFound() unless 404s are asked for, and dedupes", async () => {
    const { transport, onRequestError } = setup();
    await onRequestError(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }), request, context);
    await onRequestError(Object.assign(new Error("not found"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), request, context);
    expect(transport.reports).toHaveLength(0);
    const boom = () => {
      const e = new Error("db timeout");
      e.stack = "Error: db timeout\n    at query (/app/lib/db.ts:10:5)";
      return e;
    };
    await onRequestError(boom(), request, context);
    await onRequestError(boom(), request, context);
    expect(transport.reports).toHaveLength(1);

    const with404 = setup({ server: { status: ["5xx", 404] } });
    await with404.onRequestError(Object.assign(new Error("not found"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), request, context);
    expect(with404.transport.reports).toHaveLength(1);
    expect(with404.transport.reports[0]!.context.tags["http.status"]).toBe("404");
  });

  it("honours ignore and filter, and never throws", async () => {
    const { transport, onRequestError } = setup({ ignore: ["ECONNRESET"], filter: (e) => !e.url?.startsWith("/api/health") });
    await onRequestError(new Error("read ECONNRESET"), request, context);
    await onRequestError(new Error("down"), { ...request, path: "/api/health" }, context);
    expect(transport.reports).toHaveLength(0);
    const broken = createOnRequestError({ client: { captureException: () => Promise.reject(new Error("offline")) } });
    await expect(broken(new Error("x"), request, context)).resolves.toBeUndefined();
  });
});
