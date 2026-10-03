/**
 * Which problems warrant an automatic report: `autoReport` config →
 * normalized rules → a yes/no per `AutoReportEvent`. Pure and runtime
 * agnostic, so the browser watcher (`auto-report/index.ts`) and the server
 * helper (`ui/next` `createOnRequestError`) decide the same way.
 *
 * Defaults (what `autoReport: true` means):
 *
 * | kind     | default                                                    |
 * | -------- | ---------------------------------------------------------- |
 * | error    | on: uncaught errors, unhandled rejections                  |
 * | network  | 5xx responses and requests that failed outright; not 4xx    |
 * | page     | the document (or an RSC navigation) answered 5xx           |
 * | console  | `console.error(err)` with an Error: caught exceptions       |
 * | resource | off                                                        |
 * | csp      | off                                                        |
 * | server   | 5xx (every error `onRequestError` sees, bar notFound())     |
 */
import { hash, normalizePath } from "../fingerprint.ts";
import type { Severity } from "../schema.ts";
import type { AutoReportConfig, AutoReportEvent, AutoReportKind, AutoReportMatcher, AutoReportRule, StatusSpec } from "../types.ts";

export interface NormalizedAutoReport {
  rules: Record<AutoReportKind, AutoReportMatcher[]>;
  ignore: (string | RegExp)[];
  filter?: AutoReportConfig["filter"];
  delayMs: number;
  perIssue: number;
  perSession: number;
  include: NonNullable<AutoReportConfig["include"]>;
  tags: Record<string, string>;
  severity?: Severity;
}

/**
 * Browser noise that is never actionable: cross-origin "Script error." (no
 * message, no stack: serve scripts with `crossorigin` to see the real error)
 * and the benign ResizeObserver loop notice.
 */
export const NOISE: RegExp[] = [/^Script error\.?$/i, /ResizeObserver loop/i];

const DEFAULTS: Record<AutoReportKind, AutoReportMatcher[]> = {
  error: [{ ignoreMessages: NOISE }],
  network: [{ status: "5xx", failed: true }],
  page: [{ status: "5xx" }],
  console: [{ levels: ["error"], withError: true }],
  resource: [],
  csp: [],
  server: [{ status: "5xx" }],
};

/** Resources and plain console lines have no sensible "on" beyond everything. */
const ON: Partial<Record<AutoReportKind, AutoReportMatcher[]>> = {
  resource: [{ failed: true, status: ["4xx", "5xx"] }],
  csp: [{}],
};

const KEYS: Record<AutoReportKind, keyof AutoReportConfig> = {
  error: "errors",
  network: "network",
  page: "page",
  console: "console",
  resource: "resources",
  csp: "csp",
  server: "server",
};

function rule(kind: AutoReportKind, r: AutoReportRule | undefined): AutoReportMatcher[] {
  if (r === undefined) return DEFAULTS[kind];
  if (r === false) return [];
  if (r === true) return ON[kind] ?? DEFAULTS[kind];
  return Array.isArray(r) ? r : [r];
}

/** `autoReport` as configured → rules, or null when it's off. */
export function normalizeAutoReport(config: boolean | AutoReportConfig | undefined): NormalizedAutoReport | null {
  if (!config) return null;
  const c: AutoReportConfig = config === true ? {} : config;
  if (c.enabled === false) return null;
  const rules = {} as Record<AutoReportKind, AutoReportMatcher[]>;
  for (const kind of Object.keys(KEYS) as AutoReportKind[]) rules[kind] = rule(kind, c[KEYS[kind]] as AutoReportRule | undefined);
  return {
    rules,
    ignore: c.ignore ?? [],
    ...(c.filter ? { filter: c.filter } : {}),
    delayMs: Math.max(0, c.delayMs ?? 1000),
    perIssue: Math.max(0, c.limits?.perIssue ?? 1),
    perSession: Math.max(0, c.limits?.perSession ?? 10),
    include: { screenshot: true, replay: true, network: true, console: true, storage: true, dom: true, ...c.include },
    tags: c.tags ?? {},
    ...(c.severity ? { severity: c.severity } : {}),
  };
}

// -- matching ----------------------------------------------------------------------------

function statusOne(spec: StatusSpec, status: number): boolean {
  const s = String(spec).trim().toLowerCase();
  const cls = /^([1-5])xx$/.exec(s);
  if (cls) return Math.floor(status / 100) === Number(cls[1]);
  const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(s);
  if (range) return status >= Number(range[1]) && status <= Number(range[2]);
  return Number(s) === status;
}

/** Includes (any) minus `!` excludes. Only excludes → everything else. */
export function statusMatches(spec: StatusSpec | StatusSpec[], status: number): boolean {
  const specs = Array.isArray(spec) ? spec : [spec];
  const excl = specs.filter((s) => String(s).trim().startsWith("!")).map((s) => String(s).trim().slice(1));
  const incl = specs.filter((s) => !String(s).trim().startsWith("!"));
  if (excl.some((s) => statusOne(s, status))) return false;
  return incl.length ? incl.some((s) => statusOne(s, status)) : true;
}

function globRe(p: string): RegExp {
  return new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*")}$`, "i");
}

/** Glob (`*`; a leading `/` matches the path, with or without the query) or RegExp. */
export function urlMatches(url: string, patterns: readonly (string | RegExp)[]): boolean {
  let path = url;
  try {
    const u = new URL(url, "http://_");
    path = u.pathname + u.search;
  } catch {
    /* not a URL */
  }
  for (const p of patterns) {
    try {
      if (p instanceof RegExp) {
        p.lastIndex = 0;
        if (p.test(url)) return true;
        continue;
      }
      const re = globRe(p);
      if (p.startsWith("/") ? re.test(path) || re.test(path.split("?")[0] ?? "") : re.test(url)) return true;
    } catch {
      /* bad pattern */
    }
  }
  return false;
}

/** Case-insensitive substring, or RegExp. */
export function textMatches(text: string, patterns: readonly (string | RegExp)[]): boolean {
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (p instanceof RegExp) {
      p.lastIndex = 0;
      if (p.test(text)) return true;
    } else if (p && lower.includes(p.toLowerCase())) return true;
  }
  return false;
}

/** Whether one matcher matches an event. Fields that don't apply to the event's kind are ignored. */
export function matcherMatches(m: AutoReportMatcher, e: AutoReportEvent): boolean {
  const http = e.kind === "network" || e.kind === "resource" || e.kind === "page" || e.kind === "server";
  if (http && !e.status) {
    // No response at all: `failed` decides, whatever `status` says.
    if (e.kind === "network" && e.message === "aborted" && m.aborted !== true) return false;
    if (m.failed === false) return false;
  } else if (http && m.status !== undefined && !statusMatches(m.status, e.status!)) return false;
  if (e.kind === "network" && m.methods?.length && !m.methods.some((x) => x.toUpperCase() === (e.method ?? "GET").toUpperCase())) return false;
  if (m.urls?.length && !(e.url && urlMatches(e.url, m.urls))) return false;
  if (m.ignoreUrls?.length && e.url && urlMatches(e.url, m.ignoreUrls)) return false;
  if (m.messages?.length && !textMatches(e.message, m.messages)) return false;
  if (m.ignoreMessages?.length && textMatches(e.message, m.ignoreMessages)) return false;
  if (m.types?.length && !m.types.some((t) => t.toLowerCase() === e.type.toLowerCase())) return false;
  if (e.kind === "error" && m.mechanisms?.length && !m.mechanisms.includes(e.mechanism as "uncaught")) return false;
  if (e.kind === "console") {
    if (!(m.levels ?? ["error"]).includes(e.level ?? "error")) return false;
    if (m.withError !== false && !e.error) return false;
  }
  return true;
}

export interface Decision {
  report: boolean;
  /** The matcher that matched, for its severity. */
  matcher?: AutoReportMatcher;
}

/** The global ignore list (absolute), the kind's rules, then `filter` (which sees every event not ignored). */
export function decide(rules: NormalizedAutoReport, e: AutoReportEvent): Decision {
  if (rules.ignore.length > 0 && (textMatches(e.message, rules.ignore) || (!!e.url && urlMatches(e.url, rules.ignore)))) return { report: false };
  const matcher = rules.rules[e.kind].find((m) => matcherMatches(m, e));
  let report = !!matcher;
  if (rules.filter) {
    try {
      const r = rules.filter(e, report);
      if (typeof r === "boolean") report = r;
    } catch {
      /* a throwing filter keeps the rules' decision */
    }
  }
  return { report, ...(matcher ? { matcher } : {}) };
}

/** Default severity: errors and 5xx / failures are errors; 4xx, resources, CSP and warnings are warnings. */
export function severityFor(rules: NormalizedAutoReport, e: AutoReportEvent, matcher?: AutoReportMatcher): Severity {
  if (matcher?.severity) return matcher.severity;
  if (rules.severity) return rules.severity;
  switch (e.kind) {
    case "error":
    case "server":
      return "error";
    case "console":
      return e.level === "warn" ? "warning" : "error";
    case "network":
    case "page":
      return !e.status || e.status >= 500 ? "error" : "warning";
    default:
      return "warning";
  }
}

// -- grouping ------------------------------------------------------------------------------

function path(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url, "http://_");
    return (u.host === "_" ? "" : u.host) + normalizePath(u.pathname);
  } catch {
    return normalizePath(url);
  }
}

/** The first stack line that isn't the message: a cheap "where", stable across a session. */
function where(stack: string | undefined): string {
  if (!stack) return "";
  const line = stack.split("\n").find((l) => /^\s*at |@/.test(l));
  return (line ?? "").replace(/:\d+(?::\d+)?\)?\s*$/, "").trim();
}

/** What "the same problem" means for the per-issue limit. */
export function eventKey(e: AutoReportEvent): string {
  const msg = e.message.replace(/\b[0-9a-f]{8,}\b/gi, "<hex>").replace(/\d+/g, "0").slice(0, 200);
  const parts =
    e.kind === "network" || e.kind === "page" || e.kind === "resource"
      ? [e.kind, e.method ?? "", path(e.url), String(e.status ?? "failed")]
      : e.kind === "csp"
        ? [e.kind, e.directive ?? "", path(e.url)]
        : [e.kind, e.type, where(e.stack) || msg];
  return hash(parts.join("|"));
}

/** Order in which a coalesced batch picks its headline: the most fundamental problem first. */
export const PRIORITY: Record<AutoReportKind, number> = { server: 0, error: 1, page: 2, network: 3, console: 4, resource: 5, csp: 6 };

export function primaryOf(events: AutoReportEvent[]): AutoReportEvent {
  return [...events].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.at.localeCompare(b.at))[0]!;
}

// -- presentation ----------------------------------------------------------------------------

function shortUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url, "http://_");
    const same = typeof location !== "undefined" && u.origin === location.origin;
    return (u.host === "_" || same ? "" : u.host) + u.pathname;
  } catch {
    return url;
  }
}

/** One line per event: the title, and each bullet in the description. */
export function describeEvent(e: AutoReportEvent): string {
  const status = e.status ? `${e.status}${e.statusText ? ` ${e.statusText}` : ""}` : "";
  switch (e.kind) {
    case "network":
      return `${e.method ?? "GET"} ${shortUrl(e.url)} ${status ? `responded ${status}` : `failed${e.message ? ` (${e.message})` : ""}`}`;
    case "page":
      return `${e.soft ? "Navigation to" : "Page"} ${shortUrl(e.url)} ${status ? `responded ${status}` : "failed to load"}`;
    case "resource":
      return `Failed to load ${e.element ?? "resource"} ${shortUrl(e.url)}${status ? ` (${status})` : ""}`;
    case "csp":
      return `Content-Security-Policy blocked ${e.url ? shortUrl(e.url) : "a resource"}${e.directive ? ` (${e.directive})` : ""}`;
    case "console":
      return `console.${e.level ?? "error"}: ${e.message}`;
    default:
      return `${e.type}: ${e.message}`;
  }
}

// -- explicit reports win ------------------------------------------------------------------------

const captured = new WeakSet<object>();
const recent: { sig: string; at: number }[] = [];

/**
 * `captureException()` notes what it filed, so the watcher doesn't file the
 * same error again when it's also thrown or logged (an error boundary
 * reports it, then React logs it with `console.error`).
 */
export function noteCaptured(error: unknown, type: string, message: string, now = Date.now()): void {
  if (error && typeof error === "object") captured.add(error);
  recent.push({ sig: `${type}: ${message}`, at: now });
  while (recent.length > 20 || (recent[0] && now - recent[0].at > 10_000)) recent.shift();
}

export function wasCaptured(e: AutoReportEvent, now = Date.now()): boolean {
  if (e.error && typeof e.error === "object" && captured.has(e.error)) return true;
  if (e.kind !== "error" && e.kind !== "console") return false;
  return recent.some((r) => now - r.at < 10_000 && (r.sig === `${e.type}: ${e.message}` || e.message.includes(r.sig)));
}
