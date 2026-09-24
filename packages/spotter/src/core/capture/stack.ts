/**
 * Report-time half of error capture (session chunk): parse stacks into
 * frames (V8, SpiderMonkey and JavaScriptCore formats; source-mapped later by
 * the ingest), serialize non-Error values and redact — turning the raw
 * records `installErrors()` holds into `ErrorEntry`s. `errorEntryFrom()` does
 * both steps at once, for `captureException` and error boundaries.
 */
import type { ErrorEntry, StackFrame } from "../schema.ts";
import type { RedactionSite } from "../types.ts";
import { truncate } from "../buffer.ts";
import { safeSerialize } from "../serialize.ts";
import { rawError, type RawError } from "./errors.ts";
import { iso } from "./util.ts";

const MAX_FRAMES = 50;

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

const serialized = (v: unknown, maxString: number, maxDepth: number) => {
  const s = safeSerialize(v, { maxString, maxDepth });
  return typeof s === "string" ? s : JSON.stringify(s);
};

/** Serialize, redact and parse a raw error into an `ErrorEntry`. */
export function finalizeError(raw: RawError, redact: (value: string, where: RedactionSite) => string = identity): ErrorEntry {
  let message = raw.message;
  let stack = raw.stack;
  try {
    if ("value" in raw) message = `Non-Error thrown: ${serialized(raw.value, 1000, 3)}`;
    if (raw.cause !== undefined) stack = truncate(`${stack ?? ""}\nCaused by: ${serialized(raw.cause, 500, 2)}`, 16 * 1024);
  } catch {
    message = "[unreadable error]";
  }
  const entry: ErrorEntry = {
    at: iso(raw.at),
    type: truncate(redact(raw.type, "error"), 200),
    message: truncate(redact(message, "error"), 8192),
    frames: [],
    mechanism: raw.mechanism,
  };
  if (stack) {
    entry.stack = redact(stack, "error");
    entry.frames = parseStack(entry.stack);
  }
  if (!entry.frames.length && raw.frames) entry.frames = raw.frames;
  if (raw.componentStack) entry.componentStack = redact(raw.componentStack, "error");
  return entry;
}

/**
 * Normalize anything that was thrown or rejected into an `ErrorEntry`.
 * Non-Error values keep a serialized, truncated message. Pass `redact` to
 * scrub message and stack.
 */
export function errorEntryFrom(
  error: unknown,
  mechanism: ErrorEntry["mechanism"],
  redact: (value: string, where: RedactionSite) => string = identity,
  at: number = Date.now(),
): ErrorEntry {
  return finalizeError(rawError(error, mechanism, at), redact);
}
