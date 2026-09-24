/**
 * Config resolution: code config + environment + compiled features, and the
 * narrowing rules for remote config.
 *
 * Precedence: compiled features ⊇ code config ⊇ remote config (narrowing
 * lives in `remote-config.ts`, which loads with the session chunk, not the
 * loader).
 */
import { COMPILED_FEATURES, type FeatureName } from "./features.ts";
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

