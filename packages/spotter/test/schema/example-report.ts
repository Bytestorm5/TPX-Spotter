import type { ReportSubmission, SpotterReportV1 } from "../../src/core/schema.ts";

/** A realistic `spotter.report.v1` ticket, used by the schema, hooks and server tests. */
export function exampleReport(overrides: Partial<SpotterReportV1> = {}): SpotterReportV1 {
  return {
    schema: "spotter.report.v1",
    id: "rep_7f3a9c",
    ref: "SPT-4821",
    createdAt: "2026-09-24T10:00:05.000Z",
    source: "widget",
    test: false,
    fingerprint: "0a1b2c3d4e5f60",
    reporter: { id: "u_1", email: "ada@example.com", name: "Ada", traits: { plan: "pro" }, type: "public", contact: "email" },
    content: {
      title: "Pay button does nothing",
      description: "I clicked Pay twice and nothing happened.",
      expected: "Order confirmation",
      category: "bug",
      severity: "error",
      fields: { order_number: "A-1001", rating: 2, tags: ["checkout"], urgent: true, note: null },
      annotations: [
        { tool: "rect", points: [{ x: 10, y: 20 }, { x: 110, y: 60 }], color: "#e11d48" },
        { tool: "pin", points: [{ x: 50, y: 40 }], label: "1" },
      ],
    },
    page: {
      url: "https://shop.example.com/checkout",
      routePattern: "/checkout",
      title: "Checkout",
      referrer: "https://shop.example.com/cart",
      selector: "#pay",
      domExcerpt: '<button id="pay">Pay</button>',
      nearbyText: "Total €42.00 Pay",
      history: ["https://shop.example.com/cart", "https://shop.example.com/checkout"],
    },
    environment: {
      runtime: "browser",
      userAgent: "Mozilla/5.0",
      browser: { name: "Chrome", version: "129" },
      os: { name: "macOS", version: "15" },
      device: "desktop",
      viewport: { width: 1440, height: 900 },
      screen: { width: 1440, height: 900 },
      dpr: 2,
      locale: "en-GB",
      timeZone: "Europe/London",
      colorScheme: "light",
      reducedMotion: false,
      network: { online: true, effectiveType: "4g", downlink: 10, rtt: 50 },
    },
    release: { version: "2.14.0", commit: "abc1234def", deployId: "dpl_1", environment: "production" },
    context: { tags: { area: "checkout" }, contexts: { cart: { items: 2, total: 42 } }, flags: { newCheckout: true } },
    signals: {
      console: [{ level: "error", at: "2026-09-24T10:00:03.000Z", args: ["Payment failed", { code: 502 }], stack: "Error\n    at pay (app.js:1:1)" }],
      errors: [
        {
          at: "2026-09-24T10:00:03.100Z",
          type: "PaymentError",
          message: "provider returned 502",
          stack: "PaymentError: provider returned 502\n    at pay (https://shop.example.com/app.js:10:5)",
          frames: [{ function: "pay", file: "https://shop.example.com/app.js", line: 10, column: 5 }],
          mechanism: "unhandledrejection",
        },
      ],
      network: {
        log: {
          version: "1.2",
          creator: { name: "@trusplex/spotter", version: "0.1.0" },
          entries: [
            {
              startedDateTime: "2026-09-24T10:00:02.900Z",
              time: 180,
              request: { method: "POST", url: "https://shop.example.com/api/charge", httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 64 },
              response: { status: 502, statusText: "Bad Gateway", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 20, mimeType: "application/json" }, redirectURL: "", headersSize: -1, bodySize: 20 },
              cache: {},
              timings: { send: 1, wait: 170, receive: 9 },
              _initiator: "fetch",
              _traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            },
          ],
        },
      },
      breadcrumbs: [{ at: "2026-09-24T10:00:02.800Z", category: "click", message: 'button "Pay"', selector: "#pay", level: "info" }],
      navigation: [{ at: "2026-09-24T09:59:50.000Z", to: "https://shop.example.com/checkout", from: "https://shop.example.com/cart", kind: "push", routePattern: "/checkout" }],
      performance: { lcp: 1200, inp: 80, cls: 0.01, ttfb: 90, fcp: 600, longTasks: [{ at: "2026-09-24T10:00:01.000Z", duration: 70 }], slowResources: [] },
      storage: { localStorage: [{ key: "theme" }], sessionStorage: [], cookies: [{ key: "session" }] },
    },
    artifacts: [
      { name: "screenshot.png", kind: "screenshot", contentType: "image/png", size: 4, url: "https://shop.example.com/api/spotter/v1/artifacts/rep_7f3a9c/screenshot.png?exp=1&sig=x", state: "stored" },
      { name: "replay.rrweb.json.gz", kind: "replay", contentType: "application/x-rrweb+gzip", size: 3, startedAt: "2026-09-24T09:59:05.000Z", endedAt: "2026-09-24T10:00:05.000Z", url: "https://shop.example.com/api/spotter/v1/artifacts/rep_7f3a9c/replay.rrweb.json.gz?exp=1&sig=y", state: "stored" },
    ],
    trace: { traceparents: ["00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"], sessionId: "a1b2c3", serverEvents: [{ at: "2026-09-24T10:00:03.000Z", kind: "error", message: "upstream 502" }] },
    timeline: ['[-3.0s] clicked button "Pay" → POST /api/charge 502 → error: PaymentError: provider returned 502', "[-0.0s] report filed"],
    status: { public: "received", history: [{ status: "received", at: "2026-09-24T10:00:05.000Z" }] },
    sdk: { name: "@trusplex/spotter", version: "0.1.0", features: ["widget", "screenshot", "replay"] },
    ...overrides,
  };
}

/** The same report as the SDK would submit it (before the ingest assigns id/ref/status/urls). */
export function exampleSubmission(overrides: Partial<ReportSubmission> = {}): ReportSubmission {
  const { id: _id, ref: _ref, status: _status, artifacts, ...rest } = exampleReport();
  return {
    ...rest,
    clientId: `c_${Math.random().toString(36).slice(2)}`,
    artifacts: artifacts.map(({ url: _u, state: _s, ...a }) => a),
    ...overrides,
  };
}
