/**
 * Snapshot-time finishing of the signals that load at init (session chunk).
 *
 * The capture modules that run from the start only hold raw, bounded
 * records — that keeps "core once initialized" small and the hot paths
 * cheap. Before anything is sent (a report, a capture for the widget, a
 * flag's context) the session turns them into the report schema here:
 * serialized, URL-stripped and redacted. See also `network-har.ts`
 * (network → HAR) and `stack.ts` (errors → frames).
 */
import type { Breadcrumb, ConsoleEntry, Json } from "../schema.ts";
import { LABEL, type RawCrumb } from "../internal.ts";
import type { Redactor } from "../redact.ts";
import { mapStrings, safeSerialize, truncate } from "../serialize.ts";
import type { RawConsoleEntry } from "./console.ts";
import type { NavigationSnapshot } from "./navigation.ts";

// Copies already cap strings at 8 KB (with a marker) and collections at 100 (plus a marker entry).
const COPY_BOUNDS = { maxString: 8192 + 64, maxKeys: 101 };

const text = (v: unknown): string => {
  const s = safeSerialize(v, COPY_BOUNDS);
  return typeof s === "string" ? s : (JSON.stringify(s) ?? "");
};

export function finalizeConsole(raw: readonly RawConsoleEntry[], r: Redactor): ConsoleEntry[] {
  return raw.map((e) => {
    const out: ConsoleEntry = { level: e.level, at: e.at, args: e.args.map((a) => mapStrings(safeSerialize(a, COPY_BOUNDS), (s) => r.redact(s, "console"))) };
    if (e.stack) out.stack = r.redact(e.stack, "console");
    return out;
  });
}

export function finalizeNavigation(snap: NavigationSnapshot, r: Redactor): NavigationSnapshot {
  return {
    entries: snap.entries.map((e) => ({ ...e, to: r.redactUrl(e.to), ...(e.from ? { from: r.redactUrl(e.from) } : {}) })),
    history: snap.history.map((u) => r.redactUrl(u)),
  };
}

const URL_KEYS = new Set(["url", "to", "from"]);

export function finalizeCrumbs(raw: readonly RawCrumb[], r: Redactor): Breadcrumb[] {
  return raw.map((c) => {
    const { label, value, max, ...crumb } = c;
    const out: Breadcrumb = crumb;
    try {
      let message = r.redactMessage("value" in c && !c.message ? text(value) : String(c.message ?? ""), "breadcrumb");
      if (label !== undefined) message = message.replace(LABEL, truncate(r.redact(label, "breadcrumb"), 60));
      out.message = max ? truncate(message, max) : message;
      if (c.data) {
        const data = r.redactJson(c.data, "breadcrumb") as Record<string, Json>;
        for (const k of URL_KEYS) if (typeof c.data[k] === "string") data[k] = r.redactUrl(c.data[k] as string);
        out.data = data;
      }
    } catch {
      out.message = "[redacted:unscrubbable]";
      delete out.data;
    }
    return out;
  });
}
