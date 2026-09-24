/**
 * `defineHook()` and the server-only guard.
 *
 * Hooks carry secrets (GitHub tokens, Linear keys), so they never execute in
 * the browser: they run wherever ingest runs — Trusplex's hosted ingest or
 * the customer's own route handler. The guard makes a misplaced import fail
 * loudly instead of shipping a token to every visitor.
 */
import type { SpotterHook } from "../types.ts";

export function isBrowserRuntime(): boolean {
  const g = globalThis as { window?: { document?: unknown }; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}

export function assertServer(what: string): void {
  if (isBrowserRuntime())
    throw new Error(
      `Spotter: ${what} runs server-side only. Hooks need secrets, so they execute in the ingest ` +
        `(your /api/spotter route handler or Trusplex's hosted ingest), never in the browser.`,
    );
}

/** Declare a custom hook (Linear, Jira, Slack, …). Identity at runtime; validates the shape early. */
export function defineHook<H extends SpotterHook>(hook: H): H {
  if (!hook || typeof hook.name !== "string" || !hook.name) throw new Error("Spotter: defineHook() needs a unique `name`.");
  if (typeof hook.send !== "function") throw new Error(`Spotter: hook "${hook.name}" needs a \`send(issue)\` function.`);
  return hook;
}
