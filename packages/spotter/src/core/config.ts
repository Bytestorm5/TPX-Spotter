/**
 * Config resolution: code config + environment + compiled features, and the
 * narrowing rules for remote config.
 *
 * Precedence: compiled features ⊇ code config ⊇ remote config. Remote config
 * (from Console) can only narrow — disable a feature, lower a sample rate,
 * shorten the replay window, restrict to routes — never enable something the
 * code or the build left out. Presentation settings (fields, appearance,
 * trigger) come from remote only where code config left them unset: "code
 * config always overrides remote".
 */
import { COMPILED_FEATURES, type FeatureName } from "./features.ts";
import type { RemoteConfig, TargetingRule } from "./schema.ts";
import type { ReplayMode, SpotterConfig } from "./types.ts";

export const HOSTED_ENDPOINT = "https://console.trusplex.com/hooks/spotter";
export const CONSOLE_ORIGIN = "https://console.trusplex.com";
export const DEFAULT_BROWSER_ENDPOINT = "/api/spotter";

export type RuntimeKind = "browser" | "node" | "edge";

export function detectRuntime(): RuntimeKind {
  const g = globalThis as { window?: unknown; document?: unknown; EdgeRuntime?: unknown };
  if (typeof g.window !== "undefined" && typeof g.document !== "undefined") return "browser";
  if (typeof g.EdgeRuntime === "string") return "edge";
  return "node";
}

/** Server env lookup that never throws (edge runtimes, browsers without `process`). */
export function readEnv(name: string): string | undefined {
  try {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
    return v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * Browser-inlined public env. Next inlines `process.env.NEXT_PUBLIC_*` only
 * when written literally, so these stay literal; the try/catch covers
 * bundlers that don't define `process`.
 */
function publicEnv(): { project?: string; endpoint?: string; environment?: string } {
  const out: { project?: string; endpoint?: string; environment?: string } = {};
  try {
    out.project = process.env.NEXT_PUBLIC_SPOTTER_PROJECT || undefined;
  } catch {
    /* not defined */
  }
  try {
    out.endpoint = process.env.NEXT_PUBLIC_SPOTTER_ENDPOINT || undefined;
  } catch {
    /* not defined */
  }
  return out;
}

export interface ResolvedConfig extends SpotterConfig {
  runtime: RuntimeKind;
  endpoint: string;
  /** Effective features: compiled ∧ code config ∧ remote. */
  features: Record<FeatureName, boolean>;
  test: boolean;
  replayMode: ReplayMode;
  windowSeconds: number;
  flagRateLimit: number;
}

const MODE_RANK: Record<ReplayMode, number> = { off: 0, buffer: 1, on_error: 2, sampled: 3 };

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function resolveConfig(config: SpotterConfig, runtime: RuntimeKind = detectRuntime()): ResolvedConfig {
  const server = runtime !== "browser";
  const env = server ? {} : publicEnv();
  const project = config.project ?? env.project ?? (server ? readEnv("SPOTTER_PROJECT") ?? readEnv("NEXT_PUBLIC_SPOTTER_PROJECT") : undefined);
  const secretKey = server ? config.secretKey ?? readEnv("SPOTTER_SECRET_KEY") : undefined;
  const endpoint = (
    config.endpoint ??
    (server ? readEnv("SPOTTER_ENDPOINT") ?? HOSTED_ENDPOINT : env.endpoint ?? DEFAULT_BROWSER_ENDPOINT)
  ).replace(/\/+$/, "");
  const environment = config.environment ?? (server ? readEnv("SPOTTER_ENVIRONMENT") : undefined);

  const features = { ...COMPILED_FEATURES } as Record<FeatureName, boolean>;
  for (const [name, on] of Object.entries(config.features ?? {}) as [FeatureName, boolean | undefined][]) {
    if (on === false && name in features) features[name] = false;
  }
  const replayMode: ReplayMode = !features.replay ? "off" : config.replay?.mode ?? "buffer";
  return {
    ...config,
    project,
    secretKey,
    endpoint,
    environment,
    runtime,
    features,
    test: environment === "development",
    replayMode,
    windowSeconds: clamp(config.replay?.windowSeconds ?? 60, 15, 300),
    flagRateLimit: Math.max(1, config.flagRateLimit ?? 10),
  };
}

export interface RemoteApplication {
  config: ResolvedConfig;
  /** Things remote asked for that aren't possible here (compiled out / wider than code). */
  ignored: string[];
}

/** Apply remote config, narrowing only. Pure: returns a new resolved config. */
export function applyRemoteConfig(base: ResolvedConfig, remote: RemoteConfig): RemoteApplication {
  const ignored: string[] = [];
  const features = { ...base.features };
  for (const [name, on] of Object.entries(remote.features ?? {}) as [FeatureName, boolean | undefined][]) {
    if (!(name in features)) continue;
    if (on === false) features[name] = false;
    else if (on === true && !features[name]) ignored.push(`features.${name}`);
  }

  let replayMode = features.replay ? base.replayMode : "off";
  const rm = remote.replay?.mode;
  if (rm) {
    if (MODE_RANK[rm] <= MODE_RANK[replayMode]) replayMode = rm;
    else ignored.push(`replay.mode=${rm}`);
  }
  const windowSeconds = remote.replay?.windowSeconds
    ? Math.min(base.windowSeconds, clamp(remote.replay.windowSeconds, 15, 300))
    : base.windowSeconds;

  const replay = { ...base.replay, mode: replayMode };
  if (remote.replay?.sampleRate !== undefined)
    replay.sampleRate = Math.min(base.replay?.sampleRate ?? 1, clamp(remote.replay.sampleRate, 0, 1));
  if (remote.replay?.sampling) replay.sampling = narrowSampling(base.replay?.sampling, remote.replay.sampling);

  const analytics = { ...base.analytics };
  if (remote.analytics?.sampleRate !== undefined)
    analytics.sampleRate = Math.min(base.analytics?.sampleRate ?? 1, clamp(remote.analytics.sampleRate, 0, 1));
  if (remote.analytics?.honorGpc) analytics.honorGpc = true;
  if (remote.analytics?.honorDnt) analytics.honorDnt = true;

  const trigger = { ...remote.trigger, ...base.trigger };
  if (remote.trigger?.targeting && base.trigger?.targeting)
    trigger.targeting = intersectTargeting(base.trigger.targeting, remote.trigger.targeting);

  return {
    config: {
      ...base,
      features,
      replayMode,
      windowSeconds,
      replay,
      analytics,
      trigger,
      fields: base.fields ?? remote.fields,
      appearance: base.appearance ?? remote.appearance,
      duplicates: { ...remote.duplicates, ...base.duplicates },
    },
    ignored,
  };
}

function narrowSampling(
  code: NonNullable<SpotterConfig["replay"]>["sampling"] | undefined,
  remote: NonNullable<NonNullable<RemoteConfig["replay"]>["sampling"]>,
): NonNullable<SpotterConfig["replay"]>["sampling"] {
  const out: Record<"routes" | "segments" | "releases", Record<string, number>> = { routes: {}, segments: {}, releases: {} };
  for (const kind of ["routes", "segments", "releases"] as const) {
    const c = code?.[kind] ?? {};
    const r = remote[kind] ?? {};
    for (const [k, v] of Object.entries(c)) out[kind][k] = v;
    for (const [k, v] of Object.entries(r)) out[kind][k] = Math.min(c[k] ?? 1, clamp(v, 0, 1));
  }
  return out;
}

/** Both rules must pass: route lists intersect, exclusions union. */
function intersectTargeting(a: TargetingRule, b: TargetingRule): TargetingRule {
  const both = (x?: string[], y?: string[]) => (x && y ? x.filter((v) => y.includes(v)) : (x ?? y));
  return {
    routes: both(a.routes, b.routes),
    excludeRoutes: [...(a.excludeRoutes ?? []), ...(b.excludeRoutes ?? [])],
    environments: both(a.environments, b.environments),
    segments: both(a.segments, b.segments),
    releases: both(a.releases, b.releases),
  };
}

/** `/checkout/*` style globs: `*` matches one segment, `**` any. */
export function matchRoute(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const re = new RegExp(
    `^${pattern
      .split("**")
      .map((p) => p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
      .join(".*")}$`,
  );
  return re.test(path);
}

export interface TargetingContext {
  path: string;
  environment?: string;
  release?: string;
  /** e.g. `identified`, `anonymous`, `team`, `guest`, `trait:plan=pro`. */
  segments: string[];
}

export function targetingMatches(rule: TargetingRule | undefined, ctx: TargetingContext): boolean {
  if (!rule) return true;
  if (rule.routes?.length && !rule.routes.some((r) => matchRoute(r, ctx.path))) return false;
  if (rule.excludeRoutes?.some((r) => matchRoute(r, ctx.path))) return false;
  if (rule.environments?.length && (!ctx.environment || !rule.environments.includes(ctx.environment))) return false;
  if (rule.releases?.length && (!ctx.release || !rule.releases.includes(ctx.release))) return false;
  if (rule.segments?.length && !rule.segments.some((s) => ctx.segments.includes(s))) return false;
  return true;
}

/** Sampled-replay rate for this page: the most specific rule wins (route, then segment, then release). */
export function replaySampleRate(config: ResolvedConfig, ctx: TargetingContext): number {
  const s = config.replay?.sampling;
  for (const [pattern, rate] of Object.entries(s?.routes ?? {})) if (matchRoute(pattern, ctx.path)) return rate;
  for (const seg of ctx.segments) if (s?.segments?.[seg] !== undefined) return s.segments[seg]!;
  if (ctx.release && s?.releases?.[ctx.release] !== undefined) return s.releases[ctx.release]!;
  return config.replay?.sampleRate ?? 0;
}
