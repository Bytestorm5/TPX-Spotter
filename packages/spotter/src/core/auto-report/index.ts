/**
 * The browser half of `autoReport`: watches for problems and files a report
 * when one matches the rules (`rules.ts`). A lazy chunk, loaded by the
 * session chunk only when `autoReport` is configured — which in turn makes
 * the engine load the session chunk on idle rather than on first
 * interaction.
 *
 * It adds no patches of its own for what the engine already captures: it
 * listens in on the runtime (`rt.error` for uncaught errors and rejections,
 * `rt.breadcrumb` for failed requests and console errors) and reads the raw
 * record from the signal's buffer. On start it walks those buffers once, so
 * problems from before this chunk arrived (a crash during hydration) still
 * count. What it does listen for itself: failed `<img>` / `<script>` / `<link>`
 * loads, CSP violations, and the document's HTTP status.
 *
 * Problems are coalesced: the first match opens a `delayMs` window, and
 * everything that matches inside it goes into one report (a 502, the
 * rejection it causes and the error that gets logged are one problem).
 * Limits are per tab session (sessionStorage): `perIssue` reports for the
 * same problem, `perSession` in total.
 */
import type { RawConsoleEntry } from "../capture/console.ts";
import type { RawError } from "../capture/errors.ts";
import type { RawRequest } from "../capture/network.ts";
import type { EngineCore } from "../engine.ts";
import type { Severity } from "../schema.ts";
import type { AutoReportEvent, AutoReportMatcher } from "../types.ts";
import { decide, eventKey, primaryOf, severityFor, wasCaptured, type NormalizedAutoReport } from "./rules.ts";

export interface AutoReporterDeps {
  core: EngineCore;
  rules: NormalizedAutoReport;
  /** Build and send the report. `events` holds every problem in the window, primary first. */
  file(primary: AutoReportEvent, events: (AutoReportEvent & { count: number })[], severity: Severity): Promise<unknown>;
}

export interface AutoReporter {
  /** File what's pending now (page hide, tests). */
  flush(): Promise<void>;
  destroy(): void;
}

const STORE = "spotter:auto";
const RESOURCE_TAGS = new Set(["IMG", "SCRIPT", "LINK", "VIDEO", "AUDIO", "SOURCE", "IFRAME", "EMBED", "OBJECT", "TRACK", "IMAGE"]);
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

interface Counts {
  total: number;
  keys: Record<string, number>;
}

function readCounts(): Counts {
  try {
    const raw = sessionStorage.getItem(STORE);
    if (raw) {
      const c = JSON.parse(raw) as Counts;
      if (c && typeof c.total === "number" && c.keys) return c;
    }
  } catch {
    /* blocked or corrupt: start over */
  }
  return { total: 0, keys: {} };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A Next.js client-side navigation fetches the next page's RSC payload with `?_rsc=`. */
function isRsc(url: string): boolean {
  return /[?&]_rsc=/.test(url);
}

function pathOf(url: string): string {
  try {
    return new URL(url, location.href).pathname;
  } catch {
    return url;
  }
}

/** The last error passed to a console call (React / Next log caught render errors this way). */
function errorArg(args: unknown[]): Error | undefined {
  for (let i = args.length - 1; i >= 0; i--) if (args[i] instanceof Error) return args[i] as Error;
  return undefined;
}

function argText(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

function consoleText(args: unknown[]): string {
  return args
    .slice(0, 5)
    .map(argText)
    .join(" ")
    .replace(/%[sdoOifc]/g, "")
    .trim()
    .slice(0, 2000);
}

export function startAutoReport(deps: AutoReporterDeps): AutoReporter {
  const { core, rules } = deps;
  const rt = core.runtime;
  const counts = readCounts();
  const batch = new Map<string, AutoReportEvent & { count: number; severity: Severity }>();
  const undo: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let filing: Promise<void> = Promise.resolve();

  const save = () => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(counts));
    } catch {
      /* the limits last for this page only */
    }
  };

  // -- the pipeline --------------------------------------------------------------------------

  function observe(e: AutoReportEvent): void {
    if (destroyed) return;
    try {
      const { report, matcher } = decide(rules, e);
      if (!report) return;
      const key = eventKey(e);
      const queued = batch.get(key);
      if (queued) {
        queued.count++;
        return;
      }
      if (counts.total >= rules.perSession || (counts.keys[key] ?? 0) >= rules.perIssue) return;
      batch.set(key, { ...e, count: 1, severity: severityFor(rules, e, matcher as AutoReportMatcher | undefined) });
      timer ??= setTimeout(() => void flush(), rules.delayMs);
    } catch (error) {
      rt.fault("autoReport", error);
    }
  }

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!batch.size) return filing;
    const entries = [...batch.entries()];
    batch.clear();
    // A soft navigation that failed only counts if the user is on that page (not a prefetch of a link they never followed).
    const here = location.pathname;
    const keep = entries.filter(([, e]) => !(e.kind === "page" && e.soft && e.url && pathOf(e.url) !== here) && !wasCaptured(e));
    if (!keep.length) return filing;
    if (counts.total >= rules.perSession) return filing;
    counts.total++;
    for (const [key] of keep) counts.keys[key] = (counts.keys[key] ?? 0) + 1;
    save();
    const events = keep.map(([, e]) => e);
    const primary = primaryOf(events) as (typeof events)[number];
    const ordered = [primary, ...events.filter((e) => e !== primary)];
    const severity = ordered.reduce<Severity>((s, e) => (SEVERITY_RANK[e.severity] > SEVERITY_RANK[s] ? e.severity : s), primary.severity);
    const strip = ({ severity: _s, ...e }: (typeof events)[number]) => e;
    filing = filing
      .then(() => deps.file(strip(primary), ordered.map(strip), severity))
      .then(
        () => {},
        () => {},
      );
    return filing;
  }

  // -- sources: errors -------------------------------------------------------------------------

  const fromError = (raw: RawError): AutoReportEvent => ({
    kind: "error",
    at: iso(raw.at),
    type: raw.type,
    message: raw.message || ("value" in raw ? "Non-Error thrown" : ""),
    mechanism: raw.mechanism,
    ...(raw.stack ? { stack: raw.stack } : {}),
    ...("value" in raw ? { error: raw.value } : {}),
    ...(raw.frames?.[0]?.file ? { url: raw.frames[0].file } : {}),
  });

  // -- sources: network & page ------------------------------------------------------------------

  const fromRequest = (r: RawRequest): AutoReportEvent | null => {
    if (!r.error && r.status < 400) return null;
    // A beacon has no response to judge: only a rejected one is a failure.
    if (r.initiator === "beacon" && !r.error) return null;
    const soft = isRsc(r.url);
    return {
      kind: soft ? "page" : "network",
      at: iso(r.at),
      type: r.error ? "NetworkError" : `HTTP ${r.status}`,
      message: r.error ?? `${r.status}${r.statusText ? ` ${r.statusText}` : ""}`,
      ...(r.error ? {} : { status: r.status }),
      ...(r.statusText && !r.error ? { statusText: r.statusText } : {}),
      url: r.url,
      method: r.method,
      duration: r.time,
      ...(soft ? { soft: true } : {}),
    };
  };

  const lastRequest = (url: string, method: string): RawRequest | undefined => {
    const all = core.snap<RawRequest[]>("network", []);
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.url === url && all[i]!.method === method) return all[i];
    return undefined;
  };

  // -- sources: console ---------------------------------------------------------------------------

  const fromConsole = (c: RawConsoleEntry): AutoReportEvent | null => {
    if (c.level !== "error" && c.level !== "warn") return null;
    const err = errorArg(c.args);
    return {
      kind: "console",
      at: c.at,
      type: err ? err.name || "Error" : "ConsoleError",
      message: consoleText(c.args),
      level: c.level,
      ...(err ? { error: err, ...(err.stack ? { stack: err.stack } : {}) } : c.stack ? { stack: c.stack } : {}),
    };
  };

  // -- catch up on what was captured before this chunk loaded ---------------------------------------

  for (const raw of [...core.earlyErrors, ...core.snap<RawError[]>("errors", [])]) observe(fromError(raw));
  for (const r of core.snap<RawRequest[]>("network", [])) {
    const e = fromRequest(r);
    if (e) observe(e);
  }
  for (const c of core.snap<RawConsoleEntry[]>("console", [])) {
    const e = fromConsole(c);
    if (e) observe(e);
  }

  // -- and listen from now on ---------------------------------------------------------------------

  const originalError = rt.error;
  const originalCrumb = rt.breadcrumb;
  const onError: typeof rt.error = (entry) => {
    originalError.call(rt, entry);
    if ("mechanism" in entry) observe(fromError(entry as RawError));
  };
  const onCrumb: typeof rt.breadcrumb = (crumb) => {
    originalCrumb.call(rt, crumb);
    try {
      if (crumb.category === "network" && crumb.data && typeof crumb.data.url === "string") {
        const r = lastRequest(crumb.data.url, String(crumb.data.method ?? "GET"));
        const e = r && fromRequest(r);
        if (e) observe(e);
      } else if (crumb.category === "console" && (crumb.level === "error" || crumb.level === "warning")) {
        // The console signal records its entry right after the crumb.
        queueMicrotask(() => {
          const last = core.snap<RawConsoleEntry[]>("console", []).at(-1);
          const e = last && last.at === crumb.at ? fromConsole(last) : null;
          if (e) observe(e);
        });
      }
    } catch (error) {
      rt.fault("autoReport", error);
    }
  };
  rt.error = onError;
  rt.breadcrumb = onCrumb;
  undo.push(() => {
    if (rt.error === onError) rt.error = originalError;
    if (rt.breadcrumb === onCrumb) rt.breadcrumb = originalCrumb;
  });

  // The document's own status (Chrome / Edge / Firefox ≥ 113 expose it on navigation timing).
  try {
    const nav = performance.getEntriesByType?.("navigation")?.[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
    const status = nav?.responseStatus;
    if (status && status >= 400)
      observe({ kind: "page", at: iso(performance.timeOrigin || Date.now()), type: `HTTP ${status}`, message: String(status), status, url: location.href });
  } catch {
    /* no navigation timing */
  }

  // Failed element loads: they don't bubble, so listen in the capture phase.
  const onResourceError = (ev: Event) => {
    const el = ev.target as Element | null;
    if (!el || el === (window as unknown) || !(el as Element).tagName || !RESOURCE_TAGS.has(el.tagName.toUpperCase())) return;
    const a = el as Element & { currentSrc?: string; src?: string | SVGAnimatedString; href?: string | SVGAnimatedString; data?: string };
    const pick = (v: unknown) => (typeof v === "string" ? v : (v as SVGAnimatedString | undefined)?.baseVal);
    const url = a.currentSrc || pick(a.src) || pick(a.href) || a.data || "";
    if (!url) return;
    let status: number | undefined;
    try {
      const t = performance.getEntriesByName(url).at(-1) as (PerformanceResourceTiming & { responseStatus?: number }) | undefined;
      status = t?.responseStatus || undefined;
    } catch {
      /* no resource timing */
    }
    const element = el.tagName.toLowerCase();
    observe({
      kind: "resource",
      at: iso(rt.now()),
      type: "ResourceError",
      message: `${element} ${url}`,
      url,
      element,
      ...(status ? { status } : {}),
    });
  };
  window.addEventListener("error", onResourceError, true);
  undo.push(() => window.removeEventListener("error", onResourceError, true));

  const onCsp = (ev: Event) => {
    const v = ev as SecurityPolicyViolationEvent;
    const directive = v.effectiveDirective || v.violatedDirective;
    observe({
      kind: "csp",
      at: iso(rt.now()),
      type: "CSPViolation",
      message: `${directive} blocked ${v.blockedURI || "inline"}`,
      ...(v.blockedURI && /^[a-z]+:/i.test(v.blockedURI) ? { url: v.blockedURI } : {}),
      directive,
      ...(v.sourceFile ? { stack: `at ${v.sourceFile}:${v.lineNumber}:${v.columnNumber}` } : {}),
    });
  };
  document.addEventListener("securitypolicyviolation", onCsp);
  undo.push(() => document.removeEventListener("securitypolicyviolation", onCsp));

  // Don't lose a pending report to a tab close.
  const onHide = () => {
    if (document.visibilityState === "hidden") void flush();
  };
  document.addEventListener("visibilitychange", onHide);
  undo.push(() => document.removeEventListener("visibilitychange", onHide));

  return {
    flush,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      batch.clear();
      for (const fn of undo.splice(0)) fn();
    },
  };
}
