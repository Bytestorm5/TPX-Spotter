/**
 * Storage snapshot: the keys in localStorage, sessionStorage and cookies.
 * Values are captured only for keys allowlisted in `privacy.storageValues`
 * (exact names, or globs with `*`), and are redacted. Never throws: storage
 * access fails in Safari private mode, sandboxed iframes and with cookies
 * blocked.
 */
import type { StorageSnapshot } from "../schema.ts";
import type { Runtime } from "../internal.ts";
import { truncate } from "../serialize.ts";

const MAX_KEYS = 200;
const MAX_VALUE = 1024;

function matcher(allow: readonly string[]): (key: string) => boolean {
  const res = allow.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return (key) => res.some((re) => re.test(key));
}

function readStorage(get: () => Storage | undefined, rt: Runtime, allowed: (k: string) => boolean): { key: string; value?: string }[] {
  const out: { key: string; value?: string }[] = [];
  let store: Storage | undefined;
  try {
    store = get();
  } catch {
    return out;
  }
  if (!store) return out;
  try {
    const n = Math.min(store.length, MAX_KEYS);
    for (let i = 0; i < n; i++) {
      const key = store.key(i);
      if (key === null) continue;
      const item: { key: string; value?: string } = { key: rt.redact(key, "context") };
      if (allowed(key)) {
        const value = store.getItem(key);
        if (value !== null) item.value = rt.redact(truncate(value, MAX_VALUE), "context");
      }
      out.push(item);
    }
  } catch {
    /* access denied mid-read */
  }
  return out;
}

export function collectStorage(rt: Runtime, allowValues: string[]): StorageSnapshot {
  const allowed = matcher(allowValues ?? []);
  const snap: StorageSnapshot = { localStorage: [], sessionStorage: [], cookies: [] };
  if (typeof window === "undefined") return snap;
  snap.localStorage = readStorage(() => window.localStorage, rt, allowed);
  snap.sessionStorage = readStorage(() => window.sessionStorage, rt, allowed);
  try {
    const raw = typeof document !== "undefined" ? document.cookie : "";
    for (const part of raw ? raw.split(";") : []) {
      if (snap.cookies.length >= MAX_KEYS) break;
      const eq = part.indexOf("=");
      const key = (eq === -1 ? part : part.slice(0, eq)).trim();
      if (!key) continue;
      const item: { key: string; value?: string } = { key: rt.redact(key, "context") };
      if (allowed(key)) {
        let value = eq === -1 ? "" : part.slice(eq + 1).trim();
        try {
          value = decodeURIComponent(value);
        } catch {
          /* keep raw */
        }
        item.value = rt.redact(truncate(value, MAX_VALUE), "context");
      }
      snap.cookies.push(item);
    }
  } catch {
    /* cookies blocked */
  }
  return snap;
}
