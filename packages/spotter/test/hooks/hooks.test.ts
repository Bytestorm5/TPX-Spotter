import { describe, expect, it, vi } from "vitest";
import { defineHook, runHooks, runStatusHooks, memoryDeliveryStore } from "../../src/core/hooks/index.ts";
import { github, githubEventToUpdates, githubWebhookHandler } from "../../src/core/hooks/github.ts";
import { dispatcher, DISPATCHER_INGEST } from "../../src/core/hooks/dispatcher.ts";
import { hmacHex } from "../../src/core/server/sign.ts";
import { exampleReport } from "../schema/example-report.ts";

const noSleep = { sleep: async () => {} };

/** A tiny fake of the GitHub REST API. */
function fakeGitHub() {
  const issues: { number: number; body: string; title: string; labels: string[]; state: "open" | "closed"; state_reason?: string; comments: string[] }[] = [];
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const html = (n: number) => `https://github.com/acme/web/issues/${n}`;
    if (url.pathname === "/search/issues") {
      const q = url.searchParams.get("q")!;
      const fp = /spotter-fingerprint:([a-z0-9]+)/.exec(q)![1]!;
      const items = issues.filter((i) => i.state === "open" && i.body.includes(`spotter-fingerprint:${fp}`));
      return Response.json({ items: items.map((i) => ({ number: i.number, html_url: html(i.number), state: i.state, body: i.body })) });
    }
    const m = /^\/repos\/acme\/web\/issues(?:\/(\d+))?(\/comments)?$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    if (!m[1] && method === "POST") {
      const issue = { number: issues.length + 1, body: body.body, title: body.title, labels: body.labels, state: "open" as const, comments: [] };
      issues.push(issue);
      return Response.json({ number: issue.number, html_url: html(issue.number), state: "open", body: issue.body }, { status: 201 });
    }
    const issue = issues.find((i) => i.number === Number(m[1]));
    if (!issue) return new Response("not found", { status: 404 });
    if (m[2] && method === "GET") return Response.json(issue.comments.map((c) => ({ body: c })));
    if (m[2] && method === "POST") {
      issue.comments.push(body.body);
      return Response.json({ id: 1 }, { status: 201 });
    }
    if (method === "PATCH") {
      Object.assign(issue, body);
      return Response.json({ number: issue.number, html_url: html(issue.number), state: issue.state });
    }
    return Response.json({ number: issue.number, html_url: html(issue.number), state: issue.state, body: issue.body });
  });
  return { issues, calls, fetch };
}

describe("github()", () => {
  it("opens an issue with repro steps, environment, errors, artifact links, labels and the fingerprint marker", async () => {
    const gh = fakeGitHub();
    const hook = github({ repo: "acme/web", token: "ghp_test", fetch: gh.fetch });
    const store = memoryDeliveryStore();
    const res = await runHooks(exampleReport(), [hook], { store, ...noSleep });
    expect(res.links).toEqual([{ hook: "github", externalId: "1", url: "https://github.com/acme/web/issues/1" }]);
    const issue = gh.issues[0]!;
    expect(issue.title).toBe("[SPT-4821] Pay button does nothing");
    expect(issue.labels).toEqual(["spotter", "bug", "sev:error"]);
    expect(issue.body).toContain("### Steps to reproduce\n1. clicked button \"Pay\" → POST /api/charge 502");
    expect(issue.body).toContain("| Browser | Chrome 129 |");
    expect(issue.body).toContain("PaymentError: provider returned 502");
    expect(issue.body).toContain("[Session replay](https://shop.example.com/api/spotter/v1/artifacts/rep_7f3a9c/replay.rrweb.json.gz");
    expect(issue.body).toContain("<!-- spotter-fingerprint:0a1b2c3d4e5f60 -->");
    expect(issue.body).not.toContain("ada@example.com");
  });

  it("comments on the open issue for a duplicate fingerprint, found via search", async () => {
    const gh = fakeGitHub();
    const hook = github({ repo: "acme/web", token: "ghp_test", fetch: gh.fetch, labels: (i) => [`area:${i.context.tags.area}`] });
    await runHooks(exampleReport(), [hook], noSleep); // no store: dedupe must come from search
    await runHooks(exampleReport({ id: "rep_2", ref: "SPT-4822" }), [hook], noSleep);
    await runHooks(exampleReport({ id: "rep_3", ref: "SPT-4823" }), [hook], noSleep);
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.labels).toEqual(["area:checkout"]);
    expect(gh.issues[0]!.comments[0]).toMatch(/^Another report \(2 affected users\): \*\*SPT-4822\*\*/);
    expect(gh.issues[0]!.comments[1]).toMatch(/^Another report \(3 affected users\)/);
    expect(gh.calls.filter((c) => c === "GET /search/issues")).toHaveLength(3);
  });

  it("uses the stored link first and opens a new issue once the old one is closed", async () => {
    const gh = fakeGitHub();
    const hook = github({ repo: "acme/web", token: "ghp_test", fetch: gh.fetch });
    const store = memoryDeliveryStore();
    await runHooks(exampleReport(), [hook], { store, ...noSleep });
    gh.issues[0]!.state = "closed";
    await runHooks(exampleReport({ id: "rep_2" }), [hook], { store, ...noSleep });
    expect(gh.issues).toHaveLength(2);
  });

  it("syncs status: resolved closes with a note, wont_fix closes not_planned, in_progress reopens", async () => {
    const gh = fakeGitHub();
    const hook = github({ repo: "acme/web", token: "ghp_test", fetch: gh.fetch });
    const store = memoryDeliveryStore();
    const issue = exampleReport();
    await runHooks(issue, [hook], { store, ...noSleep });
    const resolved = { ...issue, status: { public: "resolved" as const, history: [...issue.status.history, { status: "resolved" as const, at: "2026-09-25T00:00:00Z", message: "Fixed in v2.14, live now.", release: "2.14.1" }] } };
    await runStatusHooks(resolved, "resolved", [hook], { store, ...noSleep });
    expect(gh.issues[0]).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(gh.issues[0]!.comments[0]).toContain("Fixed in v2.14, live now.");
    await runStatusHooks(issue, "in_progress", [hook], { store, ...noSleep });
    expect(gh.issues[0]!.state).toBe("open");
    await runStatusHooks(issue, "wont_fix", [hook], { store, ...noSleep });
    expect(gh.issues[0]).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });

  it("maps GitHub webhooks back to Spotter status, verifying the signature", async () => {
    const onStatus = vi.fn();
    const handler = githubWebhookHandler({ secret: "whsec", onStatus });
    const payload = JSON.stringify({
      action: "closed",
      repository: { full_name: "acme/web" },
      issue: { number: 7, html_url: "https://github.com/acme/web/issues/7", body: "x\n<!-- spotter-fingerprint:abc123 -->\n<!-- spotter-issue:rep_1 -->", state_reason: "completed" },
    });
    const bad = await handler(new Request("https://x/hook", { method: "POST", body: payload, headers: { "x-github-event": "issues", "x-hub-signature-256": "sha256=00" } }));
    expect(bad.status).toBe(401);
    const sig = `sha256=${await hmacHex("whsec", payload)}`;
    const ok = await handler(new Request("https://x/hook", { method: "POST", body: payload, headers: { "x-github-event": "issues", "x-hub-signature-256": sig } }));
    expect(ok.status).toBe(200);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ externalId: "7", fingerprint: "abc123", issueId: "rep_1", status: "resolved" }));

    const pr = githubEventToUpdates("pull_request", {
      action: "closed",
      repository: { full_name: "acme/web" },
      pull_request: { merged: true, number: 12, html_url: "https://github.com/acme/web/pull/12", title: "Fix pay", body: "Fixes #7 and closes other/repo#9", milestone: { title: "v2.14.1" } },
    });
    expect(pr).toEqual([expect.objectContaining({ externalId: "7", status: "resolved", release: "v2.14.1", message: "Fixed in #12 (v2.14.1)." })]);
  });
});

describe("runHooks()", () => {
  it("applies when(), retries with backoff and records failed deliveries instead of dropping them", async () => {
    const store = memoryDeliveryStore();
    const waits: number[] = [];
    let attempts = 0;
    const flaky = defineHook({
      name: "flaky",
      retry: { attempts: 3, baseDelayMs: 100 },
      send: async () => {
        attempts++;
        if (attempts < 3) throw new Error("503");
        return { externalId: "L-1", url: "https://linear.test/L-1" };
      },
    });
    const broken = defineHook({ name: "broken", retry: { attempts: 2, baseDelayMs: 10 }, send: async () => Promise.reject(new Error("boom")) });
    const skipped = defineHook({ name: "skipped", when: (i) => i.content.severity === "critical", send: vi.fn() });
    const res = await runHooks(exampleReport(), [flaky, broken, skipped], { store, sleep: async (ms) => void waits.push(ms) });
    expect(res.deliveries.map((d) => [d.hook, d.state, d.attempts])).toEqual([
      ["flaky", "delivered", 3],
      ["broken", "failed", 2],
      ["skipped", "skipped", 0],
    ]);
    expect(waits.filter((w) => w >= 50).length).toBeGreaterThanOrEqual(2);
    const failed = await store.list({ state: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe("boom");
    expect((await store.issueFor(failed[0]!.id))!.id).toBe("rep_7f3a9c");
    expect(skipped.send).not.toHaveBeenCalled();
  });

  it("refuses to run in a browser", async () => {
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { document?: unknown }).document = {};
    try {
      await expect(runHooks(exampleReport(), [])).rejects.toThrow(/server-side only/);
    } finally {
      delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it("rejects duplicate hook names", async () => {
    const h = defineHook({ name: "x", send: async () => {} });
    await expect(runHooks(exampleReport(), [h, h])).rejects.toThrow(/unique/);
  });
});

describe("dispatcher()", () => {
  it("forwards the full issue with artifacts to the hosted ingest and returns Console's id", async () => {
    const calls: { method: string; url: string; auth?: string; body?: unknown }[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url.includes("/v1/artifacts/")) return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.endsWith("/v1/reports")) return Response.json({ id: "con_1", ref: "SPT-9000", url: "https://console.test/r/con_1", token: "t", uploads: [] }, { status: 201 });
      if (method === "PUT") return new Response(null, { status: 204, headers: { "upload-offset": new URL(url).searchParams.get("total")! } });
      return Response.json({ ok: true });
    });
    const hook = dispatcher({ endpoint: "https://console.test/hooks/spotter", secretKey: "sk_test_abcdefgh", fetch });
    expect(hook[DISPATCHER_INGEST].configured).toBe(true);
    const issue = exampleReport({ artifacts: [exampleReport().artifacts[0]!] });
    const res = await runHooks(issue, [hook], noSleep);
    expect(res.links[0]).toEqual({ hook: "dispatcher", externalId: "con_1", url: "https://console.test/r/con_1" });
    const submit = calls.find((c) => c.url.endsWith("/v1/reports"))!;
    expect(submit.auth).toBe("Bearer sk_test_abcdefgh");
    expect(submit.body).toMatchObject({ clientId: "rep_7f3a9c", timeline: issue.timeline, artifacts: [{ name: "screenshot.png", size: 4 }] });
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/v1/reports/con_1/artifacts/screenshot.png"))).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://console.test/hooks/spotter/v1/reports/con_1/complete");
  });

  it("fails fast (recorded) without a secret key", async () => {
    const store = memoryDeliveryStore();
    const res = await runHooks(exampleReport(), [dispatcher({ endpoint: "https://console.test", secretKey: "" })], { store, ...noSleep });
    expect(res.deliveries[0]).toMatchObject({ state: "failed", attempts: 1 });
  });
});
