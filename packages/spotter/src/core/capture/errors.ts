/**
 * Uncaught errors and unhandled rejections, plus the helpers the client uses
 * for `captureException` and error boundaries: `errorEntryFrom()` turns any
 * thrown value into an `ErrorEntry`, `parseStack()` reads V8, SpiderMonkey
 * and JavaScriptCore stack formats into frames (source-mapped later, by the
 * ingest).
 */
import type { ErrorEntry, StackFrame } from "../schema.ts";
import type { RedactionSite } from "../types.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer } from "../buffer.ts";
import { safeSerialize, truncate } from "../serialize.ts";
import { hasDom, iso, listen } from "./util.ts";

const MAX_FRAMES = 50;
const MAX_STACK = 16 * 1024;

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** `file:line:col` (or `file:line`) → parts; the file itself may contain colons (`https://…`). */
function splitLocation(loc: string): Pick<StackFrame, "file" | "line" | "column"> {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(loc.trim());
  if (!m) return { file: loc.trim() || undefined };
  return { file: m[1] || undefined, line: toInt(m[2]), column: toInt(m[3]) };
}

function frame(fn: string | undefined, loc: Pick<StackFrame, "file" | "line" | "column">): StackFrame {
  const out: StackFrame = {};
  const name = fn?.trim();
  if (name) out.function = name;
  if (loc.file) out.file = loc.file;
  if (loc.line !== undefined) out.line = loc.line;
  if (loc.column !== undefined) out.column = loc.column;
  return out;
}

/**
 * Parse a stack trace into frames, innermost first.
 *
 * - V8: `    at fn (file:1:2)`, `    at file:1:2`, `    at async fn (…)`,
 *   `    at new Foo (…)`, `    at fn (eval at g (file:1:2), <anonymous>:3:4)`
 * - SpiderMonkey: `fn@file:1:2`, `@file:1:2`, `fn@file line 5 > eval:1:2`
 * - JavaScriptCore: `fn@file:1:2`, `global code@file:1:2`, `fn@[native code]`
 */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  if (typeof stack !== "string" || !stack) return frames;
  for (const raw of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break;
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("at ")) {
      let rest = line.slice(3).trim();
      if (rest.startsWith("async ")) rest = rest.slice(6);
      const open = rest.indexOf(" (");
      if (open !== -1 && rest.endsWith(")")) {
        const fn = rest.slice(0, open);
        let loc = rest.slice(open + 2, -1);
        if (loc.startsWith("eval at ")) {
          // The eval's call site is the useful location.
          const inner = /\(([^()]+:\d+:\d+)\)/.exec(loc);
          loc = inner?.[1] ?? loc;
        }
        if (loc === "native" || loc === "<anonymous>") frames.push(frame(fn, { file: loc }));
        else if (/:\d+(?::\d+)?$/.test(loc)) frames.push(frame(fn, splitLocation(loc)));
        else frames.push(frame(fn, {})); // e.g. `Promise.all (index 0)`: no location
      } else if (/:\d+(?::\d+)?$/.test(rest)) {
        frames.push(frame(undefined, splitLocation(rest)));
      } else if (rest) {
        frames.push(frame(rest, {}));
      }
      continue;
    }
    const at = line.indexOf("@");
    if (at !== -1) {
      const fn = line.slice(0, at);
      let loc = line.slice(at + 1);
      if (loc === "[native code]") {
        frames.push(frame(fn, { file: loc }));
        continue;
      }
      // SpiderMonkey eval: `file line 5 > eval:1:2` → the outer file and line.
      const evalMatch = /^(.*?) line (\d+) > (?:eval|Function)/.exec(loc);
      if (evalMatch) {
        frames.push(frame(fn, { file: evalMatch[1], line: toInt(evalMatch[2]) }));
        continue;
      }
      loc = loc.trim();
      if (!loc) continue;
      frames.push(frame(fn, splitLocation(loc)));
    }
    // Anything else (the "TypeError: …" header, blank lines) isn't a frame.
  }
  return frames;
}

const identity = (s: string) => s;

/**
 * Normalize anything that was thrown or rejected into an `ErrorEntry`.
 * Non-Error values keep a serialized, truncated message. Pass `redact` to
 * scrub message and stack (the installed handler always does).
 */
export function errorEntryFrom(
  error: unknown,
  mechanism: ErrorEntry["mechanism"],
  redact: (value: string, where: RedactionSite) => string = identity,
  at: number = Date.now(),
): ErrorEntry {
  let type = "Error";
  let message = "";
  let stack: string | undefined;
  let componentStack: string | undefined;
  try {
    if (error instanceof Error || (error && typeof error === "object" && "message" in error && "name" in error)) {
      const e = error as Error & { componentStack?: unknown; cause?: unknown };
      type = String(e.name || e.constructor?.name || "Error");
      message = String(e.message ?? "");
      if (typeof e.stack === "string") stack = e.stack;
      if (typeof e.componentStack === "string") componentStack = e.componentStack;
      // Fold one level of `cause` into the stack so it survives source mapping.
      const cause = e.cause;
      if (cause instanceof Error && typeof cause.stack === "string") {
        stack = `${stack ?? ""}\nCaused by: ${cause.stack}`;
      } else if (cause !== undefined && cause !== null) {
        const s = safeSerialize(cause, { maxString: 500, maxDepth: 2 });
        stack = `${stack ?? ""}\nCaused by: ${typeof s === "string" ? s : JSON.stringify(s)}`;
      }
    } else if (typeof error === "string") {
      message = error;
    } else {
      const s = safeSerialize(error, { maxString: 1000, maxDepth: 3 });
      message = `Non-Error thrown: ${typeof s === "string" ? s : JSON.stringify(s)}`;
    }
  } catch {
    message = "[unreadable error]";
  }
  const entry: ErrorEntry = {
    at: iso(at),
    type: truncate(redact(type, "error"), 200),
    message: truncate(redact(message, "error"), 8192),
    frames: [],
    mechanism,
  };
  if (stack) {
    entry.stack = redact(truncate(stack, MAX_STACK), "error");
    entry.frames = parseStack(entry.stack);
  }
  if (componentStack) entry.componentStack = redact(truncate(componentStack, MAX_STACK), "error");
  return entry;
}

export function installErrors(rt: Runtime, _opts: Record<string, never> = {}): Signal<ErrorEntry[]> {
  const buffer = new RingBuffer<ErrorEntry>(50, 256 * 1024);
  const undo: (() => void)[] = [];
  const seen = new WeakSet<object>();
  let active = true;

  const capture = (error: unknown, mechanism: ErrorEntry["mechanism"], fallback?: Partial<ErrorEntry>) => {
    if (!active) return;
    try {
      if (error && typeof error === "object") {
        if (seen.has(error)) return;
        seen.add(error);
      }
      const entry = errorEntryFrom(error, mechanism, (v, w) => rt.redact(v, w), rt.now());
      if (fallback && !entry.frames.length && fallback.frames) entry.frames = fallback.frames;
      buffer.push(entry);
      rt.breadcrumb({
        at: entry.at,
        category: "error",
        level: "error",
        message: truncate(`${entry.type}: ${entry.message}`, 200),
      });
      rt.error(entry);
    } catch (e) {
      active = false;
      try {
        rt.fault("errors", e);
      } catch {
        /* never throw into the host */
      }
    }
  };

  if (hasDom()) {
    undo.push(
      listen(
        window,
        "error",
        (event) => {
          const e = event as ErrorEvent;
          // Resource load failures (img/script 404) bubble here as plain Events: not JS errors.
          if (!(typeof ErrorEvent !== "undefined" && e instanceof ErrorEvent) && !("message" in e)) return;
          if (e.error !== undefined && e.error !== null) {
            capture(e.error, "uncaught");
          } else {
            // Cross-origin "Script error." or a browser that doesn't pass the error object.
            capture(String(e.message || "Script error."), "uncaught", {
              frames: e.filename ? [{ file: e.filename, line: e.lineno, column: e.colno }] : [],
            });
          }
        },
        { capture: true, passive: true },
      ),
    );
    undo.push(
      listen(
        window,
        "unhandledrejection",
        (event) => {
          capture((event as PromiseRejectionEvent).reason, "unhandledrejection");
        },
        { capture: true, passive: true },
      ),
    );
  }

  return {
    name: "errors",
    snapshot: () => buffer.toArray(),
    destroy() {
      active = false;
      for (const fn of undo.splice(0)) fn();
      buffer.clear();
    },
  };
}
