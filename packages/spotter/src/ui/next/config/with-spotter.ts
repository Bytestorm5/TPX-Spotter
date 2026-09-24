/**
 * `withSpotter(nextConfig, options)` — the Next.js config plugin.
 *
 * - **Compile-time feature flags.** Each feature becomes a constant through
 *   `compiler.define` (Next ≥ 15.3; honoured by both webpack and Turbopack,
 *   so no DefinePlugin is needed), under the names in `FEATURE_DEFINES`,
 *   plus `__SPOTTER_DEV__`. The minifier then drops every disabled feature's
 *   code and its lazy `import()`.
 * - **Zero-prop provider.** The project key, release and environment are
 *   exposed as `NEXT_PUBLIC_SPOTTER_*` through `env`, which Next inlines, so
 *   `<SpotterProvider>` needs no props.
 * - **Release auto-detection** (Vercel, Netlify, Cloudflare Pages,
 *   Console-managed deploys, then `package.json`'s version).
 * - **Route patterns.** Scans `app/` (or `src/app/`) for dynamic routes and
 *   inlines them as `NEXT_PUBLIC_SPOTTER_ROUTES`, so every captured URL gets
 *   its pattern (`/blog/[slug]`) synchronously — even the history-patch
 *   pageview that fires before React renders the new route.
 * - **Typed flags.** Writes `spotter-env.d.ts` (see `env-dts.ts`).
 * - **Private source maps.** With `SPOTTER_SECRET_KEY` set, browser source
 *   maps are generated, uploaded after compilation
 *   (`compiler.runAfterProductionCompile`, which runs for webpack and
 *   Turbopack builds alike), then **deleted from `.next/static`** and their
 *   `sourceMappingURL` comments stripped. Deleting is the robust choice:
 *   a header or rewrite rule can be bypassed by a CDN or a custom server
 *   serving `.next/static` directly, a missing file cannot. Without a secret
 *   key it does nothing (and says so once in development).
 *
 * Node-only. Built-ins are reached through `process.getBuiltinModule`, never
 * an `import`, so no bundler resolving the `ui/next` barrel for the browser
 * or the edge ever sees a `node:` specifier.
 */
import type { NextConfig } from "next";
import { COMPILED_FEATURES, FEATURE_DEFINES, type FeatureName } from "../../../core/features.ts";
import { detectRelease, releaseName, type DetectedRelease } from "../internal/release.ts";
import { appDirToPattern } from "../internal/route-pattern.ts";
import { generateEnvDts, type SpotterTypesOptions } from "./env-dts.ts";

export interface WithSpotterOptions {
  /** Public project key. Default `NEXT_PUBLIC_SPOTTER_PROJECT` from the environment. */
  project?: string;
  /** Compile-time features. Unset ones keep their defaults (everything on except `recording`). */
  features?: Partial<Record<FeatureName, boolean>>;
  /** Override the detected release. */
  release?: { version?: string; commit?: string; deployId?: string; environment?: string };
  sourceMaps?: {
    /** Default true when a secret key is available. */
    upload?: boolean;
    /** Ingest to upload to. Default `SPOTTER_ENDPOINT`, else Console's hosted ingest. */
    endpoint?: string;
    /** Remove the maps from the build output after uploading. Default true. */
    deleteAfterUpload?: boolean;
  };
  /** Generate `spotter-env.d.ts` for typed events, fields and contexts. `false` skips the file. */
  types?: SpotterTypesOptions | false;
  /** Env var holding the secret key. Default `SPOTTER_SECRET_KEY`. */
  secretKeyEnv?: string;
  /** Where `spotter-env.d.ts` goes. Default the project root (`process.cwd()`). */
  typesPath?: string;
}

type Phase = string;
type ConfigFn = (phase: Phase, ctx: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>;

type Builtin = <T>(id: string) => T;
function builtin<T>(id: string): T | null {
  const get = (globalThis as { process?: { getBuiltinModule?: Builtin } }).process?.getBuiltinModule;
  return get ? get<T>(id) : null;
}

type Fs = typeof import("node:fs");
type Path = typeof import("node:path");

function env(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function readPackageVersion(): string | undefined {
  const fs = builtin<Fs>("node:fs");
  const path = builtin<Path>("node:path");
  if (!fs || !path) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return pkg.version && pkg.version !== "0.0.0" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** Dynamic App Router patterns under `app/` or `src/app/` (static routes are their own pattern). */
export function scanAppRoutes(root: string = process.cwd(), limit = 500): string[] {
  const fs = builtin<Fs>("node:fs");
  const path = builtin<Path>("node:path");
  if (!fs || !path) return [];
  const appDir = ["app", "src/app"].map((d) => path.join(root, d)).find((d) => fs.existsSync(d));
  if (!appDir) return [];
  const found = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 20 || found.size >= limit) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && /^(page|route)\.(tsx?|jsx?|mdx)$/.test(e.name))) {
      const pattern = appDirToPattern(path.relative(appDir, dir));
      if (pattern && pattern.includes("[")) found.add(pattern);
    }
    for (const e of entries) if (e.isDirectory() && e.name !== "node_modules") walk(path.join(dir, e.name), depth + 1);
  };
  walk(appDir, 0);
  return [...found].sort();
}

/** Write only when changed: next.config is evaluated by several build workers. */
function writeIfChanged(file: string, content: string): void {
  const fs = builtin<Fs>("node:fs");
  if (!fs) return;
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
    fs.writeFileSync(file, content);
  } catch {
    /* read-only filesystem (some CI caches): types are a convenience, never a build failure */
  }
}

let warnedNoKey = false;

export function withSpotter(nextConfig: NextConfig | ConfigFn = {}, options: WithSpotterOptions = {}): NextConfig & ConfigFn {
  if (typeof nextConfig === "function") {
    // Next's function form: resolve the user's config for the phase, then wrap it.
    const wrapped = async (phase: Phase, ctx: { defaultConfig: NextConfig }) => apply(await nextConfig(phase, ctx), options);
    return wrapped as unknown as NextConfig & ConfigFn;
  }
  return apply(nextConfig, options) as NextConfig & ConfigFn;
}

/** Resolved build-time facts, exported for tests and the CLI's `doctor`. */
export function resolveSpotterBuild(options: WithSpotterOptions, e: Record<string, string | undefined> = env()) {
  const features = { ...COMPILED_FEATURES } as Record<FeatureName, boolean>;
  for (const [k, v] of Object.entries(options.features ?? {}) as [FeatureName, boolean | undefined][]) {
    if (typeof v === "boolean" && k in features) features[k] = v;
  }
  const dev = e.NODE_ENV !== "production";
  const release: DetectedRelease = detectRelease(e, readPackageVersion(), options.release);
  const environment = release.environment ?? (dev ? "development" : "production");
  const project = options.project ?? e.NEXT_PUBLIC_SPOTTER_PROJECT;
  const secretKey = e[options.secretKeyEnv ?? "SPOTTER_SECRET_KEY"];
  return { features, dev, release, environment, project, secretKey };
}

function apply(config: NextConfig, options: WithSpotterOptions): NextConfig {
  const { features, dev, release, environment, project, secretKey } = resolveSpotterBuild(options);

  const define: Record<string, boolean> = { __SPOTTER_DEV__: dev };
  for (const f of Object.keys(FEATURE_DEFINES) as FeatureName[]) define[FEATURE_DEFINES[f]] = features[f];

  const publicEnv: Record<string, string> = {};
  if (project) publicEnv.NEXT_PUBLIC_SPOTTER_PROJECT = project;
  const name = releaseName(release);
  if (name) publicEnv.NEXT_PUBLIC_SPOTTER_RELEASE = name;
  if (release.commit) publicEnv.NEXT_PUBLIC_SPOTTER_COMMIT = release.commit;
  if (release.deployId) publicEnv.NEXT_PUBLIC_SPOTTER_DEPLOY_ID = release.deployId;
  publicEnv.NEXT_PUBLIC_SPOTTER_ENVIRONMENT = environment;
  const routes = scanAppRoutes();
  if (routes.length > 0) publicEnv.NEXT_PUBLIC_SPOTTER_ROUTES = JSON.stringify(routes);

  if (options.types !== false) {
    const path = builtin<Path>("node:path");
    const file = options.typesPath ?? (path ? path.join(process.cwd(), "spotter-env.d.ts") : "spotter-env.d.ts");
    writeIfChanged(file, generateEnvDts(features, options.types ?? {}));
  }

  const wantUpload = options.sourceMaps?.upload ?? true;
  const upload = wantUpload && !!secretKey && !dev;
  if (wantUpload && !secretKey && dev && !warnedNoKey) {
    warnedNoKey = true;
    console.warn("[spotter] SPOTTER_SECRET_KEY is not set: source maps will not be uploaded at build time.");
  }
  // Maps the user already publishes on purpose stay published.
  const userWantsPublicMaps = config.productionBrowserSourceMaps === true;

  const userCompiler = config.compiler ?? {};
  const userAfter = userCompiler.runAfterProductionCompile;
  const out: NextConfig = {
    ...config,
    env: { ...publicEnv, ...config.env },
    compiler: {
      ...userCompiler,
      define: { ...define, ...userCompiler.define },
      ...(upload
        ? {
            runAfterProductionCompile: async (meta: { projectDir: string; distDir: string }) => {
              if (userAfter) await userAfter(meta);
              await uploadSourceMaps(meta, {
                release,
                name: name ?? `build-${Date.now()}`,
                features,
                endpoint: options.sourceMaps?.endpoint,
                secretKey: secretKey as string,
                remove: !userWantsPublicMaps && (options.sourceMaps?.deleteAfterUpload ?? true),
              });
            },
          }
        : {}),
    },
  };
  if (upload) out.productionBrowserSourceMaps = true;
  return out;
}

async function uploadSourceMaps(
  meta: { projectDir: string; distDir: string },
  o: {
    release: DetectedRelease;
    name: string;
    features: Record<FeatureName, boolean>;
    endpoint?: string;
    secretKey: string;
    remove: boolean;
  },
): Promise<void> {
  const fs = builtin<Fs>("node:fs");
  const path = builtin<Path>("node:path");
  if (!fs || !path) return;
  const staticDir = path.join(meta.distDir, "static");
  const maps: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js.map") || e.name.endsWith(".mjs.map")) maps.push(p);
    }
  };
  walk(staticDir);
  if (maps.length === 0) return;

  // Named by the URL the browser loads the script from, which is what stack frames contain.
  const files = maps.map((p) => ({
    name: "~/_next/static/" + path.relative(staticDir, p).split(path.sep).join("/"),
    content: fs.readFileSync(p),
  }));
  try {
    const { uploadRelease } = await import("../../../core/server/release.ts");
    const res = await uploadRelease({
      endpoint: o.endpoint,
      secretKey: o.secretKey,
      release: {
        version: o.name,
        commit: o.release.commit,
        deployId: o.release.deployId,
        environment: o.release.environment,
        features: (Object.keys(o.features) as FeatureName[]).filter((f) => o.features[f]),
      },
      files,
    });
    console.log(`[spotter] uploaded ${res.uploaded.length} source maps for release ${res.release}`);
    if (res.failed.length > 0) console.warn(`[spotter] ${res.failed.length} source maps failed to upload`);
  } catch (error) {
    // A Spotter outage must never fail the customer's build.
    console.warn(`[spotter] source map upload skipped: ${(error as Error).message}`);
  } finally {
    if (o.remove) for (const p of maps) removeMap(fs, p);
  }
}

/** Delete a map and the `sourceMappingURL` comment pointing at it, so nothing references a 404. */
function removeMap(fs: Fs, mapPath: string): void {
  try {
    fs.rmSync(mapPath, { force: true });
    const js = mapPath.slice(0, -".map".length);
    if (!fs.existsSync(js)) return;
    const src = fs.readFileSync(js, "utf8");
    const stripped = src.replace(/\n?\/\/# sourceMappingURL=[^\n]*\.map\s*$/, "\n");
    if (stripped !== src) fs.writeFileSync(js, stripped);
  } catch {
    /* best effort per file */
  }
}
