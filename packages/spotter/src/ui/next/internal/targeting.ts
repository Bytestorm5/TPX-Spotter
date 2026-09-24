/**
 * Trigger targeting (`TargetingRule`): show the widget only on some routes,
 * environments, releases or reporter segments — "only on staging", "only for
 * logged-in beta users". Pure so it can run on every navigation for free.
 *
 * Every list is an allowlist that must match when present (AND across
 * dimensions, OR within one); `excludeRoutes` wins over `routes`.
 */
import type { TargetingRule } from "../../../core/schema.ts";

export interface TargetingContext {
  /** `location.pathname`. */
  path: string;
  /** App Router pattern (`/blog/[slug]`), when known — rules may be written against either. */
  routePattern?: string;
  environment?: string;
  release?: string;
  reporter: {
    identified: boolean;
    type: "public" | "guest" | "team";
    traits?: Record<string, unknown>;
  };
}

/**
 * Route globs: `*` matches within one path segment, `**` across segments,
 * a trailing `/*` also matches the bare parent (`/checkout/*` ⊇ `/checkout`).
 * Next-style patterns (`/blog/[slug]`) compare literally.
 */
export function routeMatches(glob: string, path: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p) || "/";
  const g = norm(glob.trim());
  const p = norm(path);
  if (g === p) return true;
  if (g.endsWith("/*") && p === norm(g.slice(0, -2))) return true;
  if (g.endsWith("/**") && p === norm(g.slice(0, -3))) return true;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === "*") {
      if (g.charAt(i + 1) === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(p);
}

function valueMatches(pattern: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (!pattern.includes("*")) return pattern === value;
  const re = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(value);
}

function segmentMatches(segment: string, reporter: TargetingContext["reporter"]): boolean {
  switch (segment) {
    case "identified":
      return reporter.identified;
    case "anonymous":
      return !reporter.identified;
    case "team":
    case "guest":
    case "public":
      return reporter.type === segment;
  }
  if (segment.startsWith("trait:")) {
    const [key, expected] = segment.slice(6).split("=", 2) as [string, string | undefined];
    const actual = reporter.traits?.[key];
    if (expected === undefined) return actual !== undefined && actual !== null && actual !== false;
    return String(actual) === expected;
  }
  return false;
}

/** Whether the trigger should be shown for this context. No rule = shown. */
export function evaluateTargeting(rule: TargetingRule | undefined | null, ctx: TargetingContext): boolean {
  if (!rule) return true;
  const paths = [ctx.path, ctx.routePattern].filter((p): p is string => !!p);
  if (rule.excludeRoutes?.some((g) => paths.some((p) => routeMatches(g, p)))) return false;
  if (rule.routes && rule.routes.length > 0 && !rule.routes.some((g) => paths.some((p) => routeMatches(g, p)))) {
    return false;
  }
  if (rule.environments && rule.environments.length > 0 && !rule.environments.some((e) => valueMatches(e, ctx.environment))) {
    return false;
  }
  if (rule.releases && rule.releases.length > 0 && !rule.releases.some((r) => valueMatches(r, ctx.release))) {
    return false;
  }
  if (rule.segments && rule.segments.length > 0 && !rule.segments.some((s) => segmentMatches(s, ctx.reporter))) {
    return false;
  }
  return true;
}

/**
 * Code config overrides remote, but remote can still narrow: both rules must
 * pass. (A remote rule can hide the trigger; it can never show one that code
 * hid.)
 */
export function combineTargeting(code: TargetingRule | undefined, remote: TargetingRule | undefined, ctx: TargetingContext): boolean {
  return evaluateTargeting(code, ctx) && evaluateTargeting(remote, ctx);
}
