/**
 * The seam between the client (`client.ts`, which owns config, state,
 * transport and the reporting API) and the capture subsystems (signals,
 * replay, screenshot, recording, analytics), which the client installs.
 *
 * Every capture module exports an `install*(rt, options)` that returns a
 * `Signal`: it patches what it needs, keeps a bounded buffer, snapshots on
 * demand and undoes every patch on `destroy()`. A module never throws into
 * the host: a fault inside it disables that signal (`rt.fault(name, error)`).
 *
 * Signals loaded at init hold raw records; redaction, serialization and
 * formatting happen at snapshot time in the session chunk
 * (`capture/finalize.ts`, `network-har.ts`, `stack.ts`), before anything is
 * sent. `rt.redact` / `rt.redactUrl` work once the redaction module has
 * loaded (with the session chunk, or with replay).
 */
import type { Breadcrumb, ErrorEntry, Json, NavigationEntry, ReleaseInfo } from "./schema.ts";
import type { RedactionSite, SpotterConfig } from "./types.ts";

export interface Runtime {
  readonly config: Readonly<SpotterConfig>;
  readonly sessionId: string;
  /** ms since epoch; injectable for tests. */
  now(): number;
  /** Run the built-in scrubbers and the custom redactor over a string. */
  redact(value: string, where: RedactionSite): string;
  /** Strip sensitive query parameters and redact a URL. */
  redactUrl(url: string): string;
  /** Record a breadcrumb in the shared timeline buffer (held raw, finished at snapshot). */
  breadcrumb(crumb: RawCrumb): void;
  /** Tell the client an error was captured (drives on-error replay upload, auto-flags). Unredacted. */
  error(entry: Pick<ErrorEntry, "type" | "message">): void;
  /** Tell the client the route changed (analytics pageview, navigation history). */
  navigated(entry: NavigationEntry): void;
  /** A capture module faulted; the client disables it and warns in dev. */
  fault(signal: string, error: unknown): void;
  /** Dev-mode warning (compiled out of production builds). */
  warn(message: string): void;
  /** Current identity, flags and release, for analytics and flags. */
  identity(): { id?: string; email?: string } | null;
  flags(): Record<string, Json>;
  release(): ReleaseInfo;
  /** Consent as last set (`setConsent`). Undefined = not asked. */
  consent(): { replay?: boolean; analytics?: boolean };
  /** Route pattern for the current URL, when a framework integration knows it. */
  routePattern(url?: string): string | undefined;
}

/** Stands in for a label in a raw crumb's message; replaced by the redacted, 60-char `label` at snapshot. */
export const LABEL = "\u0001";

/**
 * A breadcrumb as held in the buffer. At snapshot (`finalizeCrumbs`) its
 * message has sensitive query parameters stripped and is redacted; `value`
 * (a console argument copy) is serialized into the message when there is
 * none; `label` is redacted, capped at 60 chars and substituted for `LABEL`;
 * the message is capped at `max` chars; `data.url` / `to` / `from` go through
 * URL redaction and other data through JSON redaction.
 */
export type RawCrumb = Breadcrumb & { label?: string; value?: unknown; max?: number };

export interface Signal<TSnapshot = unknown> {
  readonly name: string;
  snapshot(): TSnapshot;
  destroy(): void;
}

/** Replay, as the client drives it. Lives in a lazy chunk. */
export interface ReplayController {
  readonly mode: "buffer" | "on_error" | "sampled";
  /** gzip-compressed rrweb events covering the rolling window (buffer modes) — `null` if nothing recorded. */
  flush(): Promise<{ data: Uint8Array; startedAt: string; endedAt: string; events: number } | null>;
  /** On-error / flag: upload the buffer as a session segment and keep recording. Returns the segment number. */
  uploadSegment(reason: string): Promise<number | null>;
  /** The recent rrweb events (uncompressed) for the timeline and derived signals. */
  recentEvents(): unknown[];
  stop(): void;
}

export interface ScreenshotResult {
  blob: Blob;
  width: number;
  height: number;
  /** `dom` rendering, or `native` getDisplayMedia fallback. */
  method: "dom" | "native";
}

export interface ScreenshotOptions {
  scope: "viewport" | "full" | "element";
  element?: Element;
  /** Elements to leave out (the Spotter UI host). */
  exclude?: Element[];
  maskText: "none" | "inputs" | "all";
  maskSelectors: string[];
  blockSelectors: string[];
}
