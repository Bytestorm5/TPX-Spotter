/**
 * The seam between `ui/next` and the core client (with `bridge-flow.ts`,
 * its panel-only half).
 *
 * The UI drives the widget flow through the client's `SpotterWidgetApi`
 * (`captureForReport`, `submitFromWidget`, `setState`, …). Everything here is
 * feature-detected with a fallback, so a UI build against an older or
 * narrower client degrades instead of crashing, and any integration change
 * is a one-file edit.
 *
 * Core is reached only through a dynamic `import()`: the loader (Provider +
 * trigger) never carries the client; it loads on idle or first interaction.
 */
import type {
  OpenOptions,
  ReporterMode,
  SpotterClient,
  SpotterConfig,
  SpotterState,
  SpotterWidgetApi,
  WidgetCapture,
} from "../../../core/types.ts";

export type Client = SpotterClient & Partial<SpotterWidgetApi>;

type CoreModule = { spotter: Client };

let clientPromise: Promise<Client> | null = null;
let client: Client | null = null;

/** Load core (once). Safe to call from event handlers and effects; never at import time. */
export function loadClient(): Promise<Client> {
  if (!clientPromise) {
    // `singleton.ts`, not the core index: the index also carries hooks, the ingest handler and transports.
    clientPromise = (import("../../../core/singleton.ts") as Promise<unknown>).then((m) => {
      client = (m as CoreModule).spotter;
      trackIdentity(client);
      return client;
    });
    clientPromise.catch(() => {
      clientPromise = null; // A failed chunk load (offline) may be retried on the next interaction.
    });
  }
  return clientPromise;
}

export function peekClient(): Client | null {
  return client;
}

/** Init once; a second Provider (strict mode, HMR) reuses the initialised singleton. */
export async function initClient(config: SpotterConfig): Promise<Client> {
  const c = await loadClient();
  if (!c.initialized) c.init(config);
  return c;
}

export async function preload(feature: "widget" | "screenshot" | "annotate" | "recording"): Promise<void> {
  const c = await loadClient();
  try {
    await c.preload?.(feature);
  } catch {
    /* preload is an optimisation */
  }
}

export function setState(state: SpotterState): void {
  try {
    client?.setState?.(state);
  } catch {
    /* mirror only */
  }
}

// -- capture ------------------------------------------------------------------------------

export interface CaptureRequest {
  screenshot: boolean;
  element?: Element | null;
  exclude: Element[];
}

export async function capture(req: CaptureRequest): Promise<WidgetCapture> {
  const c = await loadClient();
  if (c.captureForReport) {
    return await c.captureForReport({
      screenshot: req.screenshot ? "viewport" : false,
      element: req.element ?? undefined,
      exclude: req.exclude,
    });
  }
  // Older client: no pre-capture; signals are snapshotted at submit time.
  return { id: "", capturedAt: new Date().toISOString(), page: {}, attachments: [], test: c.config.environment === "development" };
}

export function discardCapture(id: string | undefined): void {
  if (id) client?.discardCapture?.(id);
}

// -- reporter ------------------------------------------------------------------------------

export function reporterMode(): ReporterMode {
  try {
    return client?.reporterMode?.() ?? { type: "public" };
  } catch {
    return { type: "public" };
  }
}

type Identity = { id?: string; email?: string; name?: string };
let seenIdentity: Identity | null = null;

/**
 * Stopgap until the client exposes `identity()`: observe `identify()` calls
 * on the singleton so the Contact step can be skipped. Only sees calls made
 * after core loaded; a client with `identity()` makes this a no-op.
 */
function trackIdentity(c: Client): void {
  const withGetter = c as Client & { identity?: () => Identity | null; __spotterUiIdentity?: true };
  if (typeof withGetter.identity === "function" || withGetter.__spotterUiIdentity) return;
  const original = c.identify.bind(c);
  withGetter.__spotterUiIdentity = true;
  c.identify = (user) => {
    seenIdentity = user ? { id: user.id, email: user.email, name: user.name } : null;
    original(user);
  };
}

/** Whether `identify()` was called (the Contact step is skipped then). */
export function identity(): Identity | null {
  const c = client as (Client & { identity?: () => Identity | null }) | null;
  try {
    if (typeof c?.identity === "function") return c.identity();
  } catch {
    /* fall through */
  }
  return seenIdentity;
}

export function remoteConfig() {
  try {
    return client?.remoteConfig?.() ?? null;
  } catch {
    return null;
  }
}

export function setRouteResolver(fn: ((url: string) => string | undefined) | null): void {
  client?.setRouteResolver?.(fn);
}

/** Subscribe to programmatic `spotter.open()` / `close()`. */
export function onOpenClose(c: Client, open: (o: OpenOptions) => void, close: () => void): () => void {
  const offOpen = c.on("open", (o) => open(o ?? {}));
  const offClose = c.on("close", () => close());
  return () => {
    offOpen();
    offClose();
  };
}
