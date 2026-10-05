import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpotter } from "../../src/core/client.ts";
import { createTestTransport } from "../../src/core/testing.ts";
import { resolveConfig, HOSTED_ENDPOINT } from "../../src/core/config.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("core on the server", () => {
  it("imports without touching window (SSR / RSC safe)", async () => {
    expect(typeof window).toBe("undefined");
    const mod = await import("../../src/core/index.ts");
    expect(mod.spotter.initialized).toBe(false);
  });

  it("defaults to the hosted ingest with the secret key from env", () => {
    vi.stubEnv("SPOTTER_SECRET_KEY", "sk_test_abcdefgh");
    vi.stubEnv("SPOTTER_PROJECT", "pk_test_abcdefgh");
    const c = resolveConfig({});
    expect(c.runtime).toBe("node");
    expect(c.endpoint).toBe(HOSTED_ENDPOINT);
    expect(c.secretKey).toBe("sk_test_abcdefgh");
    vi.stubEnv("SPOTTER_ENDPOINT", "https://ingest.example.com/spotter/");
    expect(resolveConfig({}).endpoint).toBe("https://ingest.example.com/spotter");
  });

  it("reports with source server, linked to the browser session and trace", async () => {
    const transport = createTestTransport();
    const spotter = createSpotter().init({ transport, release: { version: "1.0.0" } });
    const request = new Request("https://shop.test/api/charge?token=secret", {
      headers: { "x-spotter-session": "sess_abc", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
    });
    const receipt = await spotter.report({ title: "Charge failed", request });
    expect(receipt.ref).toBe("SPT-TEST-1");
    const r = transport.reports[0]!;
    expect(r.source).toBe("server");
    expect(r.environment.runtime).toBe("node");
    expect(r.environment.device).toBe("server");
    expect(r.trace.sessionId).toBe("sess_abc");
    expect(r.trace.traceparents).toEqual(["00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]);
    expect(r.page.url).not.toContain("secret");
    expect(r.reporter.contact).toBe("none");

    const scoped = spotter.withRequest({ headers: { "x-spotter-session": "sess_xyz" } });
    await scoped.captureException(new RangeError("bad amount"));
    const e = transport.reports[1]!;
    expect(e.source).toBe("server");
    expect(e.signals.errors.at(-1)).toMatchObject({ type: "RangeError", mechanism: "server" });
    expect(e.trace.sessionId).toBe("sess_xyz");

    scoped.flag("charge.retry", { severity: "info" });
    await spotter.flush();
    expect(transport.flagOccurrences[0]).toMatchObject({ name: "charge.retry", sessionId: "sess_xyz", count: 1 });
  });

  it("sends goals and funnel steps from the server, with the conversion id", async () => {
    const transport = createTestTransport();
    const spotter = createSpotter().init({ transport });
    const checkout = spotter.funnel("checkout", ["cart", "paid"]);
    const eu = spotter.funnel("checkout-eu", ["cart", "paid"]);
    expect(checkout.steps).toEqual(["cart", "paid"]);
    // One checkout reports to a broad funnel, a specific one and a goal, under one id.
    checkout.step("paid", { id: "cs_1", revenue: { value: 20, currency: "EUR" } });
    eu.step("paid", { id: "cs_1", revenue: { value: 20, currency: "EUR" } });
    spotter.goal("purchase", { id: "cs_1", props: { plan: "pro" }, metadata: { coupon: "SPRING", items: [{ sku: "A", qty: 1 }] } });
    await vi.waitFor(() => expect(transport.analyticsEvents).toHaveLength(3));
    const [a, b, c] = transport.analyticsEvents;
    expect(a).toMatchObject({ type: "event", name: "checkout:paid", conversionId: "cs_1", funnel: { name: "checkout", step: "paid", steps: ["cart", "paid"] } });
    expect(b).toMatchObject({ name: "checkout-eu:paid", conversionId: "cs_1", funnel: { name: "checkout-eu" } });
    expect(c).toMatchObject({
      name: "purchase",
      goal: "purchase",
      conversionId: "cs_1",
      props: { plan: "pro" },
      metadata: { coupon: "SPRING", items: [{ sku: "A", qty: 1 }] },
    });
  });

  it("works zero-config from env without init()", async () => {
    vi.stubEnv("SPOTTER_SECRET_KEY", "sk_test_abcdefgh");
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${HOSTED_ENDPOINT}/v1/reports`);
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk_test_abcdefgh");
      return Response.json({ id: "r1", ref: "SPT-9", token: "t", uploads: [] }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    const receipt = await createSpotter().report({ title: "from a server action" });
    expect(receipt.ref).toBe("SPT-9");
    expect(fetch).toHaveBeenCalledTimes(2); // submit + complete (no artifacts)
    vi.unstubAllGlobals();
  });
});
