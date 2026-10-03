/**
 * Server errors (server components, route handlers, server actions,
 * middleware) become automatic Spotter reports.
 */
import { createOnRequestError } from "@trusplex/spotter/ui/next";

export async function register() {
  // Self-hosted fixture: send server reports to this app's own ingest route rather than Trusplex.
  const { spotter } = await import("@trusplex/spotter/core");
  spotter.init({ endpoint: `http://localhost:${process.env.PORT ?? 3100}/api/spotter`, project: "pk_test_fixture", environment: "development" });
}

export const onRequestError = createOnRequestError({ tags: { fixture: "next-app" } });
