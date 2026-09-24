/**
 * The `spotter` singleton on its own, so code that only needs the client
 * (the `ui/next` bridge, the size check) can import it without the rest of
 * the core index (hooks, the ingest handler, transports). Bundlers that
 * split per file — esbuild — would otherwise co-locate those modules with
 * the client; `@trusplex/spotter/core` re-exports this same instance.
 */
import { createSpotter } from "./client.ts";
import type { TypedSpotter } from "./typed.ts";

export const spotter: TypedSpotter = /* @__PURE__ */ createSpotter() as unknown as TypedSpotter;
