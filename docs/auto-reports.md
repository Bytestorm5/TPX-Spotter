# Automatic reports

With `autoReport`, Spotter files a report on its own when something goes
wrong anywhere on the site. Nobody has to press the button. You decide which
problems count. Each report carries everything a person-filed report does:
screenshot, replay, console, network log (HAR), breadcrumbs and repro steps,
DOM snapshot, storage, performance, environment and app context. On top of
that, it says what triggered it and what state the page was in.

It's off by default.

```tsx
// app/layout.tsx
<SpotterProvider autoReport>
```

```ts
// instrumentation.ts: server errors (Next ≥ 15)
import { createOnRequestError } from "@trusplex/spotter/ui/next";
export const onRequestError = createOnRequestError();
```

## What counts

Each kind of problem has its own rule. `true` turns a kind on with its
defaults, `false` turns it off, and one or more matchers say exactly what
counts.

| Kind | Watches | Default |
| --- | --- | --- |
| `errors` | Uncaught errors, unhandled promise rejections | on (bar cross-origin `Script error.` and the `ResizeObserver loop` notice) |
| `network` | `fetch` / XHR responses with an error status; requests that got no response (offline, CORS, DNS) | `{ status: "5xx", failed: true }`: **4xx are not reported** |
| `page` | The page's own HTTP status: the document load, or a client-side navigation's RSC request | `{ status: "5xx" }` |
| `console` | `console.error(err)` calls that pass an `Error`: how React, Next and most apps log the exceptions they catch | on |
| `resources` | `<img>`, `<script>`, `<link>`, `<video>`… that failed to load | off |
| `csp` | Content-Security-Policy violations | off |
| `server` | Errors `onRequestError` sees: server components, route handlers, server actions, middleware | `{ status: "5xx" }` (so `notFound()` isn't a report) |

So a 404 isn't noteworthy by default. For a site where it is:

```tsx
<SpotterProvider
  autoReport={{
    // A broken link is a bug here: report pages that 404.
    page: { status: ["5xx", 404] },
    // API 4xx are mostly validation, but a 404 from our own API means a broken client.
    network: [{ status: "5xx" }, { status: 404, urls: ["/api/*"] }],
    // Failed images on our CDN, not on third-party embeds.
    resources: { urls: ["https://cdn.example.com/*"] },
    ignore: ["/api/health", "Extension context invalidated"],
  }}
>
```

### Matchers

A matcher's fields are ANDed. A field you leave out matches anything. A kind
given several matchers reports when any one of them matches.

| Field | Applies to | |
| --- | --- | --- |
| `status` | network, page, resource, server | `404`, `"4xx"`, `"500-503"`, `"!401"` (exclude); one value or a list |
| `urls` / `ignoreUrls` | all with a URL | globs (`*`; a leading `/` matches the path) or RegExps |
| `methods` | network | `["POST", "PUT"]` |
| `messages` / `ignoreMessages` | all | case-insensitive substrings or RegExps |
| `types` | errors, console, server | error class names: `["TypeError", "ChunkLoadError"]` |
| `mechanisms` | errors | `"uncaught"`, `"unhandledrejection"` |
| `levels` | console | `["error"]` (default), add `"warn"` |
| `withError` | console | default `true`; `false` also reports plain-string `console.error` lines |
| `failed` | network, resource, page | requests with no response at all; default `true` |
| `aborted` | network | aborted requests; default `false` |
| `severity` | all | severity of reports this matcher files |

Only strings, numbers and booleans can cross from a server component to
`<SpotterProvider>`. RegExps and `filter` need the provider to sit in a
client component (as the fixture's `spotter-client.tsx` does).

### Global options

| Option | Default | |
| --- | --- | --- |
| `ignore` | `[]` | messages or URLs that are never reported, whatever the kind or the filter |
| `filter(event, matched)` | none | the last word on every problem: return `true` to report it, `false` to drop it, nothing to keep the rules' decision |
| `delayMs` | `1000` | problems within this window go into one report |
| `limits.perIssue` | `1` | reports for the same problem per tab session (server: per process per hour) |
| `limits.perSession` | `10` | automatic reports per tab session (server: per process per hour) |
| `include` | everything | what to attach: `{ screenshot: false }` to skip the screenshot, and so on |
| `tags` | `{}` | added to every automatic report |
| `severity` | per kind | `error` for errors, 5xx and failures; `warning` for 4xx, resources and CSP |
| `enabled` | `true` | `false` keeps the rules but turns them off |

```ts
autoReport: {
  filter: (event, matched) => {
    if (event.kind === "network" && event.status === 409 && event.url?.includes("/api/cart")) return true;
    if (event.kind === "error" && /chrome-extension:/.test(event.stack ?? "")) return false;
    return matched;
  },
}
```

## What's in the report

Automatic reports use `source: "error"` (or `"server"`) and the regular
`spotter.report.v1` shape, so hooks, Dispatcher, Console and GitHub need no
changes.

- **Title**: the headline problem, e.g. `TypeError: Cannot read properties of
  undefined (reading 'balance')` or `POST /api/charge responded 502 Bad Gateway`.
- **Description**: when and where it happened, every problem in the window in
  order (with counts and durations), and repro steps built from the
  breadcrumb timeline.
- **Grouping**: the fingerprint is the headline error's (type and top frame),
  or for HTTP problems the method, normalized path and status. One broken
  endpoint is one issue, whichever order IDs come in.
- **Tags**: `spotter.auto: "true"`, `spotter.trigger: <kind>`, `http.status`,
  `error.type`, and on the server `next.routePath` and `next.routeType`.
- **`context.contexts.autoReport`**: `trigger`, `summary`, every event (kind,
  time, type, message, count, status, method, URL, duration, mechanism,
  directive…), and the page's state: URL, visibility, focus, ready state,
  online, time since load and JS heap.
- **Signals and artifacts**: what any report has: console, errors with parsed
  stacks, HAR network log, breadcrumbs, navigation, Web Vitals, storage keys,
  environment; screenshot, replay buffer, DOM snapshot, `spotter.attach()`
  files.
- **Server reports** carry the route (`routerKind`, `routePath`, `routeType`,
  `renderSource`, `revalidateReason`), method, path and the error `digest` the
  browser was shown. When the request came from a page running Spotter (a
  `fetch`, a server action, a client-side navigation), its `x-spotter-session`
  header links the server report to that browser session and its replay.
  That browser files its own report for the failed request, so you see both
  sides.

Automatic reports are silent. The visitor sees no UI, and the reports don't
appear in their "My reports". Listen for them if you want to say something:

```ts
spotter.on("autoReport", ({ trigger, receipt }) => toast(`We hit a problem and reported it (${receipt.ref}).`));
```

## Noise control

- **Coalescing**: a failed request, the rejection it causes and the error
  that gets logged arrive within milliseconds and become one report. The most
  fundamental one (server → error → page → network → console → resource →
  csp) is the headline.
- **Limits**: per tab session (sessionStorage), so a crash loop files one
  report, not hundreds.
- **Explicit reports win**: an error already filed with `captureException()`
  (including by `<SpotterErrorBoundary>`) isn't filed again when React then
  logs it.
- **Prefetches don't count**: a client-side navigation's failed RSC request
  only becomes a `page` problem if the user actually ends up on that page.
- **Early errors count**: a crash during hydration, before the watcher has
  loaded, is still reported (it reads what the capture signals buffered).

## Notes

- **Next.js error pages.** Next's built-in error page renders without your
  root layout, so Spotter isn't on it. Add an `app/error.tsx`: it renders
  inside the layout, and the failed page is then reported from the browser as
  well as from the server.
- **Cost.** With `autoReport` on, the session chunk (~21 KB gzip) and the
  watcher (~5 KB) load on idle after init instead of on first interaction.
  Off, nothing changes: the only init-time code is one check.
- **Privacy.** Everything goes through the same redaction as any report
  (query parameters, emails, tokens, your `setRedactor()`), titles and
  descriptions included. Screenshots respect masking. Set `include: {
  screenshot: false }` (or `replay`, `storage`, `dom`) to send less.
- **Turnstile.** If your ingest requires Turnstile for public reporters,
  automatic reports from anonymous visitors are rejected, as
  `captureException()` reports are today. Identify users, or rely on
  server-side reports.
- **Bots and tests.** Use `filter` or `enabled` to skip synthetic traffic
  (e.g. `enabled: !navigator.webdriver`).
