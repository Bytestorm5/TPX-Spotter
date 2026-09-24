/**
 * `createSpotterHandler(options)` — the first-party ingest route for the App
 * Router, wrapping core's framework-agnostic `createIngestHandler`.
 *
 * The wire protocol has sub-paths (`/v1/reports/:id/artifacts/:name`, …), so
 * the route must be an optional catch-all:
 *
 * ```ts
 * // app/api/spotter/[[...spotter]]/route.ts
 * import { createSpotterHandler } from '@trusplex/spotter/ui/next'
 * import { spotterHooks } from '@/spotter.hooks'
 *
 * export const { GET, POST, PUT, HEAD, OPTIONS } = createSpotterHandler({ hooks: spotterHooks })
 * ```
 *
 * (A plain `app/api/spotter/route.ts`, as in the first spec draft, only
 * matches `/api/spotter` itself and would 404 every protocol call.)
 *
 * Secrets come from `SPOTTER_SECRET_KEY` and the project from
 * `NEXT_PUBLIC_SPOTTER_PROJECT`. With a secret key the route proxies to
 * Trusplex's hosted ingest (first-party, so ad blockers leave it alone) and
 * still runs your own hooks; without one it is fully self-hosted. Runtime
 * agnostic: only Fetch APIs, so `export const runtime = 'edge'` works too
 * (with memory storage, or a storage adapter that fits the runtime).
 */
import { createIngestHandler, type IngestHandler, type IngestHandlerOptions } from "../../core/server/index.ts";

export type SpotterHandlerOptions = IngestHandlerOptions;

type RouteHandler = (request: Request, context?: unknown) => Promise<Response>;

export interface SpotterRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  PUT: RouteHandler;
  HEAD: RouteHandler;
  OPTIONS: RouteHandler;
  PATCH: RouteHandler;
  DELETE: RouteHandler;
  /** The underlying ingest: `setStatus`, `ask`, `on('issue')`, deliveries, storage. */
  ingest: IngestHandler;
}

/**
 * Hooks keep running after the response on serverless platforms when Next's
 * `after()` is available (Next ≥ 15.1); otherwise they're awaited.
 */
async function nextAfter(): Promise<((p: Promise<unknown>) => void) | undefined> {
  try {
    const mod = (await import("next/server")) as { after?: (task: Promise<unknown>) => void };
    return mod.after;
  } catch {
    return undefined;
  }
}

export function createSpotterHandler(options: SpotterHandlerOptions = {}): SpotterRouteHandlers {
  let afterFn: ((p: Promise<unknown>) => void) | undefined;
  let afterResolved = false;
  const ingest = createIngestHandler({
    ...options,
    waitUntil:
      options.waitUntil ??
      ((p) => {
        // `after()` only works inside a request scope; fall back to letting the promise run.
        try {
          if (afterFn) afterFn(p);
        } catch {
          void p;
        }
      }),
  });
  const wrap =
    (method: keyof IngestHandler["handlers"]): RouteHandler =>
    async (request) => {
      if (!afterResolved && !options.waitUntil) {
        afterResolved = true;
        afterFn = await nextAfter();
      }
      return ingest.handlers[method](request);
    };
  return {
    GET: wrap("GET"),
    POST: wrap("POST"),
    PUT: wrap("PUT"),
    HEAD: wrap("HEAD"),
    OPTIONS: wrap("OPTIONS"),
    PATCH: wrap("PATCH"),
    DELETE: wrap("DELETE"),
    ingest,
  };
}
