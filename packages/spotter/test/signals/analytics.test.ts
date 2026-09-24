// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleBucket, startAnalytics, type AnalyticsController } from "../../src/core/analytics/index.ts";
import { channelFor } from "../../src/core/analytics/channels.ts";
import type { AnalyticsEvent } from "../../src/core/schema.ts";
import { setUrl, testRuntime, type TestRuntime } from "./helpers.ts";

let rt: TestRuntime;
let sent: { events: AnalyticsEvent[]; beacon: boolean }[];
let ctl: AnalyticsController | null;
const send = (events: AnalyticsEvent[], opts: { beacon: boolean }) => sent.push({ events, beacon: opts.beacon });
const all = () => sent.flatMap((s) => s.events);

beforeEach(() => {
  vi.useFakeTimers();
  setUrl("https://shop.example.com/landing?utm_source=google&utm_medium=cpc&gclid=abc123&token=t");
  sessionStorage.clear();
  document.cookie = "_spotter_vid=; Max-Age=0; Path=/";
  document.head.innerHTML = "<title>Landing</title>";
  document.body.innerHTML = "";
  rt = testRuntime();
  sent = [];
  ctl = null;
});
afterEach(() => {
  ctl?.destroy();
  vi.useRealTimers();
});

describe("startAnalytics", () => {
  it("sends a pageview on start with sources, cookielessly, batched after 5 s", () => {
    Object.defineProperty(document, "referrer", { value: "https://www.google.com/search?q=shoes", configurable: true });
    ctl = startAnalytics(rt, {}, send);
    vi.advanceTimersByTime(150); // title / 404 check
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(5000);
    const [pv] = all();
    expect(pv).toMatchObject({
      type: "pageview",
      url: "https://shop.example.com/landing?utm_source=google&utm_medium=cpc&gclid=abc123&token=[redacted]",
      title: "Landing",
      referrer: "https://www.google.com/search?q=shoes",
      utm: { source: "google", medium: "cpc" },
      clickIds: ["gclid"],
      release: { version: "1.2.3" },
    });
    expect(pv?.pageviewId).toBeTruthy();
    expect(pv?.sessionId).toBeTruthy();
    expect(pv?.visitorId).toBeUndefined();
    expect(document.cookie).not.toContain("_spotter_vid");
    expect(localStorage.length).toBe(0);
    expect(sent[0]?.beacon).toBe(false);
  });

  it("drops internal referrers and dedupes repeated pageviews for the same URL", () => {
    Object.defineProperty(document, "referrer", { value: "https://shop.example.com/prev", configurable: true });
    ctl = startAnalytics(rt, {}, send);
    ctl.pageview(); // the client's navigated('load') → same URL
    ctl.pageview(`${location.href}#section`); // hash-only
    ctl.flush();
    const pvs = all().filter((e) => e.type === "pageview");
    expect(pvs).toHaveLength(1);
    expect(pvs[0]?.referrer).toBeUndefined();
  });

  it("closes the previous page with engagement (visible time, scroll) and vitals on SPA navigation", () => {
    let vitalsCb: ((v: { lcp?: number; cls?: number }) => void) | undefined;
    const perf = { onVitals: (cb: (v: { lcp?: number; cls?: number }) => void) => ((vitalsCb = cb), () => {}) };
    ctl = startAnalytics(rt, {}, send, perf);
    vitalsCb?.({ lcp: 1200, cls: 0.02 });
    rt.clock.t += 4000;
    history.pushState({}, "", "/products/1");
    ctl.pageview();
    ctl.flush();
    const events = all();
    expect(events.map((e) => e.type)).toEqual(["pageview", "engagement", "vitals", "pageview"]);
    const [first, eng, vit, second] = events;
    expect(eng?.pageviewId).toBe(first?.pageviewId);
    expect(eng?.engagedMs).toBe(4000);
    expect(vit).toMatchObject({ vitals: { lcp: 1200, cls: 0.02 }, pageviewId: first?.pageviewId });
    expect(second?.pageviewId).not.toBe(first?.pageviewId);
    expect(second?.referrer).toBeUndefined();
    expect(second?.url).toBe("https://shop.example.com/products/1");
  });

  it("only counts visible time and flushes by beacon on hide", () => {
    ctl = startAnalytics(rt, {}, send);
    rt.clock.t += 1000;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sent.at(-1)?.beacon).toBe(true);
    const eng = all().find((e) => e.type === "engagement");
    expect(eng?.engagedMs).toBe(1000);
    rt.clock.t += 60_000; // hidden: doesn't count
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    rt.clock.t += 500;
    window.dispatchEvent(new Event("pagehide"));
    const engs = all().filter((e) => e.type === "engagement");
    expect(engs.map((e) => e.engagedMs)).toEqual([1000, 500]); // deltas
  });

  it("flushes at 20 events", () => {
    ctl = startAnalytics(rt, {}, send);
    for (let i = 0; i < 19; i++) ctl.track(`e${i}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(20);
  });

  it("tracks custom events with sanitized props and revenue", () => {
    ctl = startAnalytics(rt, {}, send);
    ctl.track("signup_completed", { plan: "pro", email: "a@b.co", n: 2, bad: Number.NaN, obj: {} as unknown as string }, { value: 49, currency: "usd" });
    ctl.flush();
    const e = all().find((x) => x.name === "signup_completed");
    expect(e).toMatchObject({ type: "event", props: { plan: "pro", email: "[redacted:email]", n: 2 }, revenue: { value: 49, currency: "USD" } });
    expect(e?.props).not.toHaveProperty("bad");
    expect(e?.props).not.toHaveProperty("obj");
  });

  it("records outbound links, downloads and form submits automatically", () => {
    document.body.innerHTML = `<a id="out" href="https://other.org/page?x=1">o</a><a id="dl" href="/files/report.pdf">d</a><a id="in" href="/about">i</a><form id="signup"></form>`;
    ctl = startAnalytics(rt, {}, send);
    // happy-dom follows synthetic link clicks even when prevented: put the page back after each.
    const here = location.href;
    for (const id of ["out", "dl", "in"]) {
      document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      setUrl(here);
    }
    document.getElementById("signup")!.dispatchEvent(new Event("submit", { bubbles: true }));
    ctl.flush();
    const names = all().filter((e) => e.type === "event").map((e) => [e.name, e.props]);
    expect(names).toEqual([
      ["outbound", { url: "https://other.org/page" }],
      ["download", { url: "https://shop.example.com/files/report.pdf" }],
      ["form_submit", { form: "signup" }],
    ]);
  });

  it("reports 404 only from explicit config or the meta tag", () => {
    document.head.innerHTML = `<title>404 Not Found</title>`;
    ctl = startAnalytics(rt, {}, send);
    vi.advanceTimersByTime(150);
    ctl.flush();
    expect(all().some((e) => e.name === "404")).toBe(false); // title heuristics are not allowed
    ctl.destroy();
    sent = [];
    document.head.innerHTML = `<meta name="spotter:status" content="404">`;
    setUrl("https://shop.example.com/missing");
    ctl = startAnalytics(rt, {}, send);
    vi.advanceTimersByTime(150);
    ctl.flush();
    expect(all().find((e) => e.name === "404")?.props).toEqual({ path: "/missing" });
    ctl.destroy();
    sent = [];
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="not-found"></div>`;
    ctl = startAnalytics(rt, { notFound: ".not-found" }, send);
    vi.advanceTimersByTime(150);
    ctl.flush();
    expect(all().some((e) => e.name === "404")).toBe(true);
  });

  it("counts JS errors per page, capped", () => {
    ctl = startAnalytics(rt, {}, send);
    for (let i = 0; i < 15; i++) ctl.noteError({ type: "TypeError", message: `x for a@b.co ${i}` });
    ctl.flush();
    const errs = all().filter((e) => e.name === "js_error");
    expect(errs).toHaveLength(10);
    expect(errs[0]?.props).toEqual({ type: "TypeError", message: "x for [redacted:email] 0" });
  });

  it("sends nothing without analytics consent, or with GPC / DNT honoured", () => {
    rt.consentState = { analytics: false };
    ctl = startAnalytics(rt, {}, send);
    ctl.track("x");
    ctl.flush();
    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toEqual([]);
    ctl.destroy();

    rt.consentState = {};
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    ctl = startAnalytics(rt, { honorGpc: true }, send);
    ctl.flush();
    expect(sent).toEqual([]);
    ctl.destroy();
    ctl = startAnalytics(rt, { honorGpc: false }, send);
    ctl.flush();
    expect(sent.length).toBe(1);
    ctl.destroy();
    Object.defineProperty(navigator, "globalPrivacyControl", { value: undefined, configurable: true });

    sent = [];
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    ctl = startAnalytics(rt, { honorDnt: true }, send);
    ctl.flush();
    expect(sent).toEqual([]);
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true });
  });

  it("drops the queue if consent is withdrawn before flush", () => {
    ctl = startAnalytics(rt, {}, send);
    rt.consentState = { analytics: false };
    vi.advanceTimersByTime(6000);
    expect(sent).toEqual([]);
  });

  it("links userId only with identify: true AND consent", () => {
    rt.identityValue = { id: "u_1" };
    ctl = startAnalytics(rt, { identify: true }, send);
    ctl.flush();
    expect(all()[0]?.userId).toBeUndefined(); // consent not given
    ctl.destroy();
    sent = [];
    rt.consentState = { analytics: true };
    ctl = startAnalytics(rt, { identify: true }, send);
    ctl.flush();
    expect(all()[0]?.userId).toBe("u_1");
    ctl.destroy();
    sent = [];
    ctl = startAnalytics(rt, { identify: false }, send);
    ctl.flush();
    expect(all()[0]?.userId).toBeUndefined();
  });

  it("cookie mode sets a first-party visitor cookie and sends visitorId", () => {
    ctl = startAnalytics(rt, { mode: "cookie" }, send);
    ctl.flush();
    const vid = all()[0]?.visitorId;
    expect(vid).toBeTruthy();
    expect(document.cookie).toContain(`_spotter_vid=${vid}`);
    ctl.destroy();
    sent = [];
    ctl = startAnalytics(rt, { mode: "cookie" }, send);
    ctl.flush();
    expect(all()[0]?.visitorId).toBe(vid);
  });

  it("samples per session deterministically", () => {
    ctl = startAnalytics(rt, { sampleRate: 0 }, send);
    ctl.flush();
    expect(sent).toEqual([]);
    expect(sampleBucket("abc")).toBe(sampleBucket("abc"));
    const buckets = Array.from({ length: 1000 }, (_, i) => sampleBucket(`s${i}`));
    const under = buckets.filter((b) => b < 0.5).length;
    expect(under).toBeGreaterThan(400);
    expect(under).toBeLessThan(600);
  });

  it("stops listening on destroy", () => {
    document.body.innerHTML = `<a id="out" href="https://other.org/">o</a>`;
    ctl = startAnalytics(rt, {}, send);
    ctl.destroy();
    const before = all().length;
    document.getElementById("out")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    ctl.track("late");
    vi.advanceTimersByTime(6000);
    expect(all().length).toBe(before);
    ctl = null;
  });
});

describe("channelFor", () => {
  it.each([
    ["https://www.google.com/", undefined, [], "search"],
    ["https://duckduckgo.com/", undefined, [], "search"],
    ["https://t.co/abc", undefined, [], "social"],
    ["https://www.linkedin.com/feed", undefined, [], "social"],
    ["https://l.facebook.com/l.php", undefined, ["fbclid"], "social"],
    ["", undefined, ["gclid"], "paid"],
    ["https://www.google.com/", { medium: "cpc" }, [], "paid"],
    ["", { source: "newsletter", medium: "email" }, [], "email"],
    ["https://mail.google.com/", undefined, [], "email"],
    ["", undefined, [], "direct"],
    [null, null, null, "direct"],
    ["https://someblog.dev/post", undefined, [], "referral"],
    ["", { source: "partner-site" }, [], "referral"],
    ["", { medium: "social" }, [], "social"],
    ["", { medium: "organic", source: "google" }, [], "search"],
  ] as const)("%s %j %j → %s", (ref, utm, ids, expected) => {
    expect(channelFor(ref, utm as never, ids as never)).toBe(expected);
  });
});
