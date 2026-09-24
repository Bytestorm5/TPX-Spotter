# @trusplex/spotter

Spotter is embeddable issue capture for Trusplex. Anyone on your site can
show what went wrong in two clicks, and you get a ticket complete enough to
fix without a follow-up question: screenshot, replay, console, network,
environment and app state. It also covers privacy-first web analytics, so
you don't need a separate tag.

Two entry points, features switched by build-time flags:

| Entry | |
| --- | --- |
| `@trusplex/spotter/core` | Framework-agnostic: capture, redaction, replay, screenshot, analytics, the reporting API, the issue event and hooks, transport, the ingest handler. Runs in the browser, Node and edge runtimes. |
| `@trusplex/spotter/ui/next` | Next.js: `withSpotter()`, `<SpotterProvider>`, `<Spotter />`, primitives, `useSpotter()`, and the `/api/spotter` route handler |

## Install

```sh
npx trusplex spotter init     # installs, wraps next.config, adds the provider, creates the route, writes .env.local
npx trusplex spotter doctor   # checks keys, config, CSP, route, source maps, bundle impact
```

Or by hand, in three pieces:

```ts
// next.config.ts
import { withSpotter } from "@trusplex/spotter/ui/next";
export default withSpotter(nextConfig, {
  features: { widget: true, screenshot: true, annotate: true, replay: true, analytics: true, flags: true, recording: false },
});
```

```tsx
// app/layout.tsx
import { SpotterProvider, Spotter } from "@trusplex/spotter/ui/next";

<body>
  <SpotterProvider environment="production" replay={{ mode: "buffer", windowSeconds: 60 }}>
    {children}
    <Spotter />
  </SpotterProvider>
</body>
```

```ts
// app/api/spotter/[[...spotter]]/route.ts   (optional catch-all: the protocol has sub-paths)
import { createSpotterHandler } from "@trusplex/spotter/ui/next";
export const { GET, POST, PUT, HEAD, OPTIONS } = createSpotterHandler();
```

```sh
# .env.local
NEXT_PUBLIC_SPOTTER_PROJECT=pk_live_…
SPOTTER_SECRET_KEY=sk_live_…      # server only: forwarding to Trusplex, source-map upload
```

Disabled features are compiled out: a build with `replay: false` contains no
replay code, and CI proves it. Enabled heavy features load lazily.

## Reporting from code

```ts
import { spotter } from "@trusplex/spotter/core";

spotter.identify({ id: user.id, email: user.email, plan: "pro" });
spotter.setContext("cart", { items: 2, total: 42 });
spotter.setTags({ area: "checkout" });
spotter.addBreadcrumb({ category: "custom", message: "Applied coupon SAVE10" });
spotter.attach("state.json", store.getState());

spotter.flag("checkout.total_mismatch", { severity: "warning", data: { expected, actual }, captureReplay: true });
spotter.assert(total === expected, "checkout.total_mismatch", { expected, actual });

const { ref } = await spotter.report({ title: "Payment provider returned 502", severity: "error", include: { screenshot: false } });
await spotter.captureException(error, { orderId });
spotter.open({ prefill: { title: "Something broke. Tell us what you were doing?" } });
spotter.on("sent", (receipt) => toast(`Reference ${receipt.ref}`));
```

The reporter always gets a confirmation. If the send fails, the report is
queued in IndexedDB and `report()` resolves with a provisional
`SPT-PENDING-xxxx` receipt (`queued: true`). The queue delivers it later.

### On the server

The same API works in route handlers, server actions and middleware. It uses
`SPOTTER_SECRET_KEY` and sends to `SPOTTER_ENDPOINT`, or to the hosted
ingest when that's unset. Server reports have `source: "server"`. Pass the
request so the ticket links to the browser session (`x-spotter-session`) and
trace (`traceparent`):

```ts
await spotter.captureException(error, { request });
const s = spotter.withRequest(request);
s.flag("payments.retry");
await s.report({ title: "Charge failed" });
await spotter.flush(); // send batched flags before a serverless function returns
```

### Typed from config

`withSpotter()` generates `spotter-env.d.ts`. You can also write the
augmentation yourself:

```ts
declare module "@trusplex/spotter/core" {
  interface SpotterFeatureFlags { analytics: false }       // spotter.track() is now a type error
  interface SpotterRegister {
    events: "signup_completed" | "checkout_started";       // typed track() names
    fields: { order_number: string; plan: "free" | "pro" }; // typed custom fields
    contexts: { cart: { items: number; total: number } };   // typed setContext()
  }
}
```

Calling an API for a disabled feature is a no-op in production and a warning
in development.

## Testing

```ts
import { createTestTransport, createSpotter } from "@trusplex/spotter/core";

const transport = createTestTransport();
const spotter = createSpotter().init({ project: "pk_test_x", transport });
await spotter.report({ title: "Broken" });
expect(transport.reports[0].content.title).toBe("Broken");
spotter.flag("x"); await spotter.flush();
expect(transport.flagOccurrences[0].name).toBe("x");
await transport.waitForReport((r) => r.source === "widget");
transport.failNext("submit"); // exercise the offline queue
```

`flags` and `events` are Transport methods, so the recorded occurrences are
in `flagOccurrences` / `analyticsEvents`, or `recorded.flags` /
`recorded.events`. In Playwright, read them through
`window.__trusplexSpotter.config.transport`.

## Hooks and self-hosting

Every ticket is broadcast as one `issue` event (`spotter.report.v1`). Hooks
deliver it server-side: `dispatcher()` (Trusplex, on by default with a
project key and secret key), `github()` (issues, dedupe by fingerprint,
two-way status sync) and `defineHook()` for anything else. See
[docs/hooks.md](../../docs/hooks.md).

`createIngestHandler()` implements the whole wire protocol, so you can run
Spotter without Trusplex. See [docs/self-hosting.md](../../docs/self-hosting.md)
and [docs/protocol.md](../../docs/protocol.md).

## CDN

`dist/cdn/spotter.min.js` exposes `window.Spotter`. `dist/cdn/esm/` has lazy
chunks, and `dist/cdn/sri.json` has the `sha384-…` Subresource Integrity
hashes.

```html
<script src="…/spotter.min.js" integrity="sha384-…" crossorigin="anonymous" data-project="pk_live_…"></script>
```

## Privacy

Masking is on by default. Redaction runs in the browser before upload.
Buffer-mode replay sends nothing unless a report is filed. Analytics is
cookieless. Consent, GPC and CMP integration, and the CSP entries Spotter
needs, are in [docs/privacy.md](../../docs/privacy.md).

## Schema

`@trusplex/spotter/schema/spotter.report.v1.json` is the JSON Schema (draft
2020-12) for the ticket. Within v1 changes are additive only.
