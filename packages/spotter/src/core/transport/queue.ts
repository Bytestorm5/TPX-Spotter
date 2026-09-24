/**
 * The offline queue: reports, pending artifact uploads, completes and flag
 * batches that couldn't be delivered, persisted in IndexedDB (Blobs and
 * typed arrays are structured-cloneable, so artifacts survive a reload) and
 * replayed on `online` and on the next page load.
 *
 * Falls back to memory when IndexedDB is missing or fails (private mode,
 * storage blocked, quota) — the reporter still gets a confirmation, the
 * report just can't outlive the tab.
 */
import type { FlagBatch, ReportReceipt, ReportSubmission } from "../schema.ts";

export interface QueuedArtifact {
  name: string;
  contentType: string;
  data: Blob | Uint8Array;
}

export type QueueItem =
  | { kind: "report"; id: string; at: number; attempts: number; submission: ReportSubmission; artifacts: QueuedArtifact[] }
  | { kind: "upload"; id: string; at: number; attempts: number; receipt: ReportReceipt; artifacts: QueuedArtifact[] }
  | { kind: "flags"; id: string; at: number; attempts: number; batch: FlagBatch };

export interface OfflineQueue {
  put(item: QueueItem): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<QueueItem[]>;
  clear(): Promise<void>;
  readonly backend: "indexeddb" | "memory";
}

/** Items older than this are dropped on read (a week-old report is noise, and storage isn't free). */
export const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_MAX_ITEMS = 100;

export function memoryQueue(): OfflineQueue {
  const items = new Map<string, QueueItem>();
  return {
    backend: "memory",
    async put(item) {
      items.set(item.id, item);
      trim(items);
    },
    async remove(id) {
      items.delete(id);
    },
    async all() {
      const now = Date.now();
      return [...items.values()].filter((i) => now - i.at < QUEUE_MAX_AGE_MS).sort((a, b) => a.at - b.at);
    },
    async clear() {
      items.clear();
    },
  };
}

/** Keep the newest QUEUE_MAX_ITEMS, dropping flag batches before reports. */
function trim(items: Map<string, QueueItem>): void {
  if (items.size <= QUEUE_MAX_ITEMS) return;
  const sorted = [...items.values()].sort((a, b) => (a.kind === "flags" ? 0 : 1) - (b.kind === "flags" ? 0 : 1) || a.at - b.at);
  for (const item of sorted.slice(0, items.size - QUEUE_MAX_ITEMS)) items.delete(item.id);
}

const DB_NAME = "trusplex-spotter";
const STORE = "queue";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbQueue(factory: IDBFactory, name = DB_NAME): OfflineQueue {
  let db: Promise<IDBDatabase> | undefined;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error("indexedDB blocked"));
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await open();
    return req(fn(d.transaction(STORE, mode).objectStore(STORE)));
  };
  return {
    backend: "indexeddb",
    async put(item) {
      await tx("readwrite", (s) => s.put(item));
      const all = await this.all();
      if (all.length > QUEUE_MAX_ITEMS) {
        const map = new Map(all.map((i) => [i.id, i]));
        const before = new Set(map.keys());
        trim(map);
        for (const id of before) if (!map.has(id)) await tx("readwrite", (s) => s.delete(id));
      }
    },
    async remove(id) {
      await tx("readwrite", (s) => s.delete(id));
    },
    async all() {
      const now = Date.now();
      const items = (await tx("readonly", (s) => s.getAll())) as QueueItem[];
      const fresh: QueueItem[] = [];
      for (const i of items) {
        if (now - i.at < QUEUE_MAX_AGE_MS) fresh.push(i);
        else await tx("readwrite", (s) => s.delete(i.id));
      }
      return fresh.sort((a, b) => a.at - b.at);
    },
    async clear() {
      await tx("readwrite", (s) => s.clear());
    },
  };
}

/**
 * IndexedDB when available, degrading to memory on the first failure. The
 * degrade is sticky: a store that failed once (quota, private mode) is not
 * retried for the rest of the page's life.
 */
export function createQueue(factory: IDBFactory | undefined = safeIndexedDb()): OfflineQueue {
  const memory = memoryQueue();
  if (!factory) return memory;
  const idb = indexedDbQueue(factory);
  let active: OfflineQueue = idb;
  const guard =
    <A extends unknown[], R>(op: (q: OfflineQueue, ...a: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (active === idb) {
        try {
          return await op(idb, ...args);
        } catch {
          active = memory;
        }
      }
      return op(memory, ...args);
    };
  return {
    get backend() {
      return active.backend;
    },
    put: guard((q, item: QueueItem) => q.put(item)),
    remove: guard((q, id: string) => q.remove(id)),
    all: guard((q) => q.all()),
    clear: guard((q) => q.clear()),
  };
}

function safeIndexedDb(): IDBFactory | undefined {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  } catch {
    return undefined;
  }
}
