/**
 * An issue as Markdown: the body the GitHub hook posts, also handy for
 * custom hooks (Linear and Jira both accept Markdown).
 */
import type { Issue } from "../schema.ts";
import { reproSteps } from "../timeline.ts";

export const FINGERPRINT_MARKER = (fp: string) => `<!-- spotter-fingerprint:${fp} -->`;
export const FINGERPRINT_RE = /<!-- spotter-fingerprint:([a-z0-9_-]+) -->/i;

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fence(s: string): string {
  const ticks = s.includes("```") ? "````" : "```";
  return `${ticks}\n${s}\n${ticks}`;
}

export interface MarkdownOptions {
  /** Link to the report in Console (or your self-hosted view). */
  reportUrl?: string;
  /** Max console/error lines. */
  maxLines?: number;
}

export function issueMarkdown(issue: Issue, options: MarkdownOptions = {}): string {
  const max = options.maxLines ?? 10;
  const out: string[] = [];
  const c = issue.content;
  out.push(`**${issue.ref}** · ${c.category} · severity **${c.severity}** · source \`${issue.source}\`${issue.test ? " · 🧪 test" : ""}`);
  if (options.reportUrl) out.push(`[Open in Console](${options.reportUrl})`);
  out.push("");
  if (c.description) out.push(c.description, "");
  if (c.expected) out.push(`**Expected:** ${c.expected}`, "");
  const fields = Object.entries(c.fields);
  if (fields.length) {
    out.push("| Field | Value |", "| --- | --- |");
    for (const [k, v] of fields) out.push(`| ${esc(k)} | ${esc(Array.isArray(v) ? v.join(", ") : String(v))} |`);
    out.push("");
  }

  const links: string[] = [];
  for (const a of issue.artifacts) {
    if (!a.url) continue;
    const label = { screenshot: "Screenshot", annotated_screenshot: "Annotated screenshot", replay: "Session replay", recording: "Screen recording", attachment: `Attachment \`${a.name}\``, dom_snapshot: "DOM snapshot" }[a.kind];
    links.push(a.kind === "screenshot" || a.kind === "annotated_screenshot" ? `- ${label}: [${a.name}](${a.url})` : `- [${label}](${a.url})`);
  }
  const shot = issue.artifacts.find((a) => a.kind === "annotated_screenshot" && a.url) ?? issue.artifacts.find((a) => a.kind === "screenshot" && a.url);
  if (shot?.url) out.push(`![screenshot](${shot.url})`, "");
  if (links.length) out.push("### Artifacts", ...links, "_Links are short-lived; open the report for permanent access._", "");

  if (issue.timeline.length) out.push("### Steps to reproduce", reproSteps(issue.timeline), "");

  out.push("### Page", `- URL: ${issue.page.url}`);
  if (issue.page.routePattern) out.push(`- Route: \`${issue.page.routePattern}\``);
  if (issue.page.selector) out.push(`- Element: \`${issue.page.selector}\``);
  out.push("");

  const env = issue.environment;
  const rows: [string, string | undefined][] = [
    ["Browser", env.browser ? `${env.browser.name} ${env.browser.version ?? ""}`.trim() : undefined],
    ["OS", env.os ? `${env.os.name} ${env.os.version ?? ""}`.trim() : undefined],
    ["Device", env.device],
    ["Viewport", env.viewport ? `${env.viewport.width}×${env.viewport.height}${env.dpr ? ` @${env.dpr}x` : ""}` : undefined],
    ["Locale", [env.locale, env.timeZone].filter(Boolean).join(" · ") || undefined],
    ["Network", env.network ? `${env.network.online ? "online" : "offline"}${env.network.effectiveType ? ` (${env.network.effectiveType})` : ""}` : undefined],
    ["Release", [issue.release.version, issue.release.commit?.slice(0, 7), issue.release.environment].filter(Boolean).join(" · ") || undefined],
    ["Runtime", env.runtime],
  ];
  out.push("### Environment", "| | |", "| --- | --- |");
  for (const [k, v] of rows) if (v) out.push(`| ${k} | ${esc(v)} |`);
  out.push("");

  const errors = issue.signals.errors.slice(-max);
  if (errors.length) {
    out.push("### Errors");
    for (const e of errors) out.push(fence(`${e.type}: ${e.message}${e.stack ? `\n${e.stack.split("\n").slice(0, 8).join("\n")}` : ""}`));
    out.push("");
  }
  const consoleErrors = issue.signals.console.filter((e) => e.level === "error" || e.level === "warn").slice(-max);
  if (consoleErrors.length) {
    out.push("### Console", fence(consoleErrors.map((e) => `[${e.level}] ${e.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`.slice(0, 500)).join("\n")), "");
  }
  const failed = issue.signals.network.log.entries.filter((e) => e.response.status >= 400 || e.response.status === 0).slice(-max);
  if (failed.length) {
    out.push("### Failed requests", "| Method | URL | Status | Time |", "| --- | --- | --- | --- |");
    for (const e of failed) out.push(`| ${e.request.method} | ${esc(e.request.url.slice(0, 120))} | ${e.response.status || "failed"} | ${Math.round(e.time)} ms |`);
    out.push("");
  }
  if (issue.reporter.type !== "public" || issue.reporter.id) out.push(`Reported by a ${issue.reporter.type} reporter${issue.reporter.id ? ` (\`${issue.reporter.id}\`)` : ""}.`, "");
  out.push(FINGERPRINT_MARKER(issue.fingerprint), `<!-- spotter-issue:${issue.id} -->`);
  return out.join("\n");
}
