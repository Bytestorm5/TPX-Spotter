/**
 * Delivery on top of a Transport: background artifact uploads followed by
 * `complete`, and draining the offline queue. Transport-agnostic, so custom
 * transports (tests, self-hosted targets) get the same never-drop guarantees.
 */
import type { ReportReceipt } from "../schema.ts";
import type { Transport } from "../types.ts";
import { shortId } from "../ids.ts";
import type { OfflineQueue, QueueItem, QueuedArtifact } from "./queue.ts";
import { isRetryable } from "./retry.ts";

export interface DeliveryEvents {
  /** A queued report reached the ingest: the provisional id now maps to a real receipt. */
  delivered?(pendingId: string, receipt: ReportReceipt): void;
  /** A queued item failed permanently (4xx) and was dropped — surfaced, never silent. */
  failed?(item: QueueItem, error: unknown): void;
}

/**
 * Upload every artifact, then `complete`. Artifacts that fail after the
 * transport's retries go to the queue together with the pending complete, so
 * the issue event still fires once they land.
 */
export async function uploadAndComplete(
  transport: Transport,
  receipt: ReportReceipt,
  artifacts: QueuedArtifact[],
  queue?: OfflineQueue,
): Promise<boolean> {
  const remaining: QueuedArtifact[] = [];
  let lastError: unknown;
  for (const a of artifacts) {
    try {
      await transport.upload(receipt, a.name, a.data, a.contentType);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) continue; // rejected by the ingest (too large, bad name): complete without it
      remaining.push(a);
    }
  }
  if (remaining.length) {
    if (queue) await queue.put({ kind: "upload", id: shortId("u_"), at: Date.now(), attempts: 0, receipt, artifacts: remaining });
    else throw lastError;
    return false;
  }
  try {
    await transport.complete(receipt);
    return true;
  } catch (error) {
    if (queue && isRetryable(error)) {
      await queue.put({ kind: "upload", id: shortId("u_"), at: Date.now(), attempts: 0, receipt, artifacts: [] });
      return false;
    }
    throw error;
  }
}

/** One drain at a time per queue (several clients on a page each have their own). */
const draining = new WeakMap<OfflineQueue, Promise<number>>();

/**
 * Replay the queue in order. Stops at the first retryable failure (we're
 * probably offline again) and leaves the rest for the next `online` event or
 * page load. Returns the number of items delivered.
 */
export function drainQueue(queue: OfflineQueue, transport: Transport, events: DeliveryEvents = {}): Promise<number> {
  const busy = draining.get(queue);
  if (busy) return busy;
  const run = (async () => {
    let delivered = 0;
    try {
      for (const item of await queue.all()) {
        try {
          await deliver(item, queue, transport, events);
          await queue.remove(item.id);
          delivered++;
        } catch (error) {
          if (isRetryable(error)) {
            await queue.put({ ...item, attempts: item.attempts + 1 });
            break;
          }
          await queue.remove(item.id);
          events.failed?.(item, error);
        }
      }
    } finally {
      draining.delete(queue);
    }
    return delivered;
  })();
  draining.set(queue, run);
  return run;
}

async function deliver(item: QueueItem, queue: OfflineQueue, transport: Transport, events: DeliveryEvents): Promise<void> {
  switch (item.kind) {
    case "report": {
      const receipt = await transport.submit(item.submission);
      events.delivered?.(item.id, receipt);
      // artifacts that fail from here are re-queued as an upload item
      await uploadAndComplete(transport, receipt, item.artifacts, queue);
      return;
    }
    case "upload": {
      for (const a of item.artifacts) await transport.upload(item.receipt, a.name, a.data, a.contentType);
      await transport.complete(item.receipt);
      return;
    }
    case "flags":
      await transport.flags(item.batch);
      return;
  }
}
