/**
 * Dev-mode guardrails. Every function here is a no-op when `DEV` is false,
 * and since `DEV` is a compile-time constant under `withSpotter()` the
 * minifier removes the bodies (and their strings) from production builds.
 *
 * A mistake should announce itself in the console during development rather
 * than surface as a thin ticket weeks later.
 */
import { DEV } from "./features.ts";

const seen = new Set<string>();

/** Warn once per distinct message. Uses the console captured before any patch, when given. */
export function devWarn(message: string): void {
  if (!DEV) return;
  if (seen.has(message)) return;
  seen.add(message);
  try {
    // eslint-disable-next-line no-console
    (originalWarn ?? console.warn).call(console, `[spotter] ${message}`);
  } catch {
    /* never throw into the host */
  }
}

let originalWarn: ((...args: unknown[]) => void) | undefined;

/** The console capture calls this before patching so our own warnings bypass the buffer. */
export function preserveConsoleWarn(fn: (...args: unknown[]) => void): void {
  originalWarn = fn;
}

/** For tests. */
export function resetDevWarnings(): void {
  seen.clear();
}

const PK = /^pk_(live|test)_[A-Za-z0-9]{8,}$/;
const SK = /^sk_(live|test)_[A-Za-z0-9]{8,}$/;

/** Format checks for keys; returns a human-readable problem or null. Pure (also used by the CLI doctor). */
export function keyProblem(key: string | undefined, kind: "public" | "secret"): string | null {
  if (!key) return kind === "public" ? "No project key: set `project` (NEXT_PUBLIC_SPOTTER_PROJECT)." : null;
  if (kind === "public" && key.startsWith("sk_"))
    return "A secret key (sk_…) was passed as `project`. Secret keys must never reach the browser — use the pk_… key.";
  if (kind === "public" && !PK.test(key)) return `Project key "${key.slice(0, 12)}…" doesn't look like pk_live_… or pk_test_….`;
  if (kind === "secret" && !SK.test(key)) return `Secret key doesn't look like sk_live_… or sk_test_….`;
  return null;
}

/** Browser-side configuration checks run once at init in development. */
export function devCheckConfig(config: {
  project?: string;
  secretKey?: string;
  replay?: { mode?: string };
  privacy?: { maskText?: string };
  environment?: string;
}, runtime: "browser" | "node" | "edge"): void {
  if (!DEV) return;
  if (runtime === "browser") {
    if (config.secretKey) devWarn("`secretKey` was passed in the browser. Remove it: secret keys belong on the server only.");
    const problem = keyProblem(config.project, "public");
    if (problem && config.project) devWarn(problem);
    if (config.replay?.mode && config.replay.mode !== "off" && config.privacy?.maskText === "none")
      devWarn("Replay is enabled with `privacy.maskText: 'none'`: every text node is recorded unmasked. Is that intended?");
  }
}
