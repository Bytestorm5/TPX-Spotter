/**
 * A ring buffer bounded by entry count AND bytes: every signal buffer holds
 * the last N entries, but a burst of huge entries (a 5 MB response body, a
 * console.log of a store) must not blow the memory budget either. The
 * oldest entries drop first.
 */
import type { Json } from "./schema.ts";
import { byteSize } from "./serialize.ts";

export class RingBuffer<T> {
  private items: T[] = [];
  private sizes: number[] = [];
  /** Index of the oldest live item; compacted lazily so push is O(1) amortized. */
  private start = 0;
  private total = 0;
  private readonly sizeOf: (t: T) => number;

  constructor(
    readonly maxCount: number,
    readonly maxBytes: number,
    sizeOf?: (t: T) => number,
  ) {
    this.sizeOf = sizeOf ?? ((t) => byteSize(t as unknown as Json));
  }

  push(item: T): void {
    if (this.maxCount <= 0) return;
    let size: number;
    try {
      size = Math.max(0, this.sizeOf(item));
    } catch {
      size = 0;
    }
    // An entry bigger than the whole budget can never fit: drop it rather than evict everything.
    if (size > this.maxBytes) return;
    this.items.push(item);
    this.sizes.push(size);
    this.total += size;
    while (this.length > this.maxCount || this.total > this.maxBytes) this.dropOldest();
    if (this.start > 64 && this.start * 2 > this.items.length) {
      this.items = this.items.slice(this.start);
      this.sizes = this.sizes.slice(this.start);
      this.start = 0;
    }
  }

  private dropOldest(): void {
    this.total -= this.sizes[this.start] ?? 0;
    (this.items as (T | undefined)[])[this.start] = undefined;
    this.start++;
  }

  /** Oldest first. */
  toArray(): T[] {
    return this.items.slice(this.start);
  }

  clear(): void {
    this.items = [];
    this.sizes = [];
    this.start = 0;
    this.total = 0;
  }

  get bytes(): number {
    return this.total;
  }

  get length(): number {
    return this.items.length - this.start;
  }
}
