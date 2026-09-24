/**
 * The agent-readable timeline: what the reporter did and what the page did
 * back, as a compact step list a model can reason over without replaying
 * video (spec: "clicked Pay → POST /api/charge 502 → error toast shown").
 *
 * Each line starts with a user step (click, input, navigation, custom
 * breadcrumb) and appends its consequences — failed or mutating requests,
 * errors, console errors — joined with " → ". Lines carry their offset from
 * the moment the report was filed, and the list keeps the most recent ~50.
 */
import type { Breadcrumb, ConsoleEntry, ErrorEntry, Har, HarEntry, NavigationEntry } from "./schema.ts";

export interface TimelineSignals {
  breadcrumbs?: Breadcrumb[];
  navigation?: NavigationEntry[];
  network?: Har | HarEntry[];
  errors?: ErrorEntry[];
  console?: ConsoleEntry[];
}

export const TIMELINE_MAX_LINES = 50;
const SEGMENT_MAX = 140;

interface Step {
  at: number;
  /** User steps open a new line; consequences append to the current one. */
  lead: boolean;
  text: string;
}

function clip(text: string, max = SEGMENT_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Path (+ "?…" when there was a query); the host only when it isn't the page's own. */
function pathOf(url: string, pageHost?: string): string {
  try {
    const u = new URL(url, "http://_");
    const p = u.pathname + (u.search ? "?…" : "");
    return u.host !== "_" && pageHost && u.host !== pageHost ? `${u.host}${p}` : p;
  } catch {
    return url;
  }
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

function ts(at: string | undefined): number {
  const n = at ? Date.parse(at) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function crumbStep(c: Breadcrumb): Step | null {
  const at = ts(c.at);
  const msg = clip(c.message);
  switch (c.category) {
    case "click":
      return { at, lead: true, text: /^click/i.test(msg) ? msg : `clicked ${msg}` };
    case "input":
      return { at, lead: true, text: /^(typed|input|changed|selected)/i.test(msg) ? msg : `typed in ${msg}` };
    case "rage_click":
      return { at, lead: true, text: `rage-clicked ${msg}` };
    case "dead_click":
      return { at, lead: false, text: `no response to click on ${msg}` };
    case "error_click":
      return { at, lead: false, text: `click caused error: ${msg}` };
    case "custom":
      return { at, lead: true, text: msg };
    case "scroll":
      return { at, lead: true, text: "scrolled" };
    case "error":
      // errors come from signals.errors; keep only crumbs that have no entry there
      return null;
    case "console":
      return c.level === "error" ? { at, lead: false, text: `console.error: ${msg}` } : null;
    // focus is noise for repro; navigation and network are covered by their own signals
    default:
      return null;
  }
}

function harEntries(network: TimelineSignals["network"]): HarEntry[] {
  if (!network) return [];
  return Array.isArray(network) ? network : network.log.entries;
}

function networkStep(e: HarEntry, pageHost?: string): Step | null {
  const method = e.request.method.toUpperCase();
  const status = e.response.status;
  const failed = status === 0 || status >= 400 || !!e._error;
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!failed && !mutating) return null;
  const outcome = e._error ? `failed (${clip(e._error, 60)})` : status === 0 ? "failed" : String(status);
  return { at: ts(e.startedDateTime) + (e.time || 0), lead: false, text: `${method} ${clip(pathOf(e.request.url, pageHost), 80)} ${outcome}` };
}

function merge(steps: Step[]): string[][] {
  steps.sort((a, b) => a.at - b.at);
  const lines: { at: number; parts: string[]; counts: number[] }[] = [];
  for (const s of steps) {
    const cur = lines[lines.length - 1];
    if (!cur || s.lead) {
      // collapse identical consecutive user steps ("clicked Pay ×3")
      if (cur && s.lead && cur.parts.length === 1 && cur.parts[0] === s.text) {
        cur.counts[0] = (cur.counts[0] ?? 1) + 1;
        continue;
      }
      lines.push({ at: s.at, parts: [s.text], counts: [1] });
    } else {
      const last = cur.parts.length - 1;
      if (cur.parts[last] === s.text) cur.counts[last] = (cur.counts[last] ?? 1) + 1;
      else {
        cur.parts.push(s.text);
        cur.counts.push(1);
      }
    }
  }
  return lines.map((l) => [String(l.at), ...l.parts.map((p, i) => ((l.counts[i] ?? 1) > 1 ? `${p} (×${l.counts[i]})` : p))]);
}

function offset(at: number, now: number): string {
  if (!at) return "";
  const s = Math.max(0, (now - at) / 1000);
  return s < 10 ? `[-${s.toFixed(1)}s] ` : `[-${Math.round(s)}s] `;
}

/**
 * Build the timeline. `now` is when the report was filed (ms since epoch); it
 * anchors the `[-12s]` offsets and appends the final "report filed" step.
 */
export function buildTimeline(signals: TimelineSignals, now: number = Date.now()): string[] {
  const steps: Step[] = [];
  for (const c of signals.breadcrumbs ?? []) {
    const s = crumbStep(c);
    if (s) steps.push(s);
  }
  for (const n of signals.navigation ?? []) {
    steps.push({
      at: ts(n.at),
      lead: true,
      text: n.kind === "load" ? `opened ${clip(pathOf(n.to), 100)}` : `navigated to ${clip(n.routePattern ?? pathOf(n.to), 100)}`,
    });
  }
  const nav = signals.navigation ?? [];
  const pageHost = hostOf(nav[nav.length - 1]?.to);
  for (const e of harEntries(signals.network)) {
    const s = networkStep(e, pageHost);
    if (s) steps.push(s);
  }
  for (const e of signals.errors ?? []) {
    steps.push({ at: ts(e.at), lead: false, text: `error: ${clip(`${e.type}: ${e.message}`)}` });
  }
  // console errors without a matching error entry (logged, not thrown)
  const errorMessages = new Set((signals.errors ?? []).map((e) => e.message));
  for (const c of signals.console ?? []) {
    if (c.level !== "error") continue;
    const first = typeof c.args[0] === "string" ? c.args[0] : JSON.stringify(c.args[0] ?? "");
    if ([...errorMessages].some((m) => first.includes(m))) continue;
    steps.push({ at: ts(c.at), lead: false, text: `console.error: ${clip(first, 100)}` });
  }

  const merged = merge(steps).map(([at, ...parts]) => offset(Number(at), now) + parts.join(" → "));
  merged.push(`${offset(now, now)}report filed`.trim());
  if (merged.length <= TIMELINE_MAX_LINES) return merged;
  const dropped = merged.length - (TIMELINE_MAX_LINES - 1);
  return [`… ${dropped} earlier steps`, ...merged.slice(-(TIMELINE_MAX_LINES - 1))];
}

/** The timeline as numbered Markdown repro steps (Console's "copy as repro steps", the GitHub hook body). */
export function reproSteps(timeline: string[]): string {
  return timeline
    .filter((line) => !line.startsWith("… "))
    .map((line, i) => `${i + 1}. ${line.replace(/^\[-[\d.]+s\]\s*/, "")}`)
    .join("\n");
}
