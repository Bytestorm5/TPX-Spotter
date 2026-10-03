// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpotter, type SpotterInstance } from "../../src/core/client.ts";
import { createTestTransport, type TestTransport } from "../../src/core/testing.ts";
import { resetDevWarnings } from "../../src/core/dev.ts";
import type { AutoReportConfig, SpotterConfig } from "../../src/core/types.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let client: SpotterInstance;
let transport: TestTransport;
const savedFetch = window.fetch;

/** Responses by path, for the patched fetch the network signal wraps. */
let responses: Record<string, { status: number; statusText?: string; body?: unknown }> = {};

function start(autoReport: boolean | AutoReportConfig = {}, extra: SpotterConfig = {}): SpotterInstance {
  transport = createTestTransport();
  client = createSpotter();
  client.init({
    project: "pk_test_abcdefgh",
    transport,
    replay: { mode: "off" },
    features: { screenshot: false },
    autoReport: typeof autoReport === "object" ? { delayMs: 30, ...autoReport } : autoReport,
    ...extra,
  });
  return client;
}

/** Engine, session chunk and the auto-report chunk all loaded. */
async function ready(): Promise<void> {
  await client.ready();
  await vi.waitFor(async () => {
    const e = (await import("../../src/core/auto-report/index.ts")) as unknown;
    expect(e).toBeTruthy();
  });
  await tick(20);
}

function throwUncaught(error: unknown): void {
  window.dispatchEvent(new ErrorEvent("error", { error, message: (error as Error)?.message ?? String(error) }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetDevWarnings();
  responses = {};
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href);
    const r = responses[url.pathname] ?? { status: 200 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, statusText: r.statusText ?? "", headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  client?.destroy();
  window.fetch = savedFetch;
  vi.restoreAllMocks();
});

describe("autoReport", () => {
  it("files a detailed report for an uncaught error", async () => {
    start({ tags: { team: "web" } });
    await ready();
    const seen = vi.fn();
    client.on("autoReport", seen);
    client.setContext("cart", { items: 2 });
    console.info("before the crash");
    throwUncaught(new TypeError("Cannot read properties of undefined (reading 'balance')"));
    const r = await transport.waitForReport();
    expect(r.source).toBe("error");
    expect(r.content.title).toBe("TypeError: Cannot read properties of undefined (reading 'balance')");
    expect(r.content.severity).toBe("error");
    expect(r.content.description).toContain("Spotter filed this report automatically");
    expect(r.content.description).toMatch(/\*\*[\d:.]+ · error: TypeError/); // the headline, in bold
    expect(r.context.tags).toMatchObject({ "spotter.auto": "true", "spotter.trigger": "error", "error.type": "TypeError", team: "web" });
    const auto = r.context.contexts.autoReport as Record<string, unknown>;
    expect(auto.trigger).toBe("error");
    expect((auto.events as unknown[]).length).toBe(1);
    expect(auto.page).toMatchObject({ readyState: expect.any(String) });
    expect(r.context.contexts.cart).toEqual({ items: 2 });
    // the error is listed once, with its stack parsed
    expect(r.signals.errors).toHaveLength(1);
    expect(r.signals.errors[0]!.frames.length).toBeGreaterThan(0);
    expect(r.signals.console.some((c) => c.args[0] === "before the crash")).toBe(true);
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    expect(seen.mock.calls[0]![0].trigger.kind).toBe("error");
    // not shown as one of the visitor's own reports
    expect(client.myReports()).toHaveLength(0);
  });

  it("reports 5xx responses but not 404s by default", async () => {
    start();
    await ready();
    responses["/api/missing"] = { status: 404, statusText: "Not Found" };
    responses["/api/charge"] = { status: 502, statusText: "Bad Gateway" };
    await window.fetch("/api/missing");
    await tick(60);
    expect(transport.reports).toHaveLength(0);
    await window.fetch("/api/charge", { method: "POST" });
    const r = await transport.waitForReport();
    expect(r.content.title).toBe("POST /api/charge responded 502 Bad Gateway");
    expect(r.context.tags["http.status"]).toBe("502");
    expect(r.signals.errors.at(-1)).toMatchObject({ type: "HTTP 502", mechanism: "captured" });
    expect(r.signals.network.log.entries.some((e) => e.response.status === 502)).toBe(true);
    expect(transport.reports).toHaveLength(1);
  });

  it("reports 404s when the site says they matter, and only where it says", async () => {
    start({ network: [{ status: "5xx" }, { status: 404, urls: ["/api/*"] }] });
    await ready();
    responses["/api/orders/42"] = { status: 404 };
    responses["/images/x.png"] = { status: 404 };
    await window.fetch("/images/x.png");
    await tick(60);
    expect(transport.reports).toHaveLength(0);
    await window.fetch("/api/orders/42");
    const r = await transport.waitForReport();
    expect(r.content.severity).toBe("warning");
    expect(r.content.title).toContain("/api/orders/42 responded 404");
  });

  it("coalesces related problems into one report", async () => {
    start({ delayMs: 80 });
    await ready();
    responses["/api/charge"] = { status: 500 };
    await window.fetch("/api/charge", { method: "POST" });
    throwUncaught(new Error("Payment failed"));
    const r = await transport.waitForReport();
    await tick(120);
    expect(transport.reports).toHaveLength(1);
    // the thrown error is the headline; the request that caused it is listed with it
    expect(r.context.tags["spotter.trigger"]).toBe("error");
    const events = (r.context.contexts.autoReport as { events: { kind: string }[] }).events;
    expect(events.map((e) => e.kind)).toEqual(["error", "network"]);
  });

  it("reports the same problem once per tab session", async () => {
    start({ delayMs: 10 });
    await ready();
    const boom = () => {
      const e = new Error("same thing");
      e.stack = "Error: same thing\n    at pay (https://shop.test/app.js:10:5)";
      return e;
    };
    throwUncaught(boom());
    await transport.waitForReport();
    await tick(40);
    throwUncaught(boom());
    await tick(60);
    expect(transport.reports).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem("spotter:auto")!).total).toBe(1);
  });

  it("caps reports per tab session", async () => {
    start({ delayMs: 5, limits: { perSession: 2 } });
    await ready();
    for (let i = 0; i < 4; i++) {
      const e = new RangeError(`distinct ${i}`);
      e.stack = `RangeError: distinct ${i}\n    at step${i} (https://shop.test/app.js:${i}:1)`;
      throwUncaught(e);
      await tick(40);
    }
    await tick(60);
    expect(transport.reports).toHaveLength(2);
  });

  it("reports console.error(err) but not plain console lines", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      start();
      await ready();
      console.error("just a string");
      await tick(60);
      expect(transport.reports).toHaveLength(0);
      console.error("The above error occurred in <Checkout>", new TypeError("total is NaN"));
      const r = await transport.waitForReport();
      expect(r.context.tags["spotter.trigger"]).toBe("console");
      expect(r.content.title).toContain("TypeError: total is NaN");
    } finally {
      console.error = original;
    }
  });

  it("lets filter() veto or force", async () => {
    start({
      filter: (e, matched) => {
        if (e.kind === "error" && e.message.includes("extension")) return false;
        if (e.kind === "network" && e.status === 418) return true;
        return matched;
      },
    });
    await ready();
    throwUncaught(new Error("from a browser extension"));
    await tick(60);
    expect(transport.reports).toHaveLength(0);
    responses["/api/teapot"] = { status: 418 };
    await window.fetch("/api/teapot");
    const r = await transport.waitForReport();
    expect(r.context.tags["http.status"]).toBe("418");
  });

  it("ignores noise and the ignore list", async () => {
    start({ ignore: ["chunk-vendor"] });
    await ready();
    throwUncaught("Script error.");
    throwUncaught(new Error("ResizeObserver loop completed with undelivered notifications."));
    throwUncaught(new Error("failed in chunk-vendor.js"));
    await tick(80);
    expect(transport.reports).toHaveLength(0);
  });

  it("reports errors that happened before it loaded", async () => {
    start();
    // Before the engine: the loader buffers it.
    throwUncaught(new SyntaxError("hydration blew up"));
    await ready();
    const r = await transport.waitForReport();
    expect(r.content.title).toBe("SyntaxError: hydration blew up");
  });

  it("does nothing when off", async () => {
    start(false);
    await client.ready();
    await tick(20);
    throwUncaught(new Error("x"));
    responses["/api/x"] = { status: 500 };
    await window.fetch("/api/x");
    await tick(80);
    expect(transport.reports).toHaveLength(0);
  });

  it("redacts what it writes", async () => {
    start();
    await ready();
    responses["/api/reset"] = { status: 500 };
    await window.fetch("/api/reset?token=supersecret123&email=ada@example.com");
    const r = await transport.waitForReport();
    const all = JSON.stringify(r);
    expect(all).not.toContain("supersecret123");
    expect(all).not.toContain("ada@example.com");
  });
});

describe("autoReport and explicit reports", () => {
  it("doesn't file an error again that captureException() already filed", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      start({ delayMs: 60 });
      await ready();
      const err = new TypeError("card.balance is undefined");
      await client.captureException(err, { mechanism: "boundary" });
      console.error(err); // what React does after a boundary catches it
      await tick(150);
      expect(transport.reports).toHaveLength(1);
      expect(transport.reports[0]!.context.tags["spotter.auto"]).toBeUndefined();
    } finally {
      console.error = original;
    }
  });
});

describe("autoReport: resources and CSP (opt-in)", () => {
  it("reports failed element loads and CSP violations when turned on", async () => {
    start({ resources: true, csp: true, delayMs: 20 });
    await ready();
    const img = document.createElement("img");
    img.setAttribute("src", "https://cdn.shop.test/hero.png");
    document.body.append(img);
    img.dispatchEvent(new Event("error"));
    const r = await transport.waitForReport();
    expect(r.context.tags["spotter.trigger"]).toBe("resource");
    expect(r.content.title).toBe("Failed to load img cdn.shop.test/hero.png");
    img.remove();

    const v = Object.assign(new Event("securitypolicyviolation"), { blockedURI: "https://evil.test/x.js", effectiveDirective: "script-src-elem", violatedDirective: "script-src" });
    document.dispatchEvent(v);
    const c = await transport.waitForReport((x) => x.context.tags["spotter.trigger"] === "csp");
    expect(c.content.title).toBe("Content-Security-Policy blocked evil.test/x.js (script-src-elem)");
    expect(c.content.severity).toBe("warning");
  });

  it("leaves them alone by default", async () => {
    start({ delayMs: 20 });
    await ready();
    const img = document.createElement("img");
    img.setAttribute("src", "/missing.png");
    document.body.append(img);
    img.dispatchEvent(new Event("error"));
    await tick(60);
    expect(transport.reports).toHaveLength(0);
    img.remove();
  });
});
