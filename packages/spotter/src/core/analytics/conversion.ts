/**
 * The goal / funnel / conversion-id fields `spotter.goal()` and funnel steps
 * add to a custom event, bounded like the rest of it. Shared by the browser's
 * analytics chunk and the server's `trackServer`.
 */
import type { Conversion } from "../engine.ts";

const clip = (value: unknown, max: number) => String(value).slice(0, max);

export function conversionFields(c?: Conversion): Conversion {
  const out: Conversion = {};
  if (!c) return out;
  if (c.goal) out.goal = clip(c.goal, 100);
  if (c.funnel) {
    const { name, step, steps } = c.funnel;
    out.funnel = { name: clip(name, 100), step: clip(step, 100), steps: steps.slice(0, 10).map((s) => clip(s, 100)) };
  }
  if (c.conversionId !== undefined && c.conversionId !== null && c.conversionId !== "") out.conversionId = clip(c.conversionId, 200);
  return out;
}
