/**
 * gzip for replay payloads. fflate's async `gzip` compresses in a Web Worker
 * (spawned from a blob URL), keeping the main thread free; a strict CSP
 * without `worker-src blob:` blocks that, so we fall back to `gzipSync`.
 * Once the worker path has failed we stop trying it.
 */
import { gzip, gzipSync, strToU8 } from "fflate";

let workerBroken = false;
let lastPath: "worker" | "sync" | null = null;

/** Which path the last compression took (diagnostics and tests). */
export function lastCompressionPath(): "worker" | "sync" | null {
  return lastPath;
}
const WORKER_TIMEOUT_MS = 10_000;

export function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (workerBroken || typeof Worker === "undefined") {
    lastPath = "sync";
    return Promise.resolve(gzipSync(data, { level: 6 }));
  }
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      workerBroken = true;
      lastPath = "sync";
      resolve(gzipSync(data, { level: 6 }));
    };
    // A worker silently blocked by CSP may never answer.
    const timer = setTimeout(fallback, WORKER_TIMEOUT_MS);
    try {
      // `consume: false`: the caller's buffer stays usable for the sync fallback.
      gzip(data, { level: 6, consume: false }, (err, out) => {
        clearTimeout(timer);
        if (settled) return;
        if (err || !out) return fallback();
        settled = true;
        lastPath = "worker";
        resolve(out);
      });
    } catch {
      clearTimeout(timer);
      fallback();
    }
  });
}

/** JSON-encode and gzip a list of events. */
export function compressEvents(events: readonly unknown[]): Promise<Uint8Array> {
  return gzipBytes(strToU8(JSON.stringify(events)));
}
