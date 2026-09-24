# Self-hosting the ingest

The transport target is swappable. Spotter runs fully against your own
endpoint and storage, with no Trusplex account: that's part of the
anti-lock-in commitment. The same handler also proxies to Trusplex's hosted
ingest when you use it.

## Modes

| | Proxy | Self-hosted |
| --- | --- | --- |
| Condition | `SPOTTER_SECRET_KEY` set, and an upstream (default: Console's hosted ingest when a project key is set) | No secret key, or `upstream: false` |
| Reports | Received locally (your hooks see them), submitted to Console first so Console's id and ref are canonical, artifacts copied upstream | Stored in `storage`; your hooks are the only delivery |
| Config, events, flags, similar, plus-one, replay segments, releases, portal | Forwarded with `authorization: Bearer sk_…` plus `x-spotter-forwarded-*` | Served locally |
| Status | Console's | Yours (`setStatus`, `/v1/admin/…`, GitHub webhook) |

## Next.js

```ts
// app/api/spotter/[[...spotter]]/route.ts
import { createSpotterHandler } from "@trusplex/spotter/ui/next";
import { fileSystemStorage, github } from "@trusplex/spotter/core";

export const { GET, POST, PUT, HEAD, OPTIONS } = createSpotterHandler({
  upstream: false,                                  // fully self-hosted
  storage: fileSystemStorage("/var/lib/spotter"),   // default: memory (lost on restart)
  hooks: [github({ repo: "acme/web", token: process.env.GITHUB_TOKEN })],
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  allowedOrigins: ["https://*.acme.com"],           // same-origin is always allowed
});
```

## Any Fetch-API server

`createIngestHandler` is framework-agnostic: `(request: Request) =>
Promise<Response>`. It also has `.handlers` with `{ GET, POST, PUT, HEAD,
OPTIONS, PATCH, DELETE }`. It runs on Node ≥ 22, edge runtimes, Bun and
Deno, and uses only Fetch and Web Crypto.

```ts
import { createIngestHandler, memoryStorage } from "@trusplex/spotter/core";

const spotter = createIngestHandler({ upstream: false, storage: memoryStorage() });

// Hono
app.all("/api/spotter/*", (c) => spotter(c.req.raw));
// Bun
Bun.serve({ fetch: (req) => (new URL(req.url).pathname.startsWith("/api/spotter") ? spotter(req) : new Response("", { status: 404 })) });
```

The handler finds the protocol path from the first `/v1/` segment, so any
mount point works. Point the browser SDK at it with `endpoint` if it isn't
`/api/spotter`.

## Options

| Option | Default | |
| --- | --- | --- |
| `hooks` | `[]` | Run on every finished ticket. `dispatcher()` is prepended in proxy mode (`dispatcher: false` to opt out). |
| `secretKey` | `SPOTTER_SECRET_KEY` | Also the HMAC key for artifact URLs and the admin credential |
| `project` | `SPOTTER_PROJECT` / `NEXT_PUBLIC_SPOTTER_PROJECT` | Requests carrying a different `x-spotter-key` are rejected |
| `upstream` | `SPOTTER_ENDPOINT`, or Console's hosted ingest when `project` is set | `false` for fully self-hosted |
| `storage` | `memoryStorage()` | `fileSystemStorage(dir)`, or your own `ArtifactStorage` (S3, R2, GCS): `append`, `put`, `read`, `size`, `delete`, `list` |
| `deliveries` | in memory | A `DeliveryStore` to persist hook deliveries and links |
| `allowedOrigins` | none (same-origin only) | CORS for other origins; `https://*.acme.com` wildcards work |
| `publicBaseUrl` | from the request | Base for signed artifact URLs, e.g. `https://acme.com/api/spotter` |
| `artifactUrlTtl` | `3600` s | Lifetime of signed URLs |
| `rateLimit` | reports 20/min, others 600/min per IP | `false` disables it. It's in-memory and per process, so add your platform's limiter across instances. |
| `turnstileSecret` | `TURNSTILE_SECRET_KEY` | Anonymous (public, unauthenticated) submissions must pass Turnstile. With `NEXT_PUBLIC_TURNSTILE_SITE_KEY` it's also advertised in `/v1/config`. |
| `githubWebhookSecret` | `GITHUB_WEBHOOK_SECRET` | Serves `POST /v1/webhooks/github` |
| `remoteConfig` | `{ version: 0 }` | What `GET /v1/config` returns (it can only narrow the client) |
| `promoteFlag(group)` | any `critical` flag | Turns a flag group into a ticket (`source: "flag"`) |
| `onEvents(batch, facts)` | discard | Where analytics events go when self-hosted |
| `onReport(issue)` | | Called for every finished ticket |
| `waitUntil(promise)` | await | Keep hooks running after the response (Next's `after()`, `ctx.waitUntil`) |

Limits: report JSON ≤ 2 MB; each artifact ≤ 10 MB (replay and recording
≤ 25 MB); replay segments ≤ 25 MB; source maps ≤ 50 MB. Every submission is
validated field by field, and bad input gets `422` with `details`.

## Operating it

```ts
const handler = createIngestHandler({ … });
handler.on("issue", (issue) => …);                       // every finished ticket
await handler.setStatus(id, "resolved", { message: "Fixed in v2.14", release: "2.14.1" });
await handler.ask(id, "Which browser?");                 // needs_info, threaded to the reporter
await handler.deliveries({ state: "failed" });
await handler.retryDelivery(deliveryId);
```

Over HTTP with `authorization: Bearer $SPOTTER_SECRET_KEY`:

```sh
curl -H "authorization: Bearer $SPOTTER_SECRET_KEY" https://acme.com/api/spotter/v1/admin/reports
curl -X POST -H "authorization: Bearer $SPOTTER_SECRET_KEY" -d '{"status":"resolved","message":"Fixed"}' \
  https://acme.com/api/spotter/v1/admin/reports/rep_123/status
```

## Server-side SDK against your ingest

```ts
// SPOTTER_ENDPOINT=https://acme.com/api/spotter  SPOTTER_SECRET_KEY=sk_…
import { spotter } from "@trusplex/spotter/core";

export async function POST(request: Request) {
  try { … } catch (error) {
    await spotter.captureException(error, { request }); // links to the browser session via x-spotter-session
    throw error;
  }
}
```

## Leaving with your data

Tickets are `spotter.report.v1` JSON (published JSON Schema), replays are
gzip-compressed rrweb event arrays, and network logs are HAR 1.2. With
`fileSystemStorage` they're plain files: `reports/<id>.json` and
`artifacts/<id>/<name>`.
