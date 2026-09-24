# Spotter wire protocol (v1)

The protocol between the SDK (`@trusplex/spotter/core`), an ingest — the
first-party route handler that `ui/next` installs (`/api/spotter`), your own
`createIngestHandler()`, or Trusplex Console's hosted ingest — and the hooks.
The TypeScript source of truth is `packages/spotter/src/core/schema.ts`; the
ticket itself is published as JSON Schema at
`@trusplex/spotter/schema/spotter.report.v1.json` (draft 2020-12).

## Base URL and credentials

| Base URL | Who uses it |
| --- | --- |
| `/api/spotter` | Browser default: the first-party route (no ad-blocker losses, no third-party requests) |
| `https://console.trusplex.com/hooks/spotter` | Server SDK default (`SPOTTER_ENDPOINT` overrides), build-time uploads, and what the route handler proxies to |

| Header | Meaning |
| --- | --- |
| `x-spotter-key: pk_live_…` / `pk_test_…` | Public project key, origin-bound. Sent by the browser. |
| `authorization: Bearer sk_live_…` | Secret key: the server SDK, the route handler, build uploads. Never in a browser. |
| `x-spotter-upload-token` | The reporter token from the receipt; required for artifact uploads. |
| `x-spotter-session` | The tab session id. The browser adds it to same-origin requests so server-side reports can link to the session. |
| `x-spotter-forwarded-for`, `-origin`, `-ua`, `-country` | Browser facts a route handler forwards. Trusted only alongside a valid secret key. |

Beacons can't set headers, so `POST /v1/events` also accepts `key` in the body
and is sent as `text/plain` (a CORS "simple request": no preflight).

## Endpoints

| Method and path | Body → response |
| --- | --- |
| `GET /v1/config` | → `RemoteConfig` (narrowing only; see below) |
| `POST /v1/reports` | `ReportSubmission` → `ReportReceipt` (201). Idempotent by `clientId`: a resubmission returns the first receipt (200). |
| `HEAD /v1/reports/:id/artifacts/:name` | → `upload-offset: <bytes stored>` (resume point) |
| `PUT /v1/reports/:id/artifacts/:name?offset=&total=` | Raw chunk → 204 with `upload-offset`. 409 plus `upload-offset` when `offset` isn't the stored size. |
| `POST /v1/reports/:id/complete` | `{ token }` → `{ ok: true }`. Builds the ticket and fires the issue event and hooks. |
| `GET /v1/reports/:id/status?token=` | → `ReportStatusView` |
| `POST /v1/reports/:id/replies` | `{ token, body }` → `ReportStatusView` |
| `POST /v1/reports/:id/plus-one` | `{ token?, reporter? }` → `{ count }` |
| `GET /v1/similar?url=&selector=` | → `SimilarIssue[]` (team and guest mode by default) |
| `POST /v1/flags` | `FlagBatch` → `{ accepted, promoted: ReportReceipt[] }` |
| `POST /v1/events` | `AnalyticsBatch` → 202 |
| `POST /v1/sessions/:sessionId/replay?seq=` | gzip rrweb segment (sampled or on-error replay) → 201 |
| `POST /v1/releases` | `ReleaseDeclaration` (secret key) → `{ release }` |
| `PUT /v1/releases/:release/sourcemaps?file=` | raw `.map` (secret key) → 201 |
| `GET /v1/portal?token=` | → `PortalView` (the reporter portal) |

Errors are `{ "error": string, "code": string }` with the HTTP status (`422`
also carries `details: string[]` for validation). `429` and `503` carry
`Retry-After`.

### Self-hosting extras (`createIngestHandler`)

| Method and path | |
| --- | --- |
| `GET /v1/artifacts/:id/:name?exp=&sig=` | Signed, short-lived artifact URL (HMAC-SHA256, default TTL 1 h). These are the `url`s in the ticket. |
| `GET /v1/admin/reports`, `GET /v1/admin/reports/:id` | List and read tickets (secret key) |
| `POST /v1/admin/reports/:id/status` | `{ status, message?, release? }`: notifies hooks' `onStatus` and the reporter |
| `GET /v1/admin/deliveries?state=failed` | Hook deliveries; failed ones are never dropped silently |
| `POST /v1/admin/deliveries/:id/retry` | Retry a failed delivery |
| `POST /v1/webhooks/github` | GitHub → Spotter status sync (when `githubWebhookSecret` is set) |

## A report, end to end

```
browser                                   ingest
  │  POST /v1/reports  (ReportSubmission, artifacts declared: name/kind/size)
  │ ────────────────────────────────────▶  validate (≤ 2 MB), dedupe clientId,
  │ ◀──────────────────────────────────── 201 ReportReceipt { id, ref, token, uploads[] }
  │  confirmation shown to the reporter ("Reference SPT-4821")
  │  PUT …/artifacts/screenshot.png?offset=0&total=N        (512 KB chunks)
  │ ────────────────────────────────────▶  204 upload-offset
  │  … network drop … HEAD …/artifacts/screenshot.png → upload-offset: 524288, resume
  │  POST …/complete { token }
  │ ────────────────────────────────────▶  build spotter.report.v1 (signed URLs),
  │                                         on('issue'), onReport, hooks
```

- Artifacts: screenshot, annotated screenshot, replay (gzip rrweb, ≤ 25 MB),
  recording (≤ 25 MB), attachments and the DOM snapshot (each ≤ 10 MB). Their
  `size` is declared up front, and `total` must match it.
- No artifacts declared: the ticket is built at submit time. A report whose
  tab closed before `complete` is finalized after 15 minutes with whatever
  arrived; missing artifacts are marked `failed`.
- In proxy mode (a secret key and an upstream) the handler submits to Console
  first, so Console's `id`, `ref` and `url` become the receipt. Each finished
  artifact is copied upstream, and `complete` is forwarded by the
  `dispatcher()` hook.

## The client never loses a report

- Retries use exponential backoff with jitter (4 attempts, capped). They
  retry network errors, 408, 429 and 5xx, and honour `Retry-After`. Other
  4xx errors aren't retried.
- If the submit still fails, the report (artifacts included) goes to the
  offline queue: IndexedDB, falling back to memory. `report()` resolves with
  a provisional receipt: `{ id: "pending_…", ref: "SPT-PENDING-1B6C",
  queued: true }`. The queue is replayed on `online` and on the next page's
  first interaction. Once delivered, `status(pendingId)` follows the real id.
- Uploads that fail after retries are queued with the pending `complete`, so
  the issue event still fires once they land.
- Flag batches that fail are queued too.

## Remote config narrows only

`GET /v1/config` can disable features, lower sample rates, shorten the replay
window and restrict targeting. It can't enable a feature that the build or
the code config left out; those requests are ignored, with a dev-mode
warning. Code config wins for fields, appearance and trigger. The fetch
happens on idle after the first user interaction (or on `spotter.open()`),
so there are zero Spotter requests before the user engages.

## Correlation

- `trace.traceparents`: W3C `traceparent` values seen on recent requests
  (HAR `_traceparent`).
- `trace.sessionId`: the browser tab's session id. Server-side reports read
  it from the incoming `x-spotter-session` header (`spotter.withRequest(req)`
  or `report({ request })`), so one ticket shows both sides.
