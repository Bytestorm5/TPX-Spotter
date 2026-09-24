/**
 * The environment a report came from: runtime, browser, OS, device,
 * viewport, locale, preferences and network. Works in browsers, Node and
 * edge runtimes. The UA parser is small and hand-written on purpose — a
 * full UA database would cost more bytes than the rest of the core.
 */
import type { EnvironmentInfo } from "../schema.ts";

interface UADataBrand {
  brand: string;
  version: string;
}
interface UAData {
  brands?: UADataBrand[];
  mobile?: boolean;
  platform?: string;
}

export interface ParsedUA {
  browser?: { name: string; version?: string };
  os?: { name: string; version?: string };
  device: EnvironmentInfo["device"];
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/([\d.]+)/, "Edge"],
  [/\b(?:OPR|OPiOS|OPT)\/([\d.]+)/, "Opera"],
  [/\bOpera\/.*Version\/([\d.]+)/, "Opera"],
  [/\bSamsungBrowser\/([\d.]+)/, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox"],
  [/\bCriOS\/([\d.]+)/, "Chrome"],
  [/\bChrome\/([\d.]+)/, "Chrome"],
  [/\bVersion\/([\d.]+).*\bSafari\//, "Safari"],
  [/\b(?:iPhone|iPad|iPod).*AppleWebKit\//, "Safari"],
];

function major(version: string | undefined): string | undefined {
  return version ? version.split(".").slice(0, 2).join(".") : undefined;
}

/**
 * Parse browser, OS and device class from a user-agent string, preferring
 * User-Agent Client Hints (`navigator.userAgentData`) where present — Chromium
 * freezes the UA string's OS version, the hints don't.
 */
export function parseUserAgent(ua: string, uaData?: UAData | null, maxTouchPoints = 0): ParsedUA {
  const out: ParsedUA = { device: "unknown" };

  // -- browser
  const brands = uaData?.brands?.filter((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? [];
  const hinted = brands.find((b) => /edge|opera|samsung|chrome/i.test(b.brand));
  if (hinted) {
    const name = /edge/i.test(hinted.brand)
      ? "Edge"
      : /opera/i.test(hinted.brand)
        ? "Opera"
        : /samsung/i.test(hinted.brand)
          ? "Samsung Internet"
          : "Chrome";
    out.browser = { name, version: hinted.version };
  } else {
    for (const [re, name] of BROWSERS) {
      const m = re.exec(ua);
      if (m) {
        out.browser = { name };
        const v = major(m[1]);
        if (v) out.browser.version = v;
        break;
      }
    }
  }

  // -- OS
  let m: RegExpExecArray | null;
  if ((m = /\bWindows NT ([\d.]+)/.exec(ua))) {
    const map: Record<string, string> = { "10.0": "10", "6.3": "8.1", "6.2": "8", "6.1": "7" };
    out.os = { name: "Windows" };
    const v = map[m[1] ?? ""];
    if (v) out.os.version = v;
  } else if (/\bWindows\b/.test(ua)) {
    out.os = { name: "Windows" };
  } else if ((m = /\b(?:iPhone|iPod).*? OS ([\d_]+)/.exec(ua))) {
    out.os = { name: "iOS", version: (m[1] ?? "").replace(/_/g, ".") };
  } else if ((m = /\biPad.*? OS ([\d_]+)/.exec(ua))) {
    out.os = { name: "iPadOS", version: (m[1] ?? "").replace(/_/g, ".") };
  } else if ((m = /\bMac OS X ([\d_.]+)/.exec(ua)) || /\bMacintosh\b/.test(ua)) {
    // iPadOS 13+ asks for desktop sites with a Mac UA; touch points give it away.
    if (maxTouchPoints > 1 && /\bMacintosh\b/.test(ua)) out.os = { name: "iPadOS" };
    else {
      out.os = { name: "macOS" };
      if (m?.[1]) out.os.version = m[1].replace(/_/g, ".");
    }
  } else if ((m = /\bAndroid ([\d.]+)/.exec(ua)) || /\bAndroid\b/.test(ua)) {
    out.os = { name: "Android" };
    if (m?.[1]) out.os.version = m[1];
  } else if (/\bCrOS\b/.test(ua)) {
    out.os = { name: "ChromeOS" };
  } else if (/\bLinux\b/.test(ua)) {
    out.os = { name: "Linux" };
  }
  if (uaData?.platform && !out.os) {
    const p = uaData.platform;
    out.os = { name: /mac/i.test(p) ? "macOS" : /chrome ?os/i.test(p) ? "ChromeOS" : p };
  }

  // -- device class
  const os = out.os?.name;
  if (os === "iPadOS" || /\biPad\b|\bTablet\b|\bKindle\b|\bSilk\b/.test(ua) || (os === "Android" && !/\bMobile\b/.test(ua))) {
    out.device = "tablet";
  } else if (uaData?.mobile || /\bMobi(?:le)?\b|\biPhone\b|\biPod\b/.test(ua) || os === "iOS") {
    out.device = "mobile";
  } else if (os || out.browser) {
    out.device = "desktop";
  }
  return out;
}

declare const EdgeRuntime: string | undefined;

/** Which runtime this code is running in. */
export function detectRuntime(): EnvironmentInfo["runtime"] {
  if (typeof window !== "undefined" && typeof document !== "undefined") return "browser";
  if (typeof EdgeRuntime === "string") return "edge";
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) return "node";
  return "edge"; // workers: no window, no Node
}

/** Collect the environment. Never throws; fields that can't be read are left out. */
export function collectEnvironment(): EnvironmentInfo {
  const runtime = detectRuntime();
  const env: EnvironmentInfo = { runtime, device: runtime === "browser" ? "unknown" : "server" };
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions();
    env.timeZone = intl.timeZone;
    env.locale = intl.locale;
  } catch {
    /* no Intl */
  }

  if (runtime !== "browser") {
    try {
      const proc = (globalThis as { process?: { versions?: { node?: string }; platform?: string } }).process;
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
      if (ua) env.userAgent = ua;
      else if (proc?.versions?.node) env.userAgent = `Node.js/${proc.versions.node}`;
      if (proc?.platform) {
        const map: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux", android: "Android" };
        env.os = { name: map[proc.platform] ?? proc.platform };
      }
    } catch {
      /* sandboxed runtime */
    }
    return env;
  }

  const nav = navigator as Navigator & {
    userAgentData?: UAData;
    connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number };
  };
  try {
    env.userAgent = nav.userAgent;
    const parsed = parseUserAgent(nav.userAgent, nav.userAgentData, nav.maxTouchPoints || 0);
    if (parsed.browser) env.browser = parsed.browser;
    if (parsed.os) env.os = parsed.os;
    env.device = parsed.device;
  } catch {
    /* odd navigator */
  }
  try {
    env.locale = nav.language || env.locale;
    env.viewport = { width: window.innerWidth, height: window.innerHeight };
    if (window.screen) env.screen = { width: window.screen.width, height: window.screen.height };
    env.dpr = window.devicePixelRatio || 1;
  } catch {
    /* sandboxed iframe */
  }
  try {
    if (typeof window.matchMedia === "function") {
      env.colorScheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      env.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  } catch {
    /* no matchMedia */
  }
  try {
    const network: NonNullable<EnvironmentInfo["network"]> = { online: nav.onLine !== false };
    const c = nav.connection;
    if (c) {
      if (c.type) network.type = c.type;
      if (c.effectiveType) network.effectiveType = c.effectiveType;
      if (typeof c.downlink === "number") network.downlink = c.downlink;
      if (typeof c.rtt === "number") network.rtt = c.rtt;
    }
    env.network = network;
  } catch {
    /* no network info */
  }
  return env;
}
