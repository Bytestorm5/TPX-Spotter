# Privacy, consent and CSP

Spotter records other people's users, so the safe configuration is the
default one and loosening it takes an explicit act. This page covers what's
captured, what never leaves the page, how consent works, and what to put in
your Content Security Policy.

## What leaves the page, and when

| | Default | Sent |
| --- | --- | --- |
| Console, errors, network (shape only), navigation, breadcrumbs, performance | Captured into bounded in-memory buffers | Only with a report, flag or `captureException` |
| Replay (buffer mode) | Last 60 s, in memory | Only with a report, or a flag with `captureReplay`. On-error mode also uploads on uncaught errors. |
| Replay (sampled mode) | Off | Whole sessions, in segments |
| Screenshot | Taken when the reporter opens the widget | With the report |
| Storage | Keys only | With the report |
| Analytics (`features.analytics`) | Cookieless | Batched events, sent with `sendBeacon` on page hide |

Before the first user interaction Spotter makes no requests of its own: the
remote config fetch and the offline-queue replay wait for it. Its code chunks
do load on idle.

## Redaction (in the browser, before upload)

- **Pattern scrubbers** run on console arguments, network URLs, headers and
  bodies, breadcrumb labels, error messages and DOM text. They cover emails,
  card numbers (Luhn-checked), SSNs, bearer tokens, API keys, JWTs and common
  secret formats. Matches become `[redacted:<kind>]`. Add your own pass with
  `spotter.setRedactor((value, where) => …)`.
- **Query parameters** named like `token`, `key`, `secret`, `password`,
  `code`, `auth`, `session` or `sig` are stripped from every URL. Extend the
  list with `privacy.stripQueryParams`.
- **Headers**: `Authorization`, `Cookie`, `Set-Cookie` and
  `Proxy-Authorization` are never captured. Other headers are only captured
  when listed in `privacy.networkHeaders`.
- **Bodies** are off by default. Allowlist them per URL pattern with
  `privacy.networkBodies`, and they are still scrubbed.
- **Masking** in replay, screenshots and DOM snapshots: all input values are
  masked and `<input type=password>` is never recorded. `privacy.maskText`
  can be `none`, `inputs` (the default) or `all`. `data-spotter-mask` masks
  an element's text; `data-spotter-block` replaces it with a placeholder box;
  `data-spotter-unmask` opts an element back in. Canvas, video and
  cross-origin iframes are blocked unless you opt in per selector
  (`replay.recordCanvas`, `recordMedia`, `recordIframes`).
- **Storage** values are captured only for keys in `privacy.storageValues`.
- **Review before send** (`privacy.reviewBeforeSend`) lists every attachment
  in plain language and lets the reporter remove items.

## Consent

```ts
spotter.setConsent({ replay: true, analytics: false });
```

`undefined` means not asked. What each mode does with the consent state:

| Mode | Runs when | Notes |
| --- | --- | --- |
| Buffer and on-error replay | Unless `replay: false` | Nothing is sent without a report, flag or error |
| Sampled replay | Unless `replay: false` | Uploads whole sessions |
| Cookieless analytics | Unless `analytics: false`, or GPC / DNT is on and honoured | No cookies, no storage beyond a tab-session id, no personal data |
| Cookie analytics (`analytics.mode: "cookie"`) | Only with `analytics: true` | Sets `_spotter_vid` |
| `analytics.identify: true` | Only with `analytics: true` | Links events to `identify()`'s id |

Global Privacy Control is honoured by default (`analytics.honorGpc`); Do Not
Track is honoured with `analytics.honorDnt: true`.

**Which legal basis applies is your decision; Spotter doesn't make it for you.**
In most setups:

- **Buffer-only replay** keeps data in memory and sends it only when someone
  files a report, or when a flag or error you configured fires. It's designed
  to fit **legitimate interest** (debugging problems users report), provided
  masking stays on and your privacy notice covers it.
- **Sampled full-session replay** records sessions nobody reported. Where the
  law requires consent for that (ePrivacy / GDPR in the EU and UK, for
  example), start with `setConsent({ replay: false })` before `init` and
  switch it on after opt-in.
- **Cookieless analytics** stores nothing on the device and sends no personal
  data, so in most setups no consent banner is required for it. Check with
  your counsel before relying on that; we document it rather than promise it.

CMP integration: `connectConsentManager((c) => spotter.setConsent(c))` wires
the IAB TCF v2 API, Cookiebot and OneTrust (statistics / measurement purposes
map to `analytics` and `replay`). It returns an unsubscribe function.

## Security

- Project keys (`pk_…`) are public, scoped to ingest, and bound to allowed
  origins. The route handler adds a per-IP rate limit, optional Cloudflare
  Turnstile for anonymous submissions (`TURNSTILE_SECRET_KEY`), and CORS
  limited to your origins.
- Secret keys (`sk_…`) belong on the server only. The SDK warns in
  development if one reaches the browser, and `trusplex spotter doctor`
  flags `NEXT_PUBLIC_` variables holding one.
- Artifacts are served through short-lived HMAC-signed URLs.
- Reporter tokens (in `localStorage`, under `spotter:reports`) only grant
  access to that report's public status and conversation.

## Content Security Policy

Spotter needs no `eval` and no inline scripts. For the default setup (the
first-party route at `/api/spotter`):

| Directive | Entry | Why |
| --- | --- | --- |
| `connect-src` | `'self'` | Reports, uploads, analytics, flags and config go to `/api/spotter` |
| `connect-src` | origins of your images and fonts (CDN) | The DOM screenshot fetches them to inline them; blocked ones render blank |
| `connect-src` | `https://console.trusplex.com` | Only if the browser talks to the hosted ingest directly (`endpoint` set to it) |
| `worker-src` | `blob:` | Replay compression runs in a Worker from a blob URL. Without it, compression falls back to the main thread. |
| `img-src` | `blob: data:` | The screenshot preview and the annotation canvas |
| `style-src` | a nonce | Pass `nonce` to `<SpotterProvider>` for browsers without constructable stylesheets |
| `script-src` | your CDN origin plus the SRI hash | Only for the CDN build (`dist/cdn/sri.json` has the `sha384-…` hashes) |
| `frame-src` / `child-src` | none | Spotter uses no iframes |

The Console team sign-in (`connectTeam()`) opens a popup to
`https://console.trusplex.com` and reads its `postMessage`, checking the
origin. That needs no CSP entry on your side.

`npx trusplex spotter doctor` reads the CSP from `next.config` or
`middleware` and checks these entries.
