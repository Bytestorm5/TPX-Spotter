/**
 * A ring buffer bounded by entry count AND bytes: every signal buffer holds
 * the last N entries, but a burst of huge entries (a 5 MB response body, a
 * console.log of a store) must not blow the memory budget either. The
 * oldest entries drop first.
 */
import type { Json } from "./schema.ts";

export class RingBuffer<T> {
  private items: T[] = [];
  private sizes: number[] = [];
  /** Approximate bytes held. */
  bytes = 0;

  constructor(
    readonly maxCount: number,
    readonly maxBytes: number,
    private readonly sizeOf: (t: T) => number = (t) => byteSize(t as unknown as Json),
  ) {}

  push(item: T): void {
    if (this.maxCount <= 0) return;
    let size = 0;
    try {
      size = Math.max(0, this.sizeOf(item));
    } catch {
      /* unmeasurable: count it as free */
    }
    // An entry bigger than the whole budget can never fit: drop it rather than evict everything.
    if (size > this.maxBytes) return;
    this.items.push(item);
    this.sizes.push(size);
    this.bytes += size;
    // Buffers hold at most a few hundred entries: shifting is cheap enough.
    while (this.items.length > this.maxCount || this.bytes > this.maxBytes) {
      this.items.shift();
      this.bytes -= this.sizes.shift() ?? 0;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
    this.sizes = [];
    this.bytes = 0;
  }

  get length(): number {
    return this.items.length;
  }
}

/** Truncate a string to `max` chars, appending a marker that says how much was cut. */
export function truncate(value: string, max = 8192): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

/** UTF-8 byte length of a string, without allocating an encoder. */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Approximate UTF-8 bytes of the JSON encoding of `value` — what it costs in a buffer or on the wire. */
export function byteSize(value: Json): number {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : utf8Length(s);
  } catch {
    return 0;
  }
}
