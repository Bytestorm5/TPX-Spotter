/**
 * Console capture: patches `log`, `info`, `warn`, `error` and `debug`
 * reversibly and keeps the last N entries (count- and byte-bounded), with
 * arguments serialized safely and redacted.
 *
 * Spotter never captures itself: a re-entrancy guard stops recursion if
 * anything we call logs, and `runUncaptured()` lets the client emit its own
 * dev warnings without them landing in reports.
 */
import type { ConsoleEntry, ConsoleLevel, Json } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer } from "../buffer.ts";
import { mapStrings, safeSerialize, truncate } from "../serialize.ts";
import { iso, patchMethod } from "./util.ts";

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

export function installConsole(rt: Runtime, opts: { max: number }): Signal<ConsoleEntry[]> {
  const buffer = new RingBuffer<ConsoleEntry>(Math.max(0, opts.max), MAX_BYTES);
  const undo: (() => void)[] = [];
  let active = true;
  let inside = false;
  const target = typeof console !== "undefined" ? console : null;

  const record = (level: ConsoleLevel, args: unknown[]) => {
    if (typeof args[0] === "string" && OWN_PREFIX.test(args[0])) return;
    const serialized: Json[] = args.slice(0, 20).map((a) => mapStrings(safeSerialize(a), (s) => rt.redact(s, "console")));
    const entry: ConsoleEntry = { level, at: iso(rt.now()), args: serialized };
    if (level === "warn" || level === "error") {
      const stack = new Error().stack;
      if (stack) {
        // Drop the "Error" line and our own two frames (record + wrapper).
        const lines = stack.split("\n");
        const start = /^\s*at |@/.test(lines[0] ?? "") ? 2 : 3;
        entry.stack = rt.redact(truncate(lines.slice(start).join("\n"), 4096), "console");
      }
      const first = serialized[0];
      const message = typeof first === "string" ? first : JSON.stringify(first ?? "");
      rt.breadcrumb({
        at: entry.at,
        category: "console",
        level: level === "error" ? "error" : "warning",
        message: truncate(message ?? "", 200),
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
                try {
                  rt.fault("console", error);
                } catch {
                  /* never throw into the host */
                }
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
