/**
 * The CDN build's entry (`dist/cdn/spotter.min.js` → `window.Spotter`,
 * `dist/cdn/esm/spotter.js` with lazy chunks). Browser API only — hooks and
 * the ingest handler are server-side and stay in the npm package.
 *
 *   <script src=".../spotter.min.js" integrity="sha384-…" crossorigin="anonymous"
 *           data-project="pk_live_…" data-endpoint="/api/spotter"></script>
 *
 * With `data-project` the script initialises itself; otherwise call
 * `Spotter.spotter.init({ … })`.
 */
import { spotter } from "../src/core/singleton.ts";

export { spotter };
export { createSpotter } from "../src/core/client.ts";
export { connectConsentManager } from "../src/core/consent.ts";
export { createTestTransport } from "../src/core/testing.ts";
export { SDK_VERSION } from "../src/core/ids.ts";

const script = typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement | null) : null;
const project = script?.dataset.project;
if (project) {
  spotter.init({
    project,
    ...(script?.dataset.endpoint ? { endpoint: script.dataset.endpoint } : {}),
    ...(script?.dataset.environment ? { environment: script.dataset.environment } : {}),
  });
}
