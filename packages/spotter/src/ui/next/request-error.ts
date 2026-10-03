/**
 * `createOnRequestError(options)` — automatic reports for server errors, via
 * Next.js's `onRequestError` instrumentation hook (Next ≥ 15). It sees
 * every error thrown while rendering a server component, in a route
 * handler, a server action or middleware:
 *
 * ```ts
 * // instrumentation.ts
 * import { createOnRequestError } from "@trusplex/spotter/ui/next";
 *
 * export const onRequestError = createOnRequestError({
 *   ignore: ["ECONNRESET"],
 *   server: { status: "5xx", ignoreUrls: ["/api/health"] },
 * });
 * ```
 *
 * The rules are `autoReport`'s (`server` plus `ignore`, `filter`, `limits`,
 * `tags`, `severity`). Each report carries the route (`routePath`,
 * `routeType`, router kind, render source, revalidate reason), the request
 * method and path, the error digest the browser sees, and — through the
 * request's `x-spotter-session` / `traceparent` headers — a link to the
 * browser session that made the request, whose own report Spotter files when
 * the page then fails.
 *
 * Limits are per server process: `perIssue` (default 1) per distinct error
 * and `perSession` (default 10) in total, per hour.
 */
import { decide, eventKey, normalizeAutoReport } from "../../core/auto-report/rules.ts";
import type { AutoReportConfig, AutoReportEvent, ExceptionContext, SpotterClient } from "../../core/types.ts";

export interface OnRequestErrorOptions extends Pick<AutoReportConfig, "server" | "ignore" | "filter" | "limits" | "tags"> {
  /** Report through this client instead of the `spotter` singleton (configured from `SPOTTER_*` env). */
  client?: Pick<SpotterClient, "captureException">;
}

/** What Next passes `onRequestError` (kept structural so any Next ≥ 15 matches). */
export interface NextRequestErrorInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface NextRequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
}

const HOUR = 3_600_000;

/** Next's control-flow "errors" (redirect(), notFound(), forbidden()) and the status they stand for. */
function digestStatus(digest: string | undefined): number | "skip" | undefined {
  if (!digest) return undefined;
  if (digest.startsWith("NEXT_REDIRECT") || digest === "BAILOUT_TO_CLIENT_SIDE_RENDERING" || digest === "DYNAMIC_SERVER_USAGE") return "skip";
  const m = /^NEXT_HTTP_ERROR_FALLBACK;(\d{3})$/.exec(digest) ?? /^NEXT_NOT_FOUND$/.exec(digest);
  if (m) return m[1] ? Number(m[1]) : 404;
  return undefined;
}

export function createOnRequestError(options: OnRequestErrorOptions = {}) {
  const rules = normalizeAutoReport({ ...options, errors: false, network: false, page: false, console: false, resources: false, csp: false })!;
  const counts = new Map<string, number>();
  let total = 0;
  let windowStart = Date.now();

  return async function onRequestError(error: unknown, request: NextRequestErrorInfo, context: NextRequestErrorContext = {}): Promise<void> {
    try {
      const now = Date.now();
      if (now - windowStart > HOUR) {
        windowStart = now;
        total = 0;
        counts.clear();
      }
      const err = (error && typeof error === "object" ? error : { message: String(error) }) as Error & { digest?: string };
      const fromDigest = digestStatus(err.digest);
      if (fromDigest === "skip") return;
      const status = fromDigest ?? 500;
      const event: AutoReportEvent = {
        kind: "server",
        at: new Date(now).toISOString(),
        type: err.name || "Error",
        message: String(err.message ?? ""),
        status,
        url: request?.path,
        method: request?.method,
        error,
        ...(typeof err.stack === "string" ? { stack: err.stack } : {}),
      };
      if (!decide(rules, event).report) return;
      const key = eventKey(event);
      if (total >= rules.perSession || (counts.get(key) ?? 0) >= rules.perIssue) return;
      total++;
      counts.set(key, (counts.get(key) ?? 0) + 1);

      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(context ?? {})) if (typeof v === "string" && v) next[k] = v;
      const extras: ExceptionContext = {
        request: { headers: request?.headers ?? {}, url: request?.path, method: request?.method },
        tags: {
          ...rules.tags,
          "spotter.auto": "true",
          "spotter.trigger": "server",
          "http.status": String(status),
          ...(next.routeType ? { "next.routeType": next.routeType } : {}),
          ...(next.routePath ? { "next.routePath": next.routePath } : {}),
        },
        next,
        request_info: { method: request?.method ?? "", path: request?.path ?? "", status },
        ...(err.digest ? { digest: err.digest } : {}),
      };
      const client = options.client ?? (await import("../../core/singleton.ts")).spotter;
      await client.captureException(error, extras);
    } catch {
      /* reporting must never take the request down with it */
    }
  };
}
