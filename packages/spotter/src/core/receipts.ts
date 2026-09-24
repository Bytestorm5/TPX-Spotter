/**
 * Reports this browser filed, with their reporter tokens, in localStorage —
 * so `status()` / `reply()` work after a reload and `<SpotterStatus/>` can
 * poll. Tokens are capabilities for one report's public status only (no
 * access to the ticket), so localStorage is an acceptable home; every access
 * is wrapped because storage can be blocked or throw.
 */
import type { PublicStatus, ReportReceipt } from "./schema.ts";
import type { StoredReport } from "./types.ts";

const KEY = "spotter:reports";
const MAX = 50;

interface Stored {
  v: 1;
  reports: (StoredReport & { token: string })[];
  /** Provisional (queued) id → real id once delivered. */
  aliases: Record<string, string>;
}

const memory: Stored = { v: 1, reports: [], aliases: {} };

function read(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return memory.reports.length ? memory : { v: 1, reports: [], aliases: {} };
    const parsed = JSON.parse(raw) as Stored;
    return parsed?.v === 1 && Array.isArray(parsed.reports) ? { ...parsed, aliases: parsed.aliases ?? {} } : { v: 1, reports: [], aliases: {} };
  } catch {
    return memory;
  }
}

function write(s: Stored): void {
  s.reports = s.reports.slice(0, MAX);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
  } catch {
    Object.assign(memory, s);
  }
}

export function rememberReport(receipt: ReportReceipt, title: string, createdAt: string): void {
  const s = read();
  s.reports = s.reports.filter((r) => r.id !== receipt.id);
  s.reports.unshift({
    id: receipt.id,
    ref: receipt.ref,
    title: title.slice(0, 200),
    createdAt,
    token: receipt.token,
    ...(receipt.statusUrl ? { statusUrl: receipt.statusUrl } : {}),
    ...(receipt.queued ? { queued: true } : {}),
  });
  write(s);
}

/** A queued report got its real receipt. */
export function resolvePending(pendingId: string, receipt: ReportReceipt): void {
  const s = read();
  const old = s.reports.find((r) => r.id === pendingId);
  s.reports = s.reports.filter((r) => r.id !== pendingId && r.id !== receipt.id);
  s.reports.unshift({
    id: receipt.id,
    ref: receipt.ref,
    title: old?.title ?? "",
    createdAt: old?.createdAt ?? new Date().toISOString(),
    token: receipt.token,
    ...(receipt.statusUrl ? { statusUrl: receipt.statusUrl } : {}),
  });
  s.aliases[pendingId] = receipt.id;
  write(s);
}

export function lookupReport(id: string): (StoredReport & { token: string }) | undefined {
  const s = read();
  const real = s.aliases[id] ?? id;
  return s.reports.find((r) => r.id === real);
}

export function noteStatus(id: string, status: PublicStatus): boolean {
  const s = read();
  const r = s.reports.find((x) => x.id === (s.aliases[id] ?? id));
  if (!r || r.lastStatus === status) return false;
  r.lastStatus = status;
  write(s);
  return true;
}

export function storedReports(): StoredReport[] {
  return read().reports.map(({ token: _t, ...r }) => r);
}
