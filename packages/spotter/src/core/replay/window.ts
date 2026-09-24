/**
 * The rolling replay buffer, as pure logic (no rrweb, no DOM) so it can be
 * tested exactly.
 *
 * rrweb events only replay from a full snapshot, so the buffer is a list of
 * *checkout chains*: a Meta + FullSnapshot followed by the incremental
 * events that build on it. rrweb's `checkoutEveryNms` starts a new chain
 * periodically. Pruning drops whole chains: we keep the newest chain that
 * starts at or before the window's start (so the window is replayable from
 * its first moment) and everything after it.
 *
 * Memory is bounded too: over the target (~2 MB) the oldest chains go even if
 * they're inside the window; a single chain over the hard cap (5 MB) asks the
 * recorder for a fresh checkout so the old chain can be dropped.
 */

export const EVENT_FULL_SNAPSHOT = 2;
export const EVENT_META = 4;

export interface ReplayEventLike {
  type: number;
  timestamp: number;
}

interface Chain<E> {
  start: number;
  events: E[];
  bytes: number;
  hasFull: boolean;
}

export interface ReplayWindowOptions<E> {
  windowMs: number;
  /** Soft budget: drop older chains beyond it. Default 2 MB. */
  targetBytes?: number;
  /** Hard cap: never hold more than this. Default 5 MB. */
  hardCapBytes?: number;
  sizeOf?: (e: E) => number;
}

export function estimateEventSize(e: unknown): number {
  try {
    return JSON.stringify(e)?.length ?? 0;
  } catch {
    return 0;
  }
}

export class ReplayWindow<E extends ReplayEventLike> {
  private chains: Chain<E>[] = [];
  private total = 0;
  readonly windowMs: number;
  private readonly targetBytes: number;
  private readonly hardCapBytes: number;
  private readonly sizeOf: (e: E) => number;

  constructor(opts: ReplayWindowOptions<E>) {
    this.windowMs = opts.windowMs;
    this.targetBytes = opts.targetBytes ?? 2 * 1024 * 1024;
    this.hardCapBytes = opts.hardCapBytes ?? 5 * 1024 * 1024;
    this.sizeOf = opts.sizeOf ?? estimateEventSize;
  }

  /**
   * Add an event. Returns `true` when the buffer needs a fresh checkout
   * (a full snapshot) to get back under the hard cap.
   */
  push(event: E, isCheckout?: boolean): boolean {
    const size = this.sizeOf(event);
    let chain = this.chains[this.chains.length - 1];
    const startsChain =
      !chain ||
      (event.type === EVENT_META && (isCheckout || chain.hasFull)) ||
      (event.type === EVENT_FULL_SNAPSHOT && chain.hasFull);
    if (startsChain) {
      chain = { start: event.timestamp, events: [], bytes: 0, hasFull: false };
      this.chains.push(chain);
    }
    if (!chain) return false;
    chain.events.push(event);
    chain.bytes += size;
    if (event.type === EVENT_FULL_SNAPSHOT) chain.hasFull = true;
    this.total += size;
    this.prune(event.timestamp);
    return this.total > this.hardCapBytes && this.chains.length === 1;
  }

  /** Drop chains that are entirely before the window, then enforce the byte budgets. */
  prune(now: number): void {
    const cutoff = now - this.windowMs;
    // The newest chain starting at/before the cutoff is still needed to replay the window's start.
    let keepFrom = 0;
    for (let i = 0; i < this.chains.length; i++) {
      if ((this.chains[i]?.start ?? Infinity) <= cutoff) keepFrom = i;
    }
    // Chains without a full snapshot can't be replayed on their own: never keep one as the first.
    while (keepFrom < this.chains.length - 1 && !this.chains[keepFrom]?.hasFull) keepFrom++;
    this.dropChains(keepFrom);
    while (this.chains.length > 1 && this.total > this.targetBytes) this.dropChains(1);
    // A lone chain over the hard cap: shed its oldest incremental events is not an option
    // (the rest depend on them), so the caller takes a fresh checkout and we drop it then.
  }

  private dropChains(n: number): void {
    for (const c of this.chains.splice(0, n)) this.total -= c.bytes;
  }

  /** The retained events, oldest first. */
  events(): E[] {
    const out: E[] = [];
    for (const c of this.chains) for (const e of c.events) out.push(e);
    return out;
  }

  /** Time covered by the retained events. */
  range(): { start: number; end: number } | null {
    const first = this.chains[0]?.events[0];
    const lastChain = this.chains[this.chains.length - 1];
    const last = lastChain?.events[lastChain.events.length - 1];
    return first && last ? { start: first.timestamp, end: last.timestamp } : null;
  }

  get bytes(): number {
    return this.total;
  }

  get chainCount(): number {
    return this.chains.length;
  }

  get length(): number {
    let n = 0;
    for (const c of this.chains) n += c.events.length;
    return n;
  }

  clear(): void {
    this.chains = [];
    this.total = 0;
  }
}

/** rrweb checkout interval for a window: half the window (≥ 10 s), so a snapshot is never more than half a window stale. */
export function checkoutInterval(windowSeconds: number): number {
  return Math.max(10_000, Math.round((windowSeconds * 1000) / 2));
}

/** Clamp a configured window to the supported 15–300 s range (default 60). */
export function clampWindowSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 60;
  return Math.min(300, Math.max(15, value));
}
