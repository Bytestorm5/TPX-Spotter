import { describe, expect, it } from "vitest";
import { buildTimeline, reproSteps, TIMELINE_MAX_LINES } from "../../src/core/timeline.ts";
import { deriveFingerprint, errorFingerprint, hash, normalizeFile, normalizePath, pageFingerprint } from "../../src/core/fingerprint.ts";
import type { Breadcrumb, ErrorEntry, HarEntry } from "../../src/core/schema.ts";

const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function har(method: string, url: string, status: number, startMs: number, time = 100): HarEntry {
  return {
    startedDateTime: at(startMs),
    time,
    request: { method, url, httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
    response: { status, statusText: "", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: 0 },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
  };
}

describe("buildTimeline", () => {
  it("merges steps in time order with consequences on the same line", () => {
    const breadcrumbs: Breadcrumb[] = [
      { at: at(1000), category: "click", message: 'button "Pay"' },
      { at: at(200), category: "focus", message: "input#email" },
    ];
    const errors: ErrorEntry[] = [{ at: at(1500), type: "PaymentError", message: "card declined", frames: [], mechanism: "uncaught" }];
    const lines = buildTimeline(
      {
        breadcrumbs,
        navigation: [{ at: at(0), to: "https://shop.test/checkout", kind: "load" }],
        network: { log: { version: "1.2", creator: { name: "x", version: "1" }, entries: [har("GET", "https://shop.test/api/cart", 200, 100), har("POST", "https://shop.test/api/charge", 502, 1100)] } },
        errors,
      },
      T0 + 5000,
    );
    expect(lines[0]).toMatch(/^\[-5\.0s\] opened \/checkout$/);
    expect(lines[1]).toBe('[-4.0s] clicked button "Pay" → POST /api/charge 502 → error: PaymentError: card declined');
    expect(lines[lines.length - 1]).toMatch(/report filed$/);
    // successful GETs and focus changes are noise for repro
    expect(lines.join("\n")).not.toContain("/api/cart");
    expect(lines.join("\n")).not.toContain("input#email");
  });

  it("collapses repeated clicks and caps the length", () => {
    const crumbs: Breadcrumb[] = [];
    for (let i = 0; i < 3; i++) crumbs.push({ at: at(i * 10), category: "click", message: "Save" });
    for (let i = 0; i < 80; i++) crumbs.push({ at: at(1000 + i * 100), category: "custom", message: `step ${i}` });
    const lines = buildTimeline({ breadcrumbs: crumbs }, T0 + 20_000);
    expect(lines.length).toBe(TIMELINE_MAX_LINES);
    expect(lines[0]).toMatch(/^… \d+ earlier steps$/);
    const short = buildTimeline({ breadcrumbs: crumbs.slice(0, 3) }, T0 + 1000);
    expect(short[0]).toContain("clicked Save (×3)");
  });

  it("renders numbered repro steps without offsets", () => {
    expect(reproSteps(["[-3.0s] clicked Pay", "[-0.0s] report filed"])).toBe("1. clicked Pay\n2. report filed");
  });
});

describe("fingerprint", () => {
  it("hashes synchronously and stably", () => {
    expect(hash("abc")).toBe(hash("abc"));
    expect(hash("abc")).not.toBe(hash("abd"));
    expect(hash("abc")).toMatch(/^[0-9a-f]{14}$/);
  });

  it("groups errors by type and top frame, ignoring line numbers and build hashes", () => {
    const a = errorFingerprint({ type: "TypeError", message: "x is undefined (id 42)", frames: [{ function: "pay", file: "https://a.test/_next/static/chunks/page-1a2b3c4d.js", line: 10, column: 3 }] });
    const b = errorFingerprint({ type: "TypeError", message: "x is undefined (id 43)", frames: [{ function: "pay", file: "https://b.test/_next/static/chunks/page-9f8e7d6c.js", line: 99, column: 1 }] });
    expect(a).toBe(b);
    expect(normalizeFile("https://x/app/main.1a2b3c4d.js?v=1")).toBe("/app/main.js");
  });

  it("uses route + selector + category for non-error reports", () => {
    expect(normalizePath("/orders/1234/items/550e8400-e29b-41d4-a716-446655440000")).toBe("/orders/:id/items/:id");
    const a = pageFingerprint({ url: "https://a.test/orders/1?x=1", selector: "#pay", category: "bug" });
    const b = pageFingerprint({ url: "https://a.test/orders/2", selector: "#pay", category: "bug" });
    expect(a).toBe(b);
    expect(pageFingerprint({ routePattern: "/orders/[id]", selector: "#pay", category: "ux" })).not.toBe(a);
    const err = { type: "E", message: "m", frames: [] };
    expect(deriveFingerprint({ source: "error", error: err, page: { url: "/" } })).toBe(errorFingerprint(err));
    expect(deriveFingerprint({ source: "widget", error: err, page: { url: "/" }, category: "bug" })).toBe(pageFingerprint({ url: "/", category: "bug" }));
  });
});

describe("sdk version", () => {
  it("matches package.json", async () => {
    const { SDK_VERSION } = await import("../../src/core/ids.ts");
    const pkg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
