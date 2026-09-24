import { describe, expect, it, vi } from "vitest";
import { createHttpTransport } from "../../src/core/transport/http.ts";
import { backoffDelay, HttpError, isRetryable, parseRetryAfter, withRetry } from "../../src/core/transport/retry.ts";
import { createQueue, memoryQueue } from "../../src/core/transport/queue.ts";
import { drainQueue, uploadAndComplete } from "../../src/core/transport/deliver.ts";
import { createTestTransport } from "../../src/core/testing.ts";
import type { ReportReceipt, ReportSubmission } from "../../src/core/schema.ts";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("retry", () => {
  it("backs off exponentially with jitter, capped", () => {
    expect(backoffDelay(0, 100, 10_000, () => 0)).toBe(50);
    expect(backoffDelay(0, 100, 10_000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 10_000, () => 1)).toBe(800);
    expect(backoffDelay(20, 100, 1000, () => 1)).toBe(1000);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("retries network errors, 5xx and 429 — not other 4xx", async () => {
    expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryable(new HttpError(503, "x"))).toBe(true);
    expect(isRetryable(new HttpError(429, "x"))).toBe(true);
    expect(isRetryable(new HttpError(422, "x"))).toBe(false);
    let n = 0;
    await expect(withRetry(async () => ++n && Promise.reject(new HttpError(400, "bad")), noSleep)).rejects.toThrow("bad");
    expect(n).toBe(1);
    n = 0;
    const out = await withRetry(async () => (++n < 3 ? Promise.reject(new TypeError("net")) : "ok"), noSleep);
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("honours Retry-After as the delay", async () => {
    const waits: number[] = [];
    let n = 0;
    await withRetry(async () => (++n === 1 ? Promise.reject(new HttpError(429, "slow", undefined, 2000)) : 1), {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([2000]);
  });
});

/** A fake ingest implementing the upload endpoints, with a switch to fail chunks. */
function fakeIngest(opts: { failPutAt?: number[] } = {}) {
  const stored = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let putCount = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://ingest.test");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const key = url.pathname;
    if (method === "POST" && url.pathname === "/api/spotter/v1/reports") {
      const r: ReportReceipt = { id: "r1", ref: "SPT-1", token: "tok", uploads: [{ name: "big.bin", url: "/v1/reports/r1/artifacts/big.bin" }] };
      return Response.json(r, { status: 201 });
    }
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "upload-offset": String(stored.get(key)?.byteLength ?? 0) } });
    if (method === "PUT") {
      putCount++;
      const offset = Number(url.searchParams.get("offset"));
      const cur = stored.get(key) ?? new Uint8Array();
      const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      if (offset !== cur.byteLength) return new Response(null, { status: 409, headers: { "upload-offset": String(cur.byteLength) } });
      const next = new Uint8Array(cur.byteLength + body.byteLength);
      next.set(cur);
      next.set(body, cur.byteLength);
      stored.set(key, next);
      // the chunk landed but the response is lost: the client must resync via HEAD
      if (opts.failPutAt?.includes(putCount)) throw new TypeError("connection reset");
      return new Response(null, { status: 204, headers: { "upload-offset": String(next.byteLength) } });
    }
    if (method === "POST" && url.pathname.endsWith("/complete")) return Response.json({ ok: true });
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, stored, calls };
}

describe("http transport", () => {
  it("sends the public key header and JSON on submit", async () => {
    const seen: RequestInit[] = [];
    const t = createHttpTransport({
      endpoint: "http://ingest.test/api/spotter/",
      project: "pk_test_12345678",
      fetch: async (_u, init) => {
        seen.push(init!);
        return Response.json({ id: "a", ref: "SPT-1", token: "t", uploads: [] }, { status: 201 });
      },
    });
    const r = await t.submit({ clientId: "c" } as ReportSubmission);
    expect(r.ref).toBe("SPT-1");
    expect((seen[0]!.headers as Record<string, string>)["x-spotter-key"]).toBe("pk_test_12345678");
    expect((seen[0]!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("uses a bearer secret key on the server", async () => {
    let auth = "";
    const t = createHttpTransport({
      endpoint: "https://console.test/hooks/spotter",
      secretKey: "sk_test_abcdefgh",
      fetch: async (_u, init) => {
        auth = (init!.headers as Record<string, string>).authorization ?? "";
        return Response.json({ accepted: 1, promoted: [] });
      },
    });
    await t.flags({ flags: [], sdk: { name: "@trusplex/spotter", version: "0", features: [] } });
    expect(auth).toBe("Bearer sk_test_abcdefgh");
  });

  it("uploads in chunks and resumes from the server's offset after a lost response", async () => {
    const ingest = fakeIngest({ failPutAt: [2] });
    const t = createHttpTransport({ endpoint: "http://ingest.test/api/spotter", fetch: ingest.fetchImpl, chunkSize: 16 * 1024, retry: noSleep });
    const receipt = await t.submit({ clientId: "c" } as ReportSubmission);
    const data = new Uint8Array(40 * 1024).map((_, i) => i % 251);
    await t.upload(receipt, "big.bin", data, "application/octet-stream");
    const got = ingest.stored.get("/api/spotter/v1/reports/r1/artifacts/big.bin")!;
    expect(got.byteLength).toBe(data.byteLength);
    expect(Buffer.from(got).equals(Buffer.from(data))).toBe(true);
    // chunk 2 landed but its response was lost → HEAD resync, no duplicate bytes
    expect(ingest.calls.some((c) => c.startsWith("HEAD"))).toBe(true);
    expect(ingest.calls.filter((c) => c.startsWith("PUT")).map((c) => /offset=(\d+)/.exec(c)![1])).toEqual(["0", "16384", "32768"]);
  });

  it("sends analytics as a simple request (text/plain, key in body) and prefers sendBeacon on hide", async () => {
    const beacons: { url: string; body: string; type: string }[] = [];
    let fetched: RequestInit | undefined;
    const t = createHttpTransport({
      endpoint: "/api/spotter",
      project: "pk_test_12345678",
      sendBeacon: (url, blob) => {
        void blob.text().then((body) => beacons.push({ url, body, type: blob.type }));
        return true;
      },
      fetch: async (_u, init) => {
        fetched = init;
        return new Response(null, { status: 202 });
      },
    });
    const batch = { events: [], sdk: { name: "@trusplex/spotter" as const, version: "0", features: [] } };
    await t.events(batch, { beacon: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(beacons[0]!.url).toBe("/api/spotter/v1/events");
    expect(beacons[0]!.type).toBe("text/plain");
    expect(JSON.parse(beacons[0]!.body).key).toBe("pk_test_12345678");
    await t.events(batch);
    expect(fetched!.headers).toEqual({ "content-type": "text/plain" });
    expect(fetched!.keepalive).toBe(true);
  });
});

describe("offline queue", () => {
  it("falls back to memory when IndexedDB fails", async () => {
    const broken = {
      open() {
        throw new Error("SecurityError");
      },
    } as unknown as IDBFactory;
    const q = createQueue(broken);
    await q.put({ kind: "flags", id: "f1", at: Date.now(), attempts: 0, batch: { flags: [], sdk: { name: "@trusplex/spotter", version: "0", features: [] } } });
    expect(q.backend).toBe("memory");
    expect((await q.all()).map((i) => i.id)).toEqual(["f1"]);
  });

  it("drains in order, maps pending receipts, and stops at the first retryable failure", async () => {
    const q = memoryQueue();
    const t = createTestTransport();
    const sub = (id: string) => ({ clientId: id, artifacts: [{ name: "a.txt", kind: "attachment", contentType: "text/plain", size: 2 }], content: { title: id } }) as unknown as ReportSubmission;
    await q.put({ kind: "report", id: "pending_1", at: Date.now() - 2, attempts: 0, submission: sub("1"), artifacts: [{ name: "a.txt", contentType: "text/plain", data: new Uint8Array([1, 2]) }] });
    await q.put({ kind: "report", id: "pending_2", at: Date.now() - 1, attempts: 0, submission: sub("2"), artifacts: [] });
    t.failNext("submit", 1);
    const delivered = vi.fn();
    expect(await drainQueue(q, t, { delivered })).toBe(0);
    expect((await q.all()).length).toBe(2);
    expect(await drainQueue(q, t, { delivered })).toBe(2);
    expect(delivered).toHaveBeenCalledWith("pending_1", expect.objectContaining({ ref: "SPT-TEST-1" }));
    expect(t.uploads[0]!.name).toBe("a.txt");
    expect(t.completed).toContain("test_1");
    expect(await q.all()).toEqual([]);
  });

  it("re-queues artifacts whose upload fails and completes once they land", async () => {
    const q = memoryQueue();
    const t = createTestTransport();
    const receipt = await t.submit({ clientId: "x", artifacts: [], content: { title: "x" } } as unknown as ReportSubmission);
    t.failNext("upload", 1);
    const ok = await uploadAndComplete(t, receipt, [{ name: "s.png", contentType: "image/png", data: new Uint8Array(3) }], q);
    expect(ok).toBe(false);
    expect(t.completed).toEqual([]);
    expect((await q.all())[0]!.kind).toBe("upload");
    await drainQueue(q, t);
    expect(t.uploads.map((u) => u.name)).toEqual(["s.png"]);
    expect(t.completed).toEqual([receipt.id]);
  });
});
