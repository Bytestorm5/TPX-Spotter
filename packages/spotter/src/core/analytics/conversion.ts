/**
 * The fields `spotter.goal()` and funnel steps add to a custom event — the
 * goal or funnel declaration, the conversion id and the app's metadata —
 * bounded like the rest of it. Shared by the browser's analytics chunk and
 * the server's `trackServer`, each passing its own string redaction.
 */
import type { Conversion } from "../engine.ts";
import type { AnalyticsEvent, Json } from "../schema.ts";

type Fields = Pick<AnalyticsEvent, "goal" | "funnel" | "conversionId" | "metadata">;

const clip = (value: unknown, max: number) => String(value).slice(0, max);
const MAX_DEPTH = 8;
const MAX_KEYS = 50;
const MAX_STRING = 1000;
const MAX_METADATA_BYTES = 8 * 1024;

/** JSON-safe, redacted and bounded: depth, keys per object, string length; non-JSON values dropped. */
function bounded(value: unknown, redact: (s: string) => string, depth: number): Json | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return redact(value.slice(0, MAX_STRING));
  if (typeof value !== "object" || depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (const item of value.slice(0, MAX_KEYS)) {
      const v = bounded(item, redact, depth + 1);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
    const v = bounded((value as Record<string, unknown>)[key], redact, depth + 1);
    if (v !== undefined) out[clip(key, 100)] = v;
  }
  return out;
}

export function conversionFields(c: Conversion | undefined, redact: (s: string) => string): Fields {
  const out: Fields = {};
  if (!c) return out;
  if (c.goal) out.goal = clip(c.goal, 100);
  if (c.funnel) {
    const { name, step, steps } = c.funnel;
    out.funnel = { name: clip(name, 100), step: clip(step, 100), steps: steps.slice(0, 10).map((s) => clip(s, 100)) };
  }
  if (c.id !== undefined && c.id !== null && c.id !== "") out.conversionId = clip(c.id, 200);
  if (c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata)) {
    try {
      const metadata = bounded(c.metadata, redact, 0) as Record<string, Json>;
      // Over budget: say so rather than send a slice that looks complete.
      out.metadata = JSON.stringify(metadata).length <= MAX_METADATA_BYTES ? metadata : { truncated: true };
    } catch {
      /* metadata is best-effort; the conversion still counts */
    }
  }
  return out;
}
