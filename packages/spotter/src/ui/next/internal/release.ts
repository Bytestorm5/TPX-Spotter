/**
 * Release auto-detection at build time. Pure over an env object so it is
 * testable and safe to import anywhere (no `node:` imports).
 *
 * Precedence: explicit options > Console-managed deploy (TPX_*) > hosting
 * provider > `package.json` version (read by the caller).
 */

export interface DetectedRelease {
  version?: string;
  commit?: string;
  deployId?: string;
  environment?: string;
  /** Which source filled the values, for the dev log line. */
  provider?: "trusplex" | "vercel" | "netlify" | "cloudflare-pages" | "package" | "explicit";
}

type Env = Record<string, string | undefined>;

export function detectRelease(env: Env, packageVersion?: string, explicit?: Partial<DetectedRelease>): DetectedRelease {
  const out: DetectedRelease = {};
  if (env.TPX_DEPLOY_ID || env.TPX_COMMIT) {
    out.provider = "trusplex";
    out.commit = env.TPX_COMMIT;
    out.deployId = env.TPX_DEPLOY_ID;
    out.environment = env.TPX_ENVIRONMENT;
  } else if (env.VERCEL || env.VERCEL_GIT_COMMIT_SHA || env.VERCEL_DEPLOYMENT_ID) {
    out.provider = "vercel";
    out.commit = env.VERCEL_GIT_COMMIT_SHA;
    out.deployId = env.VERCEL_DEPLOYMENT_ID;
    out.environment = env.VERCEL_ENV; // production | preview | development
  } else if (env.NETLIFY || env.COMMIT_REF || env.DEPLOY_ID) {
    out.provider = "netlify";
    out.commit = env.COMMIT_REF;
    out.deployId = env.DEPLOY_ID;
    // Netlify CONTEXT: production | deploy-preview | branch-deploy | dev
    const ctx = env.CONTEXT;
    out.environment = ctx === "deploy-preview" ? "preview" : ctx === "branch-deploy" ? "staging" : ctx === "dev" ? "development" : ctx;
  } else if (env.CF_PAGES || env.CF_PAGES_COMMIT_SHA) {
    out.provider = "cloudflare-pages";
    out.commit = env.CF_PAGES_COMMIT_SHA;
    const branch = env.CF_PAGES_BRANCH;
    out.environment = branch ? (branch === "main" || branch === "master" ? "production" : "preview") : undefined;
    // Pages has no deployment id env var at build time; the URL is per-deploy.
    out.deployId = env.CF_PAGES_URL ? new URL(env.CF_PAGES_URL).hostname.split(".")[0] : undefined;
  }
  // A short SHA is the most useful version when no package version exists.
  out.version = packageVersion ?? (out.commit ? out.commit.slice(0, 12) : undefined);
  if (!out.provider && packageVersion) out.provider = "package";
  if (explicit) {
    for (const [k, v] of Object.entries(explicit)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    if (explicit.version || explicit.commit) out.provider = "explicit";
  }
  for (const k of Object.keys(out) as (keyof DetectedRelease)[]) if (out[k] === undefined || out[k] === "") delete out[k];
  return out;
}

/** The release name used for source map uploads: version, suffixed with the short commit when both exist. */
export function releaseName(r: DetectedRelease): string | undefined {
  if (r.version && r.commit && !r.version.includes(r.commit.slice(0, 7))) return `${r.version}+${r.commit.slice(0, 7)}`;
  return r.version ?? r.commit;
}
