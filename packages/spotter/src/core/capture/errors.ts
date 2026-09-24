/**
 * Uncaught errors and unhandled rejections. What loads at init is only the
 * cheap part: `rawError()` reads name, message and stack strings off the
 * thrown value (a bounded copy for non-Error values) the moment it is
 * thrown. Parsing the stack into frames, serializing and redaction happen at
 * snapshot time (`stack.ts`, in the session chunk: `parseStack()`,
 * `finalizeError()`, `errorEntryFrom()`), before anything is sent.
 */
import type { ErrorEntry, StackFrame } from "../schema.ts";
import type { Runtime, Signal } from "../internal.ts";
import { RingBuffer, truncate } from "../buffer.ts";
import { copyValue, hasDom, iso, listen } from "./util.ts";

const MAX_STACK = 16 * 1024;

/** A captured error before redaction and stack parsing. */
export interface RawError {
  /** ms since epoch */
  at: number;
  type: string;
  message: string;
  /** A thrown non-Error value (bounded copy); `message` is derived from it at snapshot. */
  value?: unknown;
  stack?: string;
  /** A non-Error `cause` (bounded copy), folded into the stack at snapshot. */
  cause?: unknown;
  componentStack?: string;
  /** Frames known without a stack (cross-origin "Script error." location). */
  frames?: StackFrame[];
  mechanism: ErrorEntry["mechanism"];
}

/** Read anything thrown or rejected — cheaply, now, since the value may change later. */
export function rawError(error: unknown, mechanism: ErrorEntry["mechanism"], at: number = Date.now()): RawError {
  const raw: RawError = { at, type: "Error", message: "", mechanism };
  try {
    if (error instanceof Error || (error && typeof error === "object" && "message" in error && "name" in error)) {
      const e = error as Error & { componentStack?: unknown; cause?: unknown };
      raw.type = truncate(String(e.name || e.constructor?.name || "Error"), 1000);
      raw.message = truncate(String(e.message ?? ""), MAX_STACK);
      if (typeof e.stack === "string") raw.stack = e.stack;
      if (typeof e.componentStack === "string") raw.componentStack = truncate(e.componentStack, MAX_STACK);
      // Fold one level of `cause` into the stack so it survives source mapping.
      const cause = e.cause;
      if (cause instanceof Error && typeof cause.stack === "string") raw.stack = `${raw.stack ?? ""}\nCaused by: ${cause.stack}`;
      else if (cause !== undefined && cause !== null) raw.cause = copyValue(cause);
      if (raw.stack) raw.stack = truncate(raw.stack, MAX_STACK);
    } else if (typeof error === "string") {
      raw.message = truncate(error, MAX_STACK);
    } else {
      raw.message = "Non-Error thrown";
      raw.value = copyValue(error);
    }
  } catch {
    raw.message = "[unreadable error]";
  }
  return raw;
}

export function installErrors(rt: Runtime, _opts: Record<string, never> = {}): Signal<RawError[]> {
  const buffer = new RingBuffer<RawError>(50, 256 * 1024);
  const undo: (() => void)[] = [];
  const seen = new WeakSet<object>();
  let active = true;

  const capture = (error: unknown, mechanism: ErrorEntry["mechanism"], frames?: StackFrame[]) => {
    if (!active) return;
    try {
      if (error && typeof error === "object") {
        if (seen.has(error)) return;
        seen.add(error);
      }
      const entry = rawError(error, mechanism, rt.now());
      if (frames) entry.frames = frames;
      buffer.push(entry);
      // Redacted, then capped at 200 chars, at snapshot time.
      rt.breadcrumb({ at: iso(entry.at), category: "error", level: "error", message: truncate(`${entry.type}: ${entry.message}`, 1000), max: 200 });
      rt.error(entry);
    } catch (e) {
      active = false;
      rt.fault("errors", e); // the engine's fault() never throws
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
            capture(String(e.message || "Script error."), "uncaught", e.filename ? [{ file: e.filename, line: e.lineno, column: e.colno }] : undefined);
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
