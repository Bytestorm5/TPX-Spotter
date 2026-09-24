import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIngestHandler, fileSystemStorage, memoryStorage, uploadRelease } from "../../src/core/server/index.ts";
import { defineHook, memoryDeliveryStore } from "../../src/core/hooks/index.ts";
import { createHttpTransport } from "../../src/core/transport/http.ts";
import type { Issue, ReportReceipt } from "../../src/core/schema.ts";
import { hmacHex } from "../../src/core/server/sign.ts";
import { exampleSubmission } from "../schema/example-report.ts";

const BASE = "https://shop.example.com/api/spotter";

/** Route fetch() calls at BASE into the handler, like a browser on the same origin would. */
function viaHandler(handler: (r: Request) => Promise<Response>, headers: Record<string, string> = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), BASE);
    const h = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) h.set(k, v);
    return handler(new Request(url, { ...init, headers: h, ...(init?.body ? { duplex: "half" } : {}) } as RequestInit));
  };
}

function withArtifacts() {
  const shot = new Uint8Array(40_000).map((_, i) => i % 256);
  const replay = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
  const sub = exampleSubmission({
    artifacts: [
      { name: "screenshot.png", kind: "screenshot", contentType: "image/png", size: shot.byteLength },
      { name: "replay.rrweb.json.gz", kind: "replay", contentType: "application/x-rrweb+gzip", size: replay.byteLength },
    ],
  });
  return { sub, shot, replay };
}

describe("createIngestHandler — self-hosted", () => {
  it("round trip: submit → chunked uploads → complete → issue event + hooks with signed artifact URLs", async () => {
    const seen: Issue[] = [];
    const hook = defineHook({ name: "capture", send: async (issue) => void seen.push(issue) });
    const handler = createIngestHandler({ hooks: [hook], upstream: false, secretKey: "sk_test_abcdefgh", rateLimit: false });
    const onIssue = vi.fn();
    handler.on("issue", onIssue);
    expect(handler.mode).toBe("self-hosted");

    const t = createHttpTransport({ endpoint: BASE, project: "pk_test_abcdefgh", fetch: viaHandler(handler), chunkSize: 16 * 1024 });
    const { sub, shot, replay } = withArtifacts();
    const receipt = await t.submit(sub);
    expect(receipt.ref).toBe("SPT-1001");
    expect(receipt.uploads.map((u) => u.name)).toEqual(["screenshot.png", "replay.rrweb.json.gz"]);
    expect(seen).toHaveLength(0);

    await t.upload(receipt, "screenshot.png", shot, "image/png");
    await t.upload(receipt, "replay.rrweb.json.gz", replay, "application/x-rrweb+gzip");
    // resubmitting the same clientId is idempotent
    expect((await t.submit(sub)).id).toBe(receipt.id);
    await t.complete(receipt);

    expect(onIssue).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    const issue = seen[0]!;
    expect(issue).toMatchObject({ schema: "spotter.report.v1", id: receipt.id, ref: "SPT-1001", status: { public: "received" } });
    expect(issue.artifacts.map((a) => a.state)).toEqual(["stored", "stored"]);
    const url = issue.artifacts[0]!.url!;
    expect(url).toMatch(new RegExp(`^${BASE}/v1/artifacts/${receipt.id}/screenshot.png\\?exp=\\d+&sig=[0-9a-f]{64}$`));

    // the signed URL serves the bytes; a tampered one doesn't
    const res = await handler(new Request(url));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(shot);
    expect((await handler(new Request(url.replace(/sig=../, "sig=00")))).status).toBe(403);

    // completing twice doesn't fire hooks twice
    await t.complete(receipt);
    expect(seen).toHaveLength(1);

    // status, replies, the needs-info loop
    await handler.ask(receipt.id, "Which card did you use?");
    const view = await t.status(receipt.id, receipt.token);
    expect(view).toMatchObject({ status: "needs_info", messages: [{ from: "team", body: "Which card did you use?" }] });
    expect((await t.reply(receipt.id, receipt.token, "Visa"))!.messages.at(-1)).toMatchObject({ from: "reporter", body: "Visa" });
    expect(await t.status(receipt.id, "wrong")).toBeNull();

    // similar + plus-one
    const similar = await t.similar("https://shop.example.com/checkout", "#pay");
    expect(similar).toEqual([expect.objectContaining({ id: receipt.id, count: 1 })]);
    expect(await t.plusOne(receipt.id)).toBe(2);

    // portal
    const portal = await (await handler(new Request(`${BASE}/v1/portal?token=${receipt.token}`))).json();
    expect(portal.reports[0]).toMatchObject({ id: receipt.id, ref: "SPT-1001" });
  });

  it("finalizes immediately when no artifacts are declared, and exposes failed deliveries", async () => {
    const store = memoryDeliveryStore();
    const failing = defineHook({ name: "tracker", retry: { attempts: 1 }, send: async () => Promise.reject(new Error("tracker down")) });
    const handler = createIngestHandler({ hooks: [failing], deliveries: store, upstream: false, secretKey: "sk_test_abcdefgh" });
    const res = await handler(new Request(`${BASE}/v1/reports`, { method: "POST", body: JSON.stringify(exampleSubmission({ artifacts: [] })) }));
    expect(res.status).toBe(201);
    const failed = await handler(new Request(`${BASE}/v1/admin/deliveries?state=failed`, { headers: { authorization: "Bearer sk_test_abcdefgh" } }));
    const list = await failed.json();
    expect(list).toEqual([expect.objectContaining({ hook: "tracker", state: "failed", error: "tracker down" })]);
    expect((await handler(new Request(`${BASE}/v1/admin/deliveries`))).status).toBe(401);
  });

  it("runs onStatus hooks on status changes and syncs GitHub webhooks back", async () => {
    const onStatus = vi.fn(async () => {});
    const hook = defineHook({ name: "github", send: async () => ({ externalId: "7", url: "https://github.com/acme/web/issues/7" }), onStatus });
    const handler = createIngestHandler({ hooks: [hook], upstream: false, secretKey: "sk_test_abcdefgh", githubWebhookSecret: "whsec" });
    const r = (await (await handler(new Request(`${BASE}/v1/reports`, { method: "POST", body: JSON.stringify(exampleSubmission({ artifacts: [] })) }))).json()) as ReportReceipt;

    const admin = await handler(
      new Request(`${BASE}/v1/admin/reports/${r.id}/status`, {
        method: "POST",
        headers: { authorization: "Bearer sk_test_abcdefgh" },
        body: JSON.stringify({ status: "in_progress" }),
      }),
    );
    expect(admin.status).toBe(200);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ id: r.id }), "in_progress", expect.objectContaining({ externalId: "7" }));

    const payload = JSON.stringify({ action: "closed", repository: { full_name: "acme/web" }, issue: { number: 7, html_url: "x", body: "<!-- spotter-fingerprint:abc -->", state_reason: "completed", milestone: { title: "v2.14.1" } } });
    const res = await handler(
      new Request(`${BASE}/v1/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: { "x-github-event": "issues", "x-hub-signature-256": `sha256=${await hmacHex("whsec", payload)}` },
      }),
    );
    expect(res.status).toBe(200);
    const view = await (await handler(new Request(`${BASE}/v1/reports/${r.id}/status?token=${r.token}`))).json();
    expect(view.status).toBe("resolved");
    expect(view.history.at(-1)).toMatchObject({ status: "resolved", release: "v2.14.1" });
    // the change came from GitHub: GitHub's own onStatus isn't called back
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("validates input and bounds sizes", async () => {
    const handler = createIngestHandler({ upstream: false });
    const bad = await handler(new Request(`${BASE}/v1/reports`, { method: "POST", body: JSON.stringify({ schema: "nope" }) }));
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.code).toBe("invalid_report");
    expect(body.details).toContain('$.schema: expected "spotter.report.v1"');

    const huge = await handler(new Request(`${BASE}/v1/reports`, { method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1) }));
    expect(huge.status).toBe(413);

    const tooBig = exampleSubmission({ artifacts: [{ name: "a.png", kind: "screenshot", contentType: "image/png", size: 11 * 1024 * 1024 }] });
    expect((await handler(new Request(`${BASE}/v1/reports`, { method: "POST", body: JSON.stringify(tooBig) }))).status).toBe(422);

    // upload without the right token
    const ok = exampleSubmission({ artifacts: [{ name: "a.png", kind: "screenshot", contentType: "image/png", size: 3 }] });
    const r = (await (await handler(new Request(`${BASE}/v1/reports`, { method: "POST", body: JSON.stringify(ok) }))).json()) as ReportReceipt;
    const put = (token: string, offset = 0) =>
      handler(new Request(`${BASE}/v1/reports/${r.id}/artifacts/a.png?offset=${offset}&total=3`, { method: "PUT", body: new Uint8Array([1, 2, 3]), headers: { "x-spotter-upload-token": token }, duplex: "half" } as RequestInit));
    expect((await put("nope")).status).toBe(403);
    expect((await put(r.token, 1)).status).toBe(409);
    expect((await put(r.token)).headers.get("upload-offset")).toBe("3");
  });

  it("CORS: same-origin and allowed origins only", async () => {
    const handler = createIngestHandler({ upstream: false, allowedOrigins: ["https://*.acme.com"] });
    const pre = await handler(new Request(`${BASE}/v1/reports`, { method: "OPTIONS", headers: { origin: "https://app.acme.com" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.acme.com");
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-spotter-key");
    expect(pre.headers.get("access-control-expose-headers")).toContain("upload-offset");
    const denied = await handler(new Request(`${BASE}/v1/config`, { headers: { origin: "https://evil.test" } }));
    expect(denied.status).toBe(403);
    const same = await handler(new Request(`${BASE}/v1/config`, { headers: { origin: "https://shop.example.com" } }));
    expect(same.status).toBe(200);
  });

  it("rate-limits per IP", async () => {
    const handler = createIngestHandler({ upstream: false, rateLimit: { reports: 2, windowMs: 60_000 } });
    const post = (ip: string) =>
      handler(new Request(`${BASE}/v1/reports`, { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` }, body: JSON.stringify(exampleSubmission({ artifacts: [] })) }));
    expect((await post("1.1.1.1")).status).toBe(201);
    expect((await post("1.1.1.1")).status).toBe(201);
    const limited = await post("1.1.1.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post("2.2.2.2")).status).toBe(201);
  });

  it("rejects a mismatched project key and verifies Turnstile for anonymous reports", async () => {
    const fetch = vi.fn(async () => Response.json({ success: false }));
    const handler = createIngestHandler({ upstream: false, project: "pk_live_realkey1", turnstileSecret: "ts_secret", fetch });
    const wrongKey = await handler(new Request(`${BASE}/v1/reports`, { method: "POST", headers: { "x-spotter-key": "pk_live_otherkey" }, body: "{}" }));
    expect(wrongKey.status).toBe(401);
    const res = await handler(new Request(`${BASE}/v1/reports`, { method: "POST", headers: { "x-spotter-key": "pk_live_realkey1" }, body: JSON.stringify(exampleSubmission({ artifacts: [], turnstileToken: "tok" })) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("turnstile_failed");
    expect(fetch).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.anything());
  });

  it("promotes critical flags to reports", async () => {
    const seen: Issue[] = [];
    const handler = createIngestHandler({ upstream: false, hooks: [defineHook({ name: "x", send: async (i) => void seen.push(i) })] });
    const batch = {
      flags: [
        { name: "checkout.total_mismatch", severity: "warning", fingerprint: ["checkout"], at: new Date().toISOString(), count: 3 },
        { name: "payments.down", severity: "critical", fingerprint: ["payments"], at: new Date().toISOString(), count: 1, page: { url: "https://shop.example.com/pay" } },
      ],
      sdk: { name: "@trusplex/spotter", version: "0.1.0", features: [] },
    };
    const res = await (await handler(new Request(`${BASE}/v1/flags`, { method: "POST", body: JSON.stringify(batch) }))).json();
    expect(res.accepted).toBe(2);
    expect(res.promoted).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: "flag", flag: { name: "payments.down", occurrences: 1 }, content: { severity: "critical" } });
  });

  it("persists to the filesystem (lazy node:fs)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotter-"));
    try {
      const storage = fileSystemStorage(dir);
      expect(await storage.append("artifacts/r/a.bin", 0, new Uint8Array([1, 2]))).toBe(2);
      expect(await storage.append("artifacts/r/a.bin", 0, new Uint8Array([9]))).toBe(2); // wrong offset: no write
      expect(await storage.append("artifacts/r/a.bin", 2, new Uint8Array([3]))).toBe(3);
      expect(await storage.read("artifacts/r/a.bin")).toEqual(new Uint8Array([1, 2, 3]));
      expect(await storage.list("artifacts/")).toEqual(["artifacts/r/a.bin"]);
      await expect(storage.put("../escape", new Uint8Array())).rejects.toThrow(/invalid key/);

      const h1 = createIngestHandler({ upstream: false, storage });
      const r = (await (await h1(new Request(`${BASE}/v1/reports`, { method: "POST", body: JSON.stringify(exampleSubmission({ artifacts: [] })) }))).json()) as ReportReceipt;
      // a fresh handler (new process) still knows the report
      const h2 = createIngestHandler({ upstream: false, storage: fileSystemStorage(dir) });
      expect((await h2(new Request(`${BASE}/v1/reports/${r.id}/status?token=${r.token}`))).status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createIngestHandler — proxy to the hosted ingest", () => {
  it("forwards non-report traffic with the secret key and the browser's facts", async () => {
    const upstreamCalls: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      upstreamCalls.push(req);
      if (req.url.endsWith("/v1/config")) return Response.json({ version: 7, features: { replay: false } });
      if (req.url.endsWith("/v1/events")) return new Response(null, { status: 202 });
      return Response.json({ ok: true });
    });
    const handler = createIngestHandler({ project: "pk_live_abcdefgh", secretKey: "sk_live_abcdefgh", fetch, dispatcher: false });
    expect(handler.mode).toBe("proxy");
    const cfg = await handler(
      new Request(`${BASE}/v1/config`, {
        headers: {
          "x-spotter-key": "pk_live_abcdefgh",
          "x-forwarded-for": "203.0.113.9, 10.0.0.1",
          "user-agent": "Mozilla/5.0 test",
          origin: "https://shop.example.com",
          "x-vercel-ip-country": "DE",
        },
      }),
    );
    expect(await cfg.json()).toEqual({ version: 7, features: { replay: false } });
    const up = upstreamCalls[0]!;
    expect(up.url).toBe("https://console.trusplex.com/hooks/spotter/v1/config");
    expect(up.headers.get("authorization")).toBe("Bearer sk_live_abcdefgh");
    expect(up.headers.get("x-spotter-key")).toBe("pk_live_abcdefgh");
    expect(up.headers.get("x-spotter-forwarded-for")).toBe("203.0.113.9");
    expect(up.headers.get("x-spotter-forwarded-ua")).toBe("Mozilla/5.0 test");
    expect(up.headers.get("x-spotter-forwarded-origin")).toBe("https://shop.example.com");
    expect(up.headers.get("x-spotter-forwarded-country")).toBe("DE");

    const ev = await handler(new Request(`${BASE}/v1/events`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ key: "pk_live_abcdefgh", events: [] }) }));
    expect(ev.status).toBe(202);
    expect(await upstreamCalls[1]!.text()).toContain('"events":[]');
  });

  it("makes Console's receipt canonical via the auto-added dispatcher and tees artifacts upstream", async () => {
    const upstream: { method: string; url: string }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      upstream.push({ method, url });
      if (url.endsWith("/v1/reports")) return Response.json({ id: "con_42", ref: "SPT-4821", url: "https://console.trusplex.com/r/con_42", token: "ctok", uploads: [] }, { status: 201 });
      if (method === "PUT") return new Response(null, { status: 204, headers: { "upload-offset": new URL(url).searchParams.get("total")! } });
      return Response.json({ ok: true });
    });
    const local: Issue[] = [];
    const handler = createIngestHandler({
      project: "pk_live_abcdefgh",
      secretKey: "sk_live_abcdefgh",
      fetch,
      storage: memoryStorage(),
      hooks: [defineHook({ name: "local", send: async (i) => void local.push(i) })],
    });
    const t = createHttpTransport({ endpoint: BASE, project: "pk_live_abcdefgh", fetch: viaHandler(handler) });
    const { sub, shot, replay } = withArtifacts();
    const receipt = await t.submit(sub);
    expect(receipt).toMatchObject({ id: "con_42", ref: "SPT-4821", url: "https://console.trusplex.com/r/con_42", token: "ctok" });
    await t.upload(receipt, "screenshot.png", shot, "image/png");
    await t.upload(receipt, "replay.rrweb.json.gz", replay, "application/x-rrweb+gzip");
    await t.complete(receipt);
    expect(local[0]!.id).toBe("con_42");
    const puts = upstream.filter((c) => c.method === "PUT").map((c) => new URL(c.url).pathname);
    expect(puts).toEqual(["/hooks/spotter/v1/reports/con_42/artifacts/screenshot.png", "/hooks/spotter/v1/reports/con_42/artifacts/replay.rrweb.json.gz"]);
    expect(upstream.at(-1)!.url).toBe("https://console.trusplex.com/hooks/spotter/v1/reports/con_42/complete");
    const deliveries = await handler.deliveries();
    expect(deliveries.map((d) => [d.hook, d.state])).toEqual(expect.arrayContaining([["dispatcher", "delivered"], ["local", "delivered"]]));
    // status is Console's: proxied
    await t.status("con_42", "ctok");
    expect(upstream.at(-1)!.url).toBe("https://console.trusplex.com/hooks/spotter/v1/reports/con_42/status?token=ctok");
  });
});

describe("uploadRelease()", () => {
  it("declares the release and uploads source maps with the secret key", async () => {
    const calls: { method: string; url: string; auth: string | null }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init);
      calls.push({ method: r.method, url: r.url, auth: r.headers.get("authorization") });
      return r.url.endsWith("/v1/releases") ? Response.json({ release: "2.14.0" }, { status: 201 }) : Response.json({ ok: true }, { status: 201 });
    });
    const res = await uploadRelease({
      endpoint: "https://console.test/hooks/spotter",
      secretKey: "sk_test_abcdefgh",
      release: { version: "2.14.0", commit: "abc" },
      files: [{ name: "static/chunks/app.js.map", content: "{}" }, { name: "b.js.map", content: new Uint8Array([123, 125]) }],
      fetch,
    });
    expect(res).toEqual({ release: "2.14.0", uploaded: expect.arrayContaining(["static/chunks/app.js.map", "b.js.map"]), failed: [] });
    expect(calls[0]).toEqual({ method: "POST", url: "https://console.test/hooks/spotter/v1/releases", auth: "Bearer sk_test_abcdefgh" });
    expect(calls.map((c) => c.url)).toContain("https://console.test/hooks/spotter/v1/releases/2.14.0/sourcemaps?file=static%2Fchunks%2Fapp.js.map");
  });
});
