// Runs in plain Node: every signal module must import and behave without a DOM.
import { describe, expect, it } from "vitest";
import { collectEnvironment, detectRuntime, parseUserAgent } from "../../src/core/capture/environment.ts";
import { installConsole } from "../../src/core/capture/console.ts";
import { installErrors } from "../../src/core/capture/errors.ts";
import { installNetwork } from "../../src/core/capture/network.ts";
import { installNavigation } from "../../src/core/capture/navigation.ts";
import { installActions } from "../../src/core/capture/actions.ts";
import { installPerformance, clsFromShifts, inpFromDurations } from "../../src/core/capture/performance.ts";
import { collectStorage } from "../../src/core/capture/storage.ts";
import { collectPage, domSnapshot } from "../../src/core/capture/page.ts";
import { testRuntime } from "./helpers.ts";

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.99 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

describe("parseUserAgent", () => {
  const cases: [keyof typeof UA, string, string | undefined, string, string | undefined, string][] = [
    ["chromeWin", "Chrome", "128.0", "Windows", "10", "desktop"],
    ["edge", "Edge", "128.0", "Windows", "10", "desktop"],
    ["firefoxMac", "Firefox", "130.0", "macOS", "14.6", "desktop"],
    ["safariMac", "Safari", "17.6", "macOS", "10.15.7", "desktop"],
    ["iphone", "Safari", "17.6", "iOS", "17.6", "mobile"],
    ["chromeIos", "Chrome", "128.0", "iOS", "17.6", "mobile"],
    ["ipad", "Safari", "16.6", "iPadOS", "16.7", "tablet"],
    ["androidChrome", "Chrome", "128.0", "Android", "14", "mobile"],
    ["androidTablet", "Chrome", "128.0", "Android", "13", "tablet"],
    ["samsung", "Samsung Internet", "25.0", "Android", "14", "mobile"],
    ["opera", "Opera", "113.0", "Windows", "10", "desktop"],
    ["linuxFirefox", "Firefox", "130.0", "Linux", undefined, "desktop"],
    ["chromeOs", "Chrome", "128.0", "ChromeOS", undefined, "desktop"],
  ];
  for (const [key, browser, bv, os, ov, device] of cases) {
    it(key, () => {
      const p = parseUserAgent(UA[key]);
      expect(p.browser).toEqual(bv ? { name: browser, version: bv } : { name: browser });
      expect(p.os?.name).toBe(os);
      expect(p.os?.version).toBe(ov);
      expect(p.device).toBe(device);
    });
  }

  it("detects iPadOS desktop mode via touch points", () => {
    expect(parseUserAgent(UA.safariMac, null, 5)).toMatchObject({ os: { name: "iPadOS" }, device: "tablet" });
  });

  it("prefers User-Agent Client Hints", () => {
    const p = parseUserAgent(UA.chromeWin, {
      brands: [
        { brand: "Not)A;Brand", version: "99" },
        { brand: "Microsoft Edge", version: "128" },
        { brand: "Chromium", version: "128" },
      ],
      mobile: false,
      platform: "Windows",
    });
    expect(p.browser).toEqual({ name: "Edge", version: "128" });
  });

  it("returns unknown for garbage", () => {
    expect(parseUserAgent("curl/8.0")).toEqual({ device: "unknown" });
  });
});

describe("in Node (no DOM)", () => {
  it("detects the runtime and collects a server environment", () => {
    expect(detectRuntime()).toBe("node");
    const env = collectEnvironment();
    expect(env.runtime).toBe("node");
    expect(env.device).toBe("server");
    expect(env.userAgent).toMatch(/^Node\.js\//);
    expect(env.timeZone).toBeTruthy();
  });

  it("installs every signal as a harmless no-op", () => {
    const rt = testRuntime();
    const sigs = [
      installConsole(rt, { max: 10 }),
      installErrors(rt),
      installNetwork(rt, { max: 10, bodies: [], headers: [] }),
      installNavigation(rt, { max: 20 }),
      installActions(rt),
      installPerformance(rt, { slowResourceMs: 1000 }),
    ];
    expect(sigs[2]?.snapshot()).toEqual([]);
    expect(sigs[3]?.snapshot()).toEqual({ entries: [], history: [] });
    expect(sigs[5]?.snapshot()).toEqual({ longTasks: [], slowResources: [] });
    expect(collectStorage(rt, [])).toEqual({ localStorage: [], sessionStorage: [], cookies: [] });
    expect(collectPage(rt)).toEqual({});
    expect(domSnapshot(rt)).toBe("");
    for (const s of sigs) s.destroy();
    expect(rt.faults).toEqual([]);
  });
});

describe("lazy chunks in Node", () => {
  it("import without a DOM and degrade safely", async () => {
    const replay = await import("../../src/core/replay/index.ts");
    const shot = await import("../../src/core/screenshot/index.ts");
    const rec = await import("../../src/core/recording/index.ts");
    const analytics = await import("../../src/core/analytics/index.ts");
    const rt = testRuntime();
    const ctl = await replay.startReplay(rt, { mode: "buffer", windowSeconds: 60, maskText: "inputs", maskSelectors: [], blockSelectors: [], uploadSegment: async () => {} });
    expect(await ctl.flush()).toBeNull();
    expect(ctl.recentEvents()).toEqual([]);
    ctl.stop();
    await expect(shot.captureScreenshot({ scope: "viewport", maskText: "inputs", maskSelectors: [], blockSelectors: [] })).rejects.toThrow();
    await expect(rec.startRecording()).rejects.toThrow();
    const a = analytics.startAnalytics(rt, {}, () => {
      throw new Error("should not send");
    });
    a.track("x");
    a.pageview();
    a.flush();
    a.destroy();
  });
});

describe("web-vitals math", () => {
  it("CLS uses the largest session window", () => {
    // window 1: 0.1 + 0.1 (gap < 1s); gap > 1s; window 2: 0.05 * 3
    expect(clsFromShifts([{ t: 0, value: 0.1 }, { t: 500, value: 0.1 }, { t: 3000, value: 0.05 }, { t: 3500, value: 0.05 }, { t: 3900, value: 0.05 }])).toBeCloseTo(0.2);
    // a window is capped at 5 s even with small gaps
    const steady = Array.from({ length: 12 }, (_, i) => ({ t: i * 900, value: 0.01 }));
    expect(clsFromShifts(steady)).toBeCloseTo(0.06);
    expect(clsFromShifts([])).toBe(0);
  });

  it("INP is the worst interaction, ignoring one outlier per 50", () => {
    expect(inpFromDurations([])).toBeUndefined();
    expect(inpFromDurations([40, 300, 120])).toBe(300);
    const many = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(inpFromDurations(many)).toBe(98);
    expect(inpFromDurations([500, 400, 300], 150)).toBe(300);
  });
});
