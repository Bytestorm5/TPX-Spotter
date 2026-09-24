/**
 * Console capture: patches `log`, `info`, `warn`, `error` and `debug`
 * reversibly and keeps the last N entries (count- and byte-bounded). At call
 * time each argument gets a cheap bounded copy (`copyValue`), so later
 * mutation doesn't change the record; safe serialization and redaction run
 * at snapshot time (`finalizeConsole`, session chunk), before anything is
 * sent.
 *
 * Spotter never captures itself: a re-entrancy guard stops recursion if
 * anything we call logs, and `runUncaptured()` lets the client emit its own
 * dev warnings without them landing in reports.
 */
import type { ConsoleLevel } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer, truncate } from "../buffer.ts";
import { copyValue, iso, patchMethod } from "./util.ts";

/** A console call as held: argument copies, serialized and redacted at snapshot. */
export interface RawConsoleEntry {
  level: ConsoleLevel;
  at: string;
  args: unknown[];
  stack?: string;
  /** Approximate bytes, for the buffer bound. */
  size: number;
}

const LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
const MAX_BYTES = 256 * 1024;

let suppressed = 0;

/** Run `fn` with console capture off — for Spotter's own dev warnings. */
export function runUncaptured<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

/** Messages Spotter itself prints are prefixed; never capture them even if they bypass `runUncaptured`. */
const OWN_PREFIX = /^\[(?:spotter|Spotter|@trusplex\/spotter)\]/;

export function installConsole(rt: Runtime, opts: { max: number }): Signal<RawConsoleEntry[]> {
  const buffer = new RingBuffer<RawConsoleEntry>(Math.max(0, opts.max), MAX_BYTES, (e) => e.size);
  const undo: (() => void)[] = [];
  let active = true;
  let inside = false;
  const target = typeof console !== "undefined" ? console : null;

  const record = (level: ConsoleLevel, args: unknown[]) => {
    if (typeof args[0] === "string" && OWN_PREFIX.test(args[0])) return;
    const size = { n: 0 };
    const copies = args.slice(0, 20).map((a) => copyValue(a, size));
    const entry: RawConsoleEntry = { level, at: iso(rt.now()), args: copies, size: size.n };
    if (level === "warn" || level === "error") {
      const stack = new Error().stack;
      if (stack) {
        // Drop the "Error" line and our own two frames (record + wrapper).
        const lines = stack.split("\n");
        const start = /^\s*at |@/.test(lines[0] ?? "") ? 2 : 3;
        entry.stack = truncate(lines.slice(start).join("\n"), 4096);
        entry.size += entry.stack.length;
      }
      const first = copies[0];
      // Redacted (and a non-string argument serialized), then capped at 200 chars, at snapshot time.
      rt.breadcrumb({
        at: entry.at,
        category: "console",
        level: level === "error" ? "error" : "warning",
        message: typeof first === "string" ? truncate(first, 1000) : "",
        ...(typeof first === "string" ? {} : { value: first }),
        max: 200,
      });
    }
    buffer.push(entry);
  };

  if (target) {
    for (const level of LEVELS) {
      if (typeof target[level] !== "function") continue;
      undo.push(
        patchMethod(target, level, (original) =>
          function spotterConsole(this: unknown, ...args: unknown[]) {
            if (active && !inside && suppressed === 0) {
              inside = true;
              try {
                record(level, args);
              } catch (error) {
                active = false;
                rt.fault("console", error); // the engine's fault() never throws
              } finally {
                inside = false;
              }
            }
            return (original as (...a: unknown[]) => unknown).apply(this ?? target, args);
          } as Console[typeof level],
        ),
      );
    }
  }

  return {
    name: "console",
    snapshot: () => buffer.toArray(),
    destroy() {
      active = false;
      for (const fn of undo.splice(0)) fn();
      buffer.clear();
    },
  };
}
