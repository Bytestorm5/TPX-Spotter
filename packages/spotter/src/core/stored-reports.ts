/**
 * The read side of the stored-receipts list (see receipts.ts): what the
 * client facade needs for `myReports()`. Split out so the write side loads
 * with the session chunk rather than at init.
 */
import type { StoredReport } from "./types.ts";

export const KEY = "spotter:reports";

export interface Stored {
  v: 1;
  reports: (StoredReport & { token: string })[];
  /** Provisional (queued) id → real id once delivered. */
  aliases: Record<string, string>;
}

export const memory: Stored = { v: 1, reports: [], aliases: {} };

export function read(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return memory.reports.length ? memory : { v: 1, reports: [], aliases: {} };
    const parsed = JSON.parse(raw) as Stored;
    return parsed?.v === 1 && Array.isArray(parsed.reports) ? { ...parsed, aliases: parsed.aliases ?? {} } : { v: 1, reports: [], aliases: {} };
  } catch {
    return memory;
  }
}

export function storedReports(): StoredReport[] {
  return read().reports.map(({ token: _t, ...r }) => r);
}
