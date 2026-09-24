/**
 * Report fingerprints: the grouping key Dispatcher, Console and the GitHub
 * hook dedupe on.
 *
 * - errors: error type + top in-app frame (function and file, not line — line
 *   numbers move with every release, the function rarely does)
 * - everything else: route pattern + selected element + category
 * - flags: the caller's fingerprint parts
 *
 * The hash is synchronous (cyrb53, no `crypto.subtle`) so it works inside the
 * report pipeline, in every runtime, without awaiting.
 */
import type { ErrorEntry, ReportSource, StackFrame } from "./schema.ts";

/** cyrb53: a fast 53-bit string hash with good distribution. Returns 14 hex chars. */
export function hash(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

/** Strip query strings, build hashes and origins so the same code groups across deploys and hosts. */
export function normalizeFile(file: string): string {
  let f = file.split(/[?#]/)[0] ?? file;
  f = f.replace(/^[a-z]+:\/\/[^/]+/i, "");
  // chunk-4f9a2c1e.js, page-a1b2c3d4e5.js, main.1a2b3c4d.js
  f = f.replace(/[.-][0-9a-f]{6,}(?=\.[a-z]+$)/i, "");
  return f;
}

/** Turn `/orders/1234/items/9f1c…` into `/orders/:id/items/:id` when no route pattern is known. */
export function normalizePath(path: string): string {
  return (
    path
      .split(/[?#]/)[0]!
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id")
      .replace(/\/\d+(?=\/|$)/g, "/:id")
      .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/:id") || "/"
  );
}

function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "0")
    .slice(0, 200);
}

function topFrame(frames: StackFrame[]): StackFrame | undefined {
  const inApp = frames.find((f) => f.file && !/node_modules|^native|<anonymous>/.test(f.file));
  return inApp ?? frames[0];
}

export function errorFingerprint(error: Pick<ErrorEntry, "type" | "message" | "frames">): string {
  const frame = topFrame(error.frames);
  const where = frame
    ? `${frame.original?.function ?? frame.function ?? "?"}@${normalizeFile(frame.original?.file ?? frame.file ?? "?")}`
    : normalizeMessage(error.message);
  return hash(`error|${error.type}|${where}`);
}

export function pageFingerprint(input: { url?: string; routePattern?: string; selector?: string; category?: string }): string {
  let path = input.routePattern;
  if (!path && input.url) {
    try {
      path = normalizePath(new URL(input.url, "http://x").pathname);
    } catch {
      path = normalizePath(input.url);
    }
  }
  return hash(`page|${path ?? "/"}|${input.selector ?? ""}|${input.category ?? ""}`);
}

export function flagFingerprint(parts: string[]): string {
  return hash(`flag|${parts.join("\u0000")}`);
}

/** The derived fingerprint for a report. Errors win for error-sourced reports. */
export function deriveFingerprint(input: {
  source: ReportSource;
  error?: Pick<ErrorEntry, "type" | "message" | "frames">;
  page: { url?: string; routePattern?: string; selector?: string };
  category?: string;
  flag?: string[];
}): string {
  if (input.flag) return flagFingerprint(input.flag);
  if (input.error && (input.source === "error" || input.source === "server")) return errorFingerprint(input.error);
  return pageFingerprint({ ...input.page, category: input.category });
}
