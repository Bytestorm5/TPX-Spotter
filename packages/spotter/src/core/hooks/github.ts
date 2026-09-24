/**
 * The built-in GitHub hook, with two-way status sync.
 *
 * - `send`: opens an issue (title, Markdown body with repro steps, an
 *   environment table, console errors and artifact links, labels from
 *   category and severity) carrying a `<!-- spotter-fingerprint:… -->`
 *   marker. With `dedupe: "fingerprint"` (default) a report whose
 *   fingerprint matches an open issue — known from the delivery store, or
 *   found by searching the repo for the marker — becomes a comment
 *   ("Another report (N affected users)") instead.
 * - `onStatus`: resolved / won't fix close the issue (with the right
 *   `state_reason`), received / in progress reopen it, needs info comments.
 * - `githubWebhookHandler`: GitHub → Spotter. Verifies
 *   `x-hub-signature-256`, maps `issues.closed` → resolved (not_planned →
 *   wont_fix), `issues.reopened` → in_progress, and a merged PR that closes
 *   an issue → resolved with the PR's release (milestone or merge commit).
 */
import type { Issue, IssueLink, PublicStatus } from "../schema.ts";
import type { HookResult, SpotterHook } from "../types.ts";
import { hmacHex, timingSafeEqual } from "../server/sign.ts";
import { assertServer, defineHook } from "./define.ts";
import { FINGERPRINT_MARKER, FINGERPRINT_RE, issueMarkdown } from "./markdown.ts";

export interface GitHubHookOptions {
  /** `owner/name`. */
  repo: string;
  token: string | undefined;
  labels?: string[] | ((issue: Issue) => string[]);
  when?: (issue: Issue) => boolean;
  title?: (issue: Issue) => string;
  body?: (issue: Issue) => string;
  /** Default `fingerprint`. */
  dedupe?: "fingerprint" | "none";
  /** Link used for "Open in Console"; defaults to the report's first link/artifact host. */
  reportUrl?: (issue: Issue) => string | undefined;
  /** GitHub Enterprise: `https://github.example.com/api/v3`. */
  apiUrl?: string;
  fetch?: typeof fetch;
  retry?: SpotterHook["retry"];
  /** Hook name; default `github` (use distinct names for several repos). */
  name?: string;
}

interface GhIssue {
  number: number;
  html_url: string;
  state: "open" | "closed";
  body?: string | null;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    // 4xx other than rate limits won't fix themselves: fail fast and record it
    this.retryable = status >= 500 || status === 429 || status === 403 || status === 0;
  }
}

export function defaultLabels(issue: Issue): string[] {
  return ["spotter", issue.content.category, `sev:${issue.content.severity}`];
}

export function github(options: GitHubHookOptions): SpotterHook {
  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch: typeof fetch = (i, init) => (options.fetch ?? globalThis.fetch)(i, init);
  const name = options.name ?? "github";

  async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
    assertServer("The github() hook");
    if (!options.token) throw Object.assign(new GitHubError(401, "github(): no token (set GITHUB_TOKEN)"), { retryable: false });
    let res: Response;
    try {
      res = await doFetch(`${api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${options.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "trusplex-spotter",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new GitHubError(0, `GitHub unreachable: ${(error as Error).message}`);
    }
    if (!res.ok) {
      let msg = `GitHub ${method} ${path} → ${res.status}`;
      try {
        msg += `: ${((await res.json()) as { message?: string }).message ?? ""}`;
      } catch {
        /* ignore */
      }
      throw new GitHubError(res.status, msg);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  const labelsFor = (issue: Issue) =>
    [...new Set((typeof options.labels === "function" ? options.labels(issue) : (options.labels ?? defaultLabels(issue))).filter(Boolean))];

  async function findOpenByFingerprint(fp: string): Promise<GhIssue | undefined> {
    const q = encodeURIComponent(`repo:${options.repo} is:issue is:open in:body "spotter-fingerprint:${fp}"`);
    const r = await gh<{ items: GhIssue[] }>("GET", `/search/issues?q=${q}&per_page=5`);
    // search is fuzzy about punctuation: confirm the exact marker
    return r.items.find((i) => i.body?.includes(FINGERPRINT_MARKER(fp)));
  }

  async function duplicateComment(number: number, issue: Issue): Promise<void> {
    const comments = await gh<{ body?: string }[]>("GET", `/repos/${options.repo}/issues/${number}/comments?per_page=100`);
    const affected = comments.filter((c) => c.body?.includes("<!-- spotter-duplicate")).length + 2;
    const lines = [
      `Another report (${affected} affected users): **${issue.ref}** — ${issue.content.title}`,
      "",
      issue.content.description ? `> ${issue.content.description.split("\n").join("\n> ")}` : "",
      `- Page: ${issue.page.url}`,
      issue.environment.browser ? `- Browser: ${issue.environment.browser.name} ${issue.environment.browser.version ?? ""}` : "",
      issue.release.version ? `- Release: ${issue.release.version}` : "",
      `<!-- spotter-duplicate:${issue.id} -->`,
    ].filter((l) => l !== "");
    await gh("POST", `/repos/${options.repo}/issues/${number}/comments`, { body: lines.join("\n") });
  }

  const reportUrl = (issue: Issue) => options.reportUrl?.(issue);

  return defineHook({
    name,
    when: options.when,
    dedupe: options.dedupe ?? "fingerprint",
    retry: options.retry,
    async send(issue: Issue, previous?: IssueLink): Promise<HookResult> {
      if ((options.dedupe ?? "fingerprint") === "fingerprint") {
        let existing: GhIssue | undefined;
        if (previous) {
          const known = await gh<GhIssue>("GET", `/repos/${options.repo}/issues/${previous.externalId}`).catch(() => undefined);
          if (known?.state === "open") existing = known;
        }
        existing ??= await findOpenByFingerprint(issue.fingerprint);
        if (existing) {
          await duplicateComment(existing.number, issue);
          return { externalId: String(existing.number), url: existing.html_url };
        }
      }
      const created = await gh<GhIssue>("POST", `/repos/${options.repo}/issues`, {
        title: options.title?.(issue) ?? `[${issue.ref}] ${issue.content.title}`.slice(0, 256),
        body: ensureMarker(options.body?.(issue) ?? issueMarkdown(issue, { reportUrl: reportUrl(issue) }), issue.fingerprint),
        labels: labelsFor(issue),
      });
      return { externalId: String(created.number), url: created.html_url };
    },
    async onStatus(issue: Issue, status: PublicStatus, link?: IssueLink): Promise<void> {
      let number = link?.externalId;
      if (!number) number = (await findOpenByFingerprint(issue.fingerprint))?.number.toString();
      if (!number) return;
      const path = `/repos/${options.repo}/issues/${number}`;
      const latest = issue.status.history[issue.status.history.length - 1];
      const note = [latest?.message, latest?.release ? `Release: ${latest.release}` : ""].filter(Boolean).join("\n\n");
      switch (status) {
        case "resolved":
          if (note) await gh("POST", `${path}/comments`, { body: `Resolved in Spotter.\n\n${note}` });
          await gh("PATCH", path, { state: "closed", state_reason: "completed" });
          return;
        case "wont_fix":
          await gh("PATCH", path, { state: "closed", state_reason: "not_planned" });
          return;
        case "needs_info":
          await gh("POST", `${path}/comments`, { body: `Asked the reporter for more information.${note ? `\n\n${note}` : ""}` });
          return;
        case "received":
        case "in_progress":
          await gh("PATCH", path, { state: "open" });
          return;
      }
    },
  });
}

function ensureMarker(body: string, fp: string): string {
  return body.includes(FINGERPRINT_MARKER(fp)) ? body : `${body}\n\n${FINGERPRINT_MARKER(fp)}`;
}

// -- GitHub → Spotter --------------------------------------------------------------

export interface GitHubStatusUpdate {
  /** The GitHub issue number (the `externalId` the hook stored). */
  externalId: string;
  repo: string;
  url: string;
  fingerprint?: string;
  /** The Spotter issue id, when the body carries the marker. */
  issueId?: string;
  status: PublicStatus;
  message?: string;
  release?: string;
}

export interface GitHubWebhookOptions {
  /** The webhook secret configured on the GitHub side. */
  secret: string;
  onStatus: (update: GitHubStatusUpdate) => void | Promise<void>;
  /** Hook name the issues were linked under. Default `github`. */
  hook?: string;
}

const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;

/** Verify `x-hub-signature-256` against the raw body. */
export async function verifyGitHubSignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${await hmacHex(secret, body)}`;
  return timingSafeEqual(expected, signature);
}

/**
 * A `(request) => Response` handler for GitHub's issues / pull_request
 * webhooks. Mount it yourself, or pass `githubWebhookSecret` to
 * `createIngestHandler`, which serves it at `POST /v1/webhooks/github`.
 */
export function githubWebhookHandler(options: GitHubWebhookOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    assertServer("githubWebhookHandler()");
    const body = await request.text();
    if (!(await verifyGitHubSignature(options.secret, body, request.headers.get("x-hub-signature-256"))))
      return Response.json({ error: "bad signature", code: "unauthorized" }, { status: 401 });
    const event = request.headers.get("x-github-event");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid JSON", code: "invalid" }, { status: 400 });
    }
    const updates = githubEventToUpdates(event, payload);
    for (const u of updates) await options.onStatus(u);
    return Response.json({ ok: true, updates: updates.length });
  };
}

/** Pure mapping from a GitHub webhook event to status updates (exported for tests and custom routers). */
export function githubEventToUpdates(event: string | null, payload: Record<string, unknown>): GitHubStatusUpdate[] {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "";
  if (event === "issues") {
    const action = payload.action as string;
    const issue = payload.issue as { number: number; html_url: string; body?: string | null; state_reason?: string | null; milestone?: { title?: string } | null };
    const fp = issue.body?.match(FINGERPRINT_RE)?.[1];
    const issueId = issue.body?.match(/<!-- spotter-issue:([\w-]+) -->/)?.[1];
    if (!fp && !issueId) return [];
    const base = { externalId: String(issue.number), repo, url: issue.html_url, fingerprint: fp, issueId };
    if (action === "closed")
      return [{ ...base, status: issue.state_reason === "not_planned" ? "wont_fix" : "resolved", release: issue.milestone?.title ?? undefined }];
    if (action === "reopened") return [{ ...base, status: "in_progress" }];
    return [];
  }
  if (event === "pull_request") {
    const pr = payload.pull_request as {
      merged?: boolean;
      body?: string | null;
      title?: string;
      html_url: string;
      number: number;
      merge_commit_sha?: string | null;
      milestone?: { title?: string } | null;
    };
    if (payload.action !== "closed" || !pr?.merged) return [];
    const release = pr.milestone?.title ?? (pr.merge_commit_sha ? pr.merge_commit_sha.slice(0, 7) : undefined);
    const out: GitHubStatusUpdate[] = [];
    for (const m of `${pr.title ?? ""}\n${pr.body ?? ""}`.matchAll(CLOSES_RE)) {
      if (m[1] && m[1].toLowerCase() !== repo.toLowerCase()) continue;
      out.push({
        externalId: m[2]!,
        repo,
        url: pr.html_url,
        status: "resolved",
        release,
        message: `Fixed in #${pr.number}${release ? ` (${release})` : ""}.`,
      });
    }
    return out;
  }
  return [];
}
