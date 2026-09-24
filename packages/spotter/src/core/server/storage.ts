/**
 * Artifact storage for the self-hosted ingest: screenshots, replays,
 * recordings and attachments (chunked, resumable), plus the report records.
 *
 * `memoryStorage()` for tests and single-instance demos; `fileSystemStorage(dir)`
 * for a persistent self-hosted setup (it imports `node:fs` lazily, so an edge
 * bundle that never calls it doesn't break). Anything else — S3, R2, GCS —
 * implements the same six methods.
 */

export interface ArtifactStorage {
  /**
   * Append `chunk` at `offset`. The offset must equal the current size (0 for
   * a new key); otherwise nothing is written. Returns the size after the call,
   * which the handler sends back as `upload-offset`.
   */
  append(key: string, offset: number, chunk: Uint8Array): Promise<number>;
  put(key: string, data: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  /** Current size in bytes, or null when the key doesn't exist. */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Keys are `/`-separated segments of `[A-Za-z0-9._-]`; anything else (including `..`) is rejected. */
export function assertKey(key: string): void {
  if (!key || key.length > 512 || key.split("/").some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === ".."))
    throw new Error(`Spotter storage: invalid key "${key}"`);
}

export function memoryStorage(): ArtifactStorage {
  const data = new Map<string, Uint8Array[]>();
  const sizes = new Map<string, number>();
  const concat = (parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  };
  return {
    async append(key, offset, chunk) {
      assertKey(key);
      const size = sizes.get(key) ?? 0;
      if (offset !== size) return size;
      const parts = data.get(key) ?? [];
      parts.push(chunk.slice());
      data.set(key, parts);
      sizes.set(key, size + chunk.byteLength);
      return size + chunk.byteLength;
    },
    async put(key, bytes) {
      assertKey(key);
      data.set(key, [bytes.slice()]);
      sizes.set(key, bytes.byteLength);
    },
    async read(key) {
      const parts = data.get(key);
      if (!parts) return null;
      const joined = concat(parts);
      data.set(key, [joined]);
      return joined;
    },
    async size(key) {
      return sizes.has(key) ? (sizes.get(key) as number) : null;
    },
    async delete(key) {
      data.delete(key);
      sizes.delete(key);
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

export function fileSystemStorage(dir: string): ArtifactStorage {
  type Fs = typeof import("node:fs/promises");
  type PathMod = typeof import("node:path");
  let mods: Promise<{ fs: Fs; path: PathMod }> | undefined;
  // Lazy: a static import of node:fs would break edge bundles that never use this.
  const load = () =>
    (mods ??= Promise.all([import("node:fs/promises"), import("node:path")]).then(([fs, path]) => ({ fs, path })));
  const locate = async (key: string) => {
    assertKey(key);
    const { fs, path } = await load();
    const file = path.join(dir, ...key.split("/"));
    return { fs, path, file };
  };
  const statSize = async (fs: Fs, file: string): Promise<number | null> => {
    try {
      return (await fs.stat(file)).size;
    } catch {
      return null;
    }
  };
  // Serialise appends per key within this process so offsets can't race.
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };
  return {
    append(key, offset, chunk) {
      return locked(key, async () => {
        const { fs, path, file } = await locate(key);
        const size = (await statSize(fs, file)) ?? 0;
        if (offset !== size) return size;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, chunk);
        return size + chunk.byteLength;
      });
    },
    async put(key, data) {
      const { fs, path, file } = await locate(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${Date.now().toString(36)}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, file);
    },
    async read(key) {
      const { fs, file } = await locate(key);
      try {
        return new Uint8Array(await fs.readFile(file));
      } catch {
        return null;
      }
    },
    async size(key) {
      const { fs, file } = await locate(key);
      return statSize(fs, file);
    },
    async delete(key) {
      const { fs, file } = await locate(key);
      await fs.rm(file, { force: true });
    },
    async list(prefix) {
      const { fs, path } = await load();
      const out: string[] = [];
      const walk = async (rel: string) => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const k = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(k);
          else if (k.startsWith(prefix) && !k.endsWith(".tmp")) out.push(k);
        }
      };
      await walk(prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "");
      return out.sort();
    },
  };
}
