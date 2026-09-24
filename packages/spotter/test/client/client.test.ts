// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpotter, type SpotterInstance } from "../../src/core/client.ts";
import { createTestTransport, type TestTransport } from "../../src/core/testing.ts";
import { resetDevWarnings } from "../../src/core/dev.ts";
import { SpotterDroppedError } from "../../src/core/errors.ts";
import type { SpotterConfig } from "../../src/core/types.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let client: SpotterInstance;
let transport: TestTransport;

function start(extra: SpotterConfig = {}): SpotterInstance {
  transport = createTestTransport();
  client = createSpotter();
  client.init({
    project: "pk_test_abcdefgh",
    transport,
    replay: { mode: "off" },
    features: { screenshot: false },
    ...extra,
  });
  return client;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetDevWarnings();
});

afterEach(() => {
  client?.destroy();
  vi.restoreAllMocks();
});

describe("init", () => {
  it("sends nothing before the first interaction, then fetches remote config on idle", async () => {
    start();
    const config = vi.spyOn(transport, "config");
    await client.ready();
    await tick(20);
    expect(config).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pointerdown"));
    await tick(20);
    expect(config).toHaveBeenCalledTimes(1);
  });

  it("exposes and removes the global handle", async () => {
    start();
    expect((window as unknown as { __trusplexSpotter?: unknown }).__trusplexSpotter).toBe(client);
    client.destroy();
    expect((window as unknown as { __trusplexSpotter?: unknown }).__trusplexSpotter).toBeUndefined();
  });

  it("restores console on destroy", async () => {
    const original = console.log;
    start();
    await client.ready();
    expect(console.log).not.toBe(original);
    client.destroy();
    expect(console.log).toBe(original);
  });

  it("keeps a tab-scoped session id", () => {
    start();
    const id = client.sessionId;
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(sessionStorage.getItem("spotter:sid")).toBe(id);
  });
});

describe("report()", () => {
  it("builds a full submission, returns the receipt, then uploads artifacts and completes", async () => {
    start({ environment: "development", release: { version: "2.14.0" } });
    await client.ready();
    client.identify({ id: "u_1", email: "ada@example.com", plan: "pro" });
    client.setTags({ area: "checkout" });
    client.setContext("cart", { items: 2 });
    client.setFlags({ newCheckout: true });
    client.addBreadcrumb({ category: "custom", message: "Applied coupon SAVE10" });
    client.attach("state.json", { step: 3 });
    console.error("payment failed for card 4111 1111 1111 1111");

    const sent = vi.fn();
    const issue = vi.fn();
    client.on("sent", sent);
    client.on("issue", issue);
    const receipt = await client.report({ title: "Payment provider returned 502", description: "…", severity: "error" });

    expect(receipt.ref).toBe("SPT-TEST-1");
    const r = transport.reports[0]!;
    expect(r.schema).toBe("spotter.report.v1");
    expect(r.source).toBe("api");
    expect(r.test).toBe(true);
    expect(r.reporter).toMatchObject({ id: "u_1", email: "ada@example.com", traits: { plan: "pro" }, type: "public", contact: "email" });
    expect(r.context).toMatchObject({ tags: { area: "checkout" }, contexts: { cart: { items: 2 } }, flags: { newCheckout: true } });
    expect(r.release).toMatchObject({ version: "2.14.0", environment: "development" });
    expect(r.signals.console.some((c) => JSON.stringify(c.args).includes("[redacted:"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("4111 1111 1111 1111");
    expect(r.timeline.join("\n")).toContain("Applied coupon SAVE10");
    expect(r.fingerprint).toMatch(/^[0-9a-f]{14}$/);
    expect(r.trace.sessionId).toBe(client.sessionId);
    expect(r.sdk.features).not.toContain("screenshot");
    expect(r.artifacts.map((a) => a.kind).sort()).toEqual(["attachment", "dom_snapshot"]);
    expect(sent).toHaveBeenCalledWith(receipt);
    expect(issue.mock.calls[0]![0].receipt).toEqual(receipt);

    // uploads happen after the receipt came back
    expect(transport.completed).toEqual([]);
    await transport.waitForComplete(receipt.id);
    expect(transport.uploads.map((u) => u.name).sort()).toEqual(["dom.html", "state.json"]);
    expect(new TextDecoder().decode(transport.uploads.find((u) => u.name === "state.json")!.data)).toBe('{"step":3}');

    // the token is kept so status() works (also after a reload)
    expect(localStorage.getItem("spotter:reports")).toContain(receipt.id);
    transport.setStatus(receipt.id, "resolved", "Fixed in v2.14");
    const statusChange = vi.fn();
    client.on("statusChange", statusChange);
    expect((await client.status(receipt.id))!.status).toBe("resolved");
    expect(statusChange).toHaveBeenCalledWith({ reportId: receipt.id, status: "resolved" });
    expect((await client.reply(receipt.id, "Thanks!"))!.messages.at(-1)!.body).toBe("Thanks!");
    expect(client.myReports()[0]).toMatchObject({ id: receipt.id, ref: "SPT-TEST-1", title: "Payment provider returned 502" });
  });

  it("respects include, beforeCapture and beforeSend", async () => {
    start({
      beforeSend: (r) => ({ ...r, context: { ...r.context, tags: { ...r.context.tags, edited: "yes" } } }),
    });
    await client.ready();
    console.log("hello");
    await client.report({ title: "t", include: { console: false, dom: false } });
    const r = transport.reports[0]!;
    expect(r.signals.console).toEqual([]);
    expect(r.artifacts).toEqual([]);
    expect(r.context.tags.edited).toBe("yes");

    client.destroy();
    start({ beforeSend: () => null });
    await expect(client.report({ title: "dropped" })).rejects.toBeInstanceOf(SpotterDroppedError);
    expect(transport.reports).toEqual([]);
  });

  it("confirms with a provisional receipt when offline and delivers on `online`", async () => {
    start();
    await client.ready();
    transport.failNext("submit", 1);
    const receipt = await client.report({ title: "offline", include: { dom: false } });
    expect(receipt.queued).toBe(true);
    expect(receipt.ref).toMatch(/^SPT-PENDING-[0-9A-F]{4}$/);
    expect(transport.reports).toEqual([]);
    expect((await client.status(receipt.id))!.status).toBe("received");

    window.dispatchEvent(new Event("online"));
    const delivered = await transport.waitForReport((r) => r.content.title === "offline");
    expect(delivered.clientId).toBeTruthy();
    await tick(10);
    const view = await client.status(receipt.id);
    expect(view!.ref).toBe("SPT-TEST-1");
  });

  it("captureException files source error with the error entry and context", async () => {
    start();
    await client.ready();
    const receipt = await client.captureException(new TypeError("x is undefined"), { tags: { boundary: "checkout" }, orderId: 42 });
    expect(receipt).not.toBeNull();
    const r = transport.reports[0]!;
    expect(r.source).toBe("error");
    expect(r.content.severity).toBe("error");
    expect(r.signals.errors.at(-1)).toMatchObject({ type: "TypeError", message: "x is undefined", mechanism: "captured" });
    expect(r.context.tags.boundary).toBe("checkout");
    expect(r.context.contexts.exception).toEqual({ orderId: 42 });
  });

  it("marks guest reporters from ?spotter_guest= and strips it from the URL", async () => {
    history.replaceState(null, "", "/page?spotter_guest=g_123&x=1");
    start();
    expect(location.search).toBe("?x=1");
    expect(client.reporterMode()).toEqual({ type: "guest" });
    await client.report({ title: "guest", include: { dom: false } });
    expect(transport.reports[0]!.reporter.type).toBe("guest");
    expect(transport.reports[0]!.guestToken).toBe("g_123");
  });

  it("switches to team mode from Console's postMessage", async () => {
    start({ endpoint: "https://console.test/hooks/spotter" });
    const popup = { closed: false, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const connecting = client.connectTeam();
    expect(open.mock.calls[0]![0]).toBe(
      `https://console.test/spotter/connect?key=pk_test_abcdefgh&origin=${encodeURIComponent(location.origin)}`,
    );
    window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.test", data: { type: "spotter:team-token", token: "x" } }));
    window.dispatchEvent(new MessageEvent("message", { origin: "https://console.test", data: { type: "spotter:team-token", token: "tt_1", name: "Ada" } }));
    expect(await connecting).toEqual({ type: "team", name: "Ada" });
    await client.report({ title: "team", include: { dom: false } });
    expect(transport.reports[0]!.reporter).toMatchObject({ type: "team", name: "Ada" });
    expect(transport.reports[0]!.teamToken).toBe("tt_1");
  });
});

describe("flags", () => {
  it("dedupes, counts, rate-limits per fingerprint and batches", async () => {
    start({ flagRateLimit: 3 });
    for (let i = 0; i < 5; i++) client.flag("checkout.total_mismatch", { data: { i }, fingerprint: ["checkout", "total"] });
    client.flag("other");
    client.assert(1 + 1 === 3, "math.broken", { expected: 3 });
    await client.flush();
    const byName = Object.fromEntries(transport.flagOccurrences.map((f) => [f.name, f]));
    expect(byName["checkout.total_mismatch"]).toMatchObject({ count: 3, fingerprint: ["checkout", "total"], data: { i: 2 }, severity: "warning" });
    expect(byName.other!.count).toBe(1);
    expect(byName["math.broken"]!.severity).toBe("error");
    expect(byName.other!.sessionId).toBe(client.sessionId);
  });

  it("is a typed no-op with a dev warning when the feature is off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    start({ features: { flags: false, analytics: false, screenshot: false } });
    client.flag("x");
    client.track("signup");
    await client.flush();
    expect(transport.flagOccurrences).toEqual([]);
    expect(client.enabled("flags")).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/flag\(\) was called but the "flags" feature/);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/track\(\) was called but the "analytics" feature/);
  });
});

describe("remote config", () => {
  it("can only narrow", async () => {
    start({ replay: { mode: "buffer" }, features: { screenshot: false } });
    transport.setRemoteConfig({ version: 3, features: { analytics: false, recording: true }, replay: { mode: "sampled", windowSeconds: 20 } });
    const onConfig = vi.fn();
    client.on("config", onConfig);
    client.open();
    await vi.waitFor(() => expect(onConfig).toHaveBeenCalled());
    expect(client.enabled("analytics")).toBe(false);
    expect(client.enabled("recording")).toBe(false); // compiled out by default; remote can't enable
    expect((client.config as { replayMode?: string }).replayMode).toBe("buffer"); // sampled is wider than buffer
    expect((client.config as { windowSeconds?: number }).windowSeconds).toBe(20);
  });
});

describe("widget flow", () => {
  it("captures before the panel opens and submits from the capture", async () => {
    start();
    const states: string[] = [];
    client.on("statusChange", (s) => "state" in s && states.push(s.state));
    document.body.innerHTML = `<main><button id="pay">Pay</button></main>`;
    const capture = await client.captureForReport({ element: document.getElementById("pay")! });
    expect(capture.page.selector).toBe("#pay");
    expect(capture.attachments.some((a) => a.kind === "environment")).toBe(true);
    client.setState("annotating");
    const receipt = await client.submitFromWidget({
      captureId: capture.id,
      description: "Pay does nothing\nI clicked it twice",
      category: "bug",
      annotations: [{ tool: "rect", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
      annotatedScreenshot: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      include: { dom: false },
      email: "reporter@example.com",
    });
    const r = transport.reports[0]!;
    expect(r.source).toBe("widget");
    expect(r.content.title).toBe("Pay does nothing");
    expect(r.page.selector).toBe("#pay");
    expect(r.reporter).toMatchObject({ email: "reporter@example.com", contact: "email" });
    expect(r.artifacts.map((a) => a.name)).toEqual(["annotated.png"]);
    expect(receipt.ref).toBe("SPT-TEST-1");
    expect(states).toEqual(["capturing", "annotating", "submitting", "sent"]);
  });
});
