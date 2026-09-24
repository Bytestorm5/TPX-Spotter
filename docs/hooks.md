# The issue event and hooks

Every ticket, whether it came from the widget, `report()`, a promoted flag, an
error or the server, is broadcast once as the `issue` event, carrying the
`spotter.report.v1` payload. Hooks subscribe to it and deliver it to a ticket
system. Dispatcher is the default hook, not a dependency.

**Hooks run server-side only.** They hold secrets. They run where ingest
runs: Trusplex's hosted ingest (configured in Console) or your own route
handler. Calling `runHooks()` or a hook in a browser throws.

```ts
// spotter.hooks.ts
import { dispatcher, github, defineHook } from "@trusplex/spotter/core";

export const spotterHooks = [
  dispatcher(), // added automatically by the route when a project key and secret key are set
  github({
    repo: "acme/web",
    token: process.env.GITHUB_TOKEN,
    labels: (issue) => [issue.content.category, `sev:${issue.content.severity}`],
    when: (issue) => issue.content.severity !== "info",
  }),
  defineHook({
    name: "linear",
    send: async (issue, previous) => {
      /* create, or comment on `previous` */
      return { externalId: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" };
    },
    onStatus: async (issue, status, link) => {
      /* move the Linear issue */
    },
  }),
];
```

```ts
// app/api/spotter/[[...spotter]]/route.ts
import { createSpotterHandler } from "@trusplex/spotter/ui/next";
import { spotterHooks } from "@/spotter.hooks";

export const { GET, POST, PUT, HEAD, OPTIONS } = createSpotterHandler({ hooks: spotterHooks });
```

The route must be an optional catch-all (`[[...spotter]]`), because the
protocol uses sub-paths.

## Hook contract

| Member | |
| --- | --- |
| `name` | Unique id, shown in Console, in the audit log and in deliveries |
| `when(issue)` | Optional filter. A throw is recorded as a failed delivery. |
| `send(issue, previous?)` | Create or update the external ticket; return `{ externalId, url }`. `previous` is the link stored for this fingerprint when `dedupe` is `fingerprint`. |
| `onStatus(issue, status, link?)` | Optional: follow Spotter's status changes |
| `dedupe` | `fingerprint` (default): pass the existing link so the hook comments instead of creating. `none`: always create. |
| `retry` | `{ attempts = 3, baseDelayMs = 1000, maxDelayMs = 30000 }`: exponential backoff with jitter. An error with `retryable: false` stops early. |

`runHooks(issue, hooks, { store })` runs hooks concurrently, so one failure
never blocks another. Every outcome is recorded in the delivery store as
`delivered`, `skipped` or `failed`. Failed deliveries keep the issue so they
can be retried. The route exposes them at `GET /v1/admin/deliveries?state=failed`
and `POST /v1/admin/deliveries/:id/retry`, both requiring the secret key, and
through `handler.ingest.deliveries()` and `retryDelivery(id)`. The default
store is in memory. Pass `deliveries` with your own `DeliveryStore` to persist
them.

## Built-in: `dispatcher()`

Forwards the full payload, including artifacts and the agent-readable
timeline, to Console's hosted ingest (`SPOTTER_ENDPOINT` or
`https://console.trusplex.com/hooks/spotter`) with `SPOTTER_SECRET_KEY`. That
powers classify, group, diagnose and resolve. Inside the route handler it
makes Console canonical: the submission reaches Console first, so the
reporter's receipt carries Console's id, `SPT-` ref and URL. Status comes back
through Console (`GET status`, reporter notifications).

## Built-in: `github()`

```ts
github({
  repo: "acme/web",
  token: process.env.GITHUB_TOKEN, // fine-grained: Issues read/write
  labels: (issue) => ["spotter", issue.content.category, `sev:${issue.content.severity}`], // default
  when: (issue) => !issue.test,
  title: (issue) => `[${issue.ref}] ${issue.content.title}`, // default
  body: (issue) => issueMarkdown(issue), // default
  apiUrl: "https://github.example.com/api/v3", // GitHub Enterprise
});
```

- **Body**: description, expected result, custom fields, the screenshot
  inline, links to the replay and other artifacts (signed, short-lived), the
  repro steps from the timeline, an environment table, errors, console
  errors and warnings, and failed requests. The reporter's email is never
  posted. It ends with `<!-- spotter-fingerprint:… -->`.
- **Dedupe**: when the fingerprint matches an open issue, the report becomes
  a comment: "Another report (N affected users): SPT-4822 …". The match comes
  from the stored link, or from searching the repo for the marker, so it
  works without a persistent store.
- **Status → GitHub**: `resolved` closes the issue as completed, with the
  resolution message and release as a comment. `wont_fix` closes it as not
  planned. `received` and `in_progress` reopen it. `needs_info` adds a comment.

### GitHub → Spotter (two-way sync)

In the repo, go to Settings → Webhooks and add
`https://your.app/api/spotter/v1/webhooks/github`. Set the content type to
`application/json`, subscribe to *Issues* and *Pull requests*, and set a
secret. Then give the route the same secret:

```ts
createSpotterHandler({ hooks: spotterHooks, githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET });
```

- `issues.closed`: the Spotter issue becomes `resolved`, or `wont_fix` for
  "not planned". The milestone, if any, is the release. The reporter is
  notified.
- `issues.reopened`: `in_progress`.
- A merged PR whose title or body says `Fixes #N` resolves issue N, with the
  PR's milestone (or short merge SHA) as the release: "Fixed in #12
  (v2.14.1)."

The signature (`x-hub-signature-256`) is verified with HMAC-SHA256. Changes
that came from GitHub aren't echoed back to GitHub. Outside the route, use
`githubWebhookHandler({ secret, onStatus })` directly.

## Status changes from your side

```ts
const { ingest } = createSpotterHandler({ hooks });
await ingest.setStatus(id, "resolved", { message: "Fixed in v2.14, live now.", release: "2.14.1" });
await ingest.ask(id, "Which card did you use?"); // needs_info, threaded to the reporter
ingest.on("issue", (issue) => metrics.increment("spotter.issue"));
```

## In the browser

`spotter.on("issue", fn)` fires client-side with the redacted submission and
receipt. It's meant for UI and analytics reactions, and it cannot run
credentialed hooks.
