import { createSpotterHandler } from "@trusplex/spotter/ui/next";
import { spotterHooks } from "@/spotter.hooks";

/**
 * One handler per server process (route modules may be bundled separately,
 * so it lives on globalThis): the test routes use its ingest to change
 * statuses and ask the reporter questions.
 */
const g = globalThis as typeof globalThis & { __spotterHandler?: ReturnType<typeof createSpotterHandler> };

export const spotterHandler = (g.__spotterHandler ??= createSpotterHandler({
  hooks: spotterHooks,
  // Self-hosted: no Trusplex upstream in tests.
  upstream: false,
  rateLimit: false,
}));
