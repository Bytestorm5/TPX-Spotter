/**
 * `trusplex spotter doctor`: checks an app's Spotter setup and prints fixes.
 * Every check is a pure function of files on disk (and env), so it's cheap
 * to run in CI too: exit code 1 when something is an error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { keyProblem } from "../core/dev.ts";

export type Level = "ok" | "warn" | "error";
export interface Finding {
  level: Level;
  check: string;
  message: string;
  fix?: string;
}

const HOSTED_ORIGIN = "https://console.trusplex.com";

export function readEnvFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [".env", ".env.production", ".env.local", ".env.production.local"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/gm)) out[m[1]!] = m[2]!.trim();
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /SPOTTER|TURNSTILE/.test(k)) as [string, string][]) };
}

export function findFile(root: string, candidates: string[]): string | undefined {
  return candidates.map((c) => join(root, c)).find((p) => existsSync(p));
}

export const NEXT_CONFIGS = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"];
export const LAYOUTS = ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js"];

/** Parse CSP text into directives. Tolerant: takes every `name value…` segment between semicolons. */
export function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && /-src$|^default-src$/.test(name) && !out.has(name)) out.set(name.toLowerCase(), values);
  }
  return out;
}

/** Pull CSP-looking string literals out of config / middleware source. */
export function extractCsp(source: string): string | null {
  const parts: string[] = [];
  for (const m of source.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*?-src\b(?:(?!\1)[^\\]|\\.)*?)\1/g)) parts.push(m[2]!);
  return parts.length ? parts.join("; ") : null;
}

function allows(values: string[] | undefined, origin: string, self: boolean): boolean {
  if (!values) return true; // directive absent: not restricted by it
  if (values.includes("*")) return true;
  if (self && values.includes("'self'")) return true;
  return values.some((v) => v === origin || v === `${origin}/` || (v.startsWith("https://*.") && origin.endsWith(v.slice("https://*".length))));
}

/** CSP entries Spotter needs, given where the SDK sends data. */
export function checkCsp(policy: string, endpoint: string): Finding[] {
  const d = parseCsp(policy);
  const out: Finding[] = [];
  const firstParty = endpoint.startsWith("/");
  const origin = firstParty ? "'self'" : new URL(endpoint).origin;
  const connect = d.get("connect-src") ?? d.get("default-src");
  if (!allows(connect, origin, firstParty))
    out.push({ level: "error", check: "csp", message: `connect-src blocks Spotter's ingest (${firstParty ? "'self' /api/spotter" : origin}).`, fix: `Add ${firstParty ? "'self'" : origin} to connect-src.` });
  const worker = d.get("worker-src") ?? d.get("child-src") ?? d.get("script-src") ?? d.get("default-src");
  if (worker && !worker.includes("blob:") && !worker.includes("*"))
    out.push({ level: "warn", check: "csp", message: "worker-src doesn't allow blob:, so replay compression runs on the main thread (still works, costs CPU).", fix: "Add blob: to worker-src." });
  const img = d.get("img-src") ?? d.get("default-src");
  if (img && !(img.includes("blob:") && img.includes("data:")))
    out.push({ level: "warn", check: "csp", message: "img-src lacks blob: / data:, which the screenshot preview and annotation canvas use.", fix: "Add blob: data: to img-src." });
  if ((d.get("script-src") ?? []).includes("'unsafe-eval'"))
    out.push({ level: "ok", check: "csp", message: "Spotter needs no 'unsafe-eval' or inline scripts; you can drop them if nothing else needs them." });
  if (!out.some((f) => f.level !== "ok")) out.push({ level: "ok", check: "csp", message: "CSP allows Spotter's ingest, worker and images." });
  return out;
}

function walk(dir: string, filter: (f: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, filter, acc);
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

export function doctor(root: string): Finding[] {
  const f: Finding[] = [];
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [{ level: "error", check: "project", message: `No package.json in ${root}.`, fix: "Run doctor from your app's root." }];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) f.push({ level: "warn", check: "project", message: "This doesn't look like a Next.js app; only core checks apply." });
  if (!deps["@trusplex/spotter"]) f.push({ level: "error", check: "package", message: "@trusplex/spotter is not a dependency.", fix: "npx trusplex spotter init" });
  else f.push({ level: "ok", check: "package", message: `@trusplex/spotter ${deps["@trusplex/spotter"]}` });

  // keys
  const env = readEnvFiles(root);
  const pk = env.NEXT_PUBLIC_SPOTTER_PROJECT;
  const sk = env.SPOTTER_SECRET_KEY;
  const pkIssue = keyProblem(pk, "public");
  if (!pk) f.push({ level: "warn", check: "keys", message: "NEXT_PUBLIC_SPOTTER_PROJECT is not set: reports stay in your own handler (self-hosted).", fix: "Add NEXT_PUBLIC_SPOTTER_PROJECT=pk_live_… to .env.local to use Trusplex." });
  else if (pkIssue || /REPLACE|xxx/i.test(pk)) f.push({ level: "error", check: "keys", message: pkIssue ?? "NEXT_PUBLIC_SPOTTER_PROJECT is still the placeholder.", fix: "Copy the project key from Console → Spotter → Settings." });
  else f.push({ level: "ok", check: "keys", message: `Project key ${pk.slice(0, 12)}…` });
  for (const [k, v] of Object.entries(env))
    if (k.startsWith("NEXT_PUBLIC_") && v.startsWith("sk_"))
      f.push({ level: "error", check: "keys", message: `${k} holds a secret key; NEXT_PUBLIC_ vars ship to every browser.`, fix: "Rotate the key in Console and keep it in SPOTTER_SECRET_KEY only." });
  if (sk) {
    const skIssue = keyProblem(sk, "secret");
    f.push(skIssue || /REPLACE|xxx/i.test(sk) ? { level: "error", check: "keys", message: skIssue ?? "SPOTTER_SECRET_KEY is still the placeholder." } : { level: "ok", check: "keys", message: "Secret key set (server only)." });
  } else if (pk) f.push({ level: "warn", check: "keys", message: "SPOTTER_SECRET_KEY is not set: the route can't forward to Trusplex or upload source maps.", fix: "Add SPOTTER_SECRET_KEY=sk_live_… (server env, never NEXT_PUBLIC_)." });

  // next.config
  const configFile = findFile(root, NEXT_CONFIGS);
  const config = configFile ? readFileSync(configFile, "utf8") : "";
  if (!configFile) f.push({ level: deps.next ? "error" : "warn", check: "config", message: "No next.config found.", fix: "npx trusplex spotter init" });
  else if (!/withSpotter\s*\(/.test(config))
    f.push({ level: "error", check: "config", message: `${relative(root, configFile)} isn't wrapped with withSpotter(): features aren't compiled in or out, and source maps aren't uploaded.`, fix: "export default withSpotter(nextConfig, { features: { … } })" });
  else f.push({ level: "ok", check: "config", message: `${relative(root, configFile)} uses withSpotter().` });
  if (/productionBrowserSourceMaps\s*:\s*true/.test(config))
    f.push({ level: "warn", check: "sourcemaps", message: "productionBrowserSourceMaps: true serves your source maps publicly.", fix: "Remove it: withSpotter() generates maps, uploads them privately and deletes them from the output." });

  // layout
  const layout = findFile(root, LAYOUTS);
  if (layout) {
    const src = readFileSync(layout, "utf8");
    if (!/SpotterProvider/.test(src)) f.push({ level: "error", check: "layout", message: `${relative(root, layout)} has no <SpotterProvider>.`, fix: "Wrap {children} in <SpotterProvider> and add <Spotter />." });
    else if (!/<Spotter\b/.test(src)) f.push({ level: "warn", check: "layout", message: "<SpotterProvider> without <Spotter />: headless mode (no trigger). Fine if intended." });
    else f.push({ level: "ok", check: "layout", message: "Provider and trigger are mounted." });
  }

  // route handler
  const routes = walk(join(root, "app/api/spotter"), (p) => /route\.(ts|js|tsx|jsx|mjs)$/.test(p)).concat(walk(join(root, "src/app/api/spotter"), (p) => /route\.(ts|js|tsx|jsx|mjs)$/.test(p)));
  const route = routes.find((r) => /createSpotterHandler|createIngestHandler/.test(readFileSync(r, "utf8")));
  const endpoint = env.NEXT_PUBLIC_SPOTTER_ENDPOINT ?? "/api/spotter";
  if (!route && endpoint.startsWith("/"))
    f.push({ level: "error", check: "route", message: "No /api/spotter route handler: the browser SDK posts there by default.", fix: "Create app/api/spotter/[[...spotter]]/route.ts exporting createSpotterHandler()." });
  else if (route && !/\[\[?\.\.\.[^\]]+\]\]?/.test(route))
    f.push({ level: "error", check: "route", message: `${relative(root, route)} isn't a catch-all route, so /api/spotter/v1/* requests 404.`, fix: "Move it to app/api/spotter/[[...spotter]]/route.ts." });
  else if (route) f.push({ level: "ok", check: "route", message: `${relative(root, route)}` });

  // CSP
  const middleware = findFile(root, ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"]);
  const policy = [config, middleware ? readFileSync(middleware, "utf8") : ""].map(extractCsp).filter(Boolean).join("; ");
  if (policy) f.push(...checkCsp(policy, endpoint.startsWith("/") ? endpoint : endpoint));
  else f.push({ level: "ok", check: "csp", message: "No Content-Security-Policy found in next.config or middleware (nothing to check)." });

  // build output: bundle impact and public maps
  const chunks = join(root, ".next/static/chunks");
  if (existsSync(chunks)) {
    const files = walk(chunks, (p) => p.endsWith(".js"));
    const spotterFiles = files.filter((p) => /__trusplexSpotter|spotter:sid|data-spotter-ui/.test(readFileSync(p, "utf8")));
    let initial = new Set<string>();
    try {
      const manifest = JSON.parse(readFileSync(join(root, ".next/build-manifest.json"), "utf8")) as { rootMainFiles?: string[]; polyfillFiles?: string[] };
      const app = existsSync(join(root, ".next/app-build-manifest.json"))
        ? (JSON.parse(readFileSync(join(root, ".next/app-build-manifest.json"), "utf8")) as { pages?: Record<string, string[]> })
        : {};
      initial = new Set([...(manifest.rootMainFiles ?? []), ...(app.pages?.["/layout"] ?? []), ...(app.pages?.["app/layout"] ?? [])].map((p) => join(root, ".next", p)));
    } catch {
      /* older / newer manifest shape: report totals only */
    }
    const gz = (p: string) => gzipSync(readFileSync(p)).byteLength;
    const initialBytes = spotterFiles.filter((p) => initial.has(p)).reduce((n, p) => n + gz(p), 0);
    const totalBytes = spotterFiles.reduce((n, p) => n + gz(p), 0);
    f.push({
      level: initialBytes > 6 * 1024 ? "warn" : "ok",
      check: "bundle",
      message: `${spotterFiles.length} chunk(s) contain Spotter: ${(totalBytes / 1024).toFixed(1)} KB gzip in total${initial.size ? `, ${(initialBytes / 1024).toFixed(1)} KB of it in initial JS (budget 6 KB)` : ""}.`,
      ...(initialBytes > 6 * 1024 ? { fix: "Import `spotter` from @trusplex/spotter/core only in client code that needs it; let <Spotter/> load core lazily." } : {}),
    });
    const maps = walk(join(root, ".next/static"), (p) => p.endsWith(".js.map"));
    if (maps.length) f.push({ level: "warn", check: "sourcemaps", message: `${maps.length} source map(s) in .next/static are publicly served.`, fix: "Let withSpotter() upload and delete them (sourceMaps.deleteAfterUpload, default true) — check SPOTTER_SECRET_KEY is set at build time." });
    else if (configFile && /withSpotter/.test(config)) f.push({ level: "ok", check: "sourcemaps", message: "No public source maps in the build output." });
  } else f.push({ level: "ok", check: "bundle", message: "No .next build found; run `next build` to check bundle impact and source maps." });

  return f;
}

export function printFindings(findings: Finding[], log: (s: string) => void = console.log): number {
  const icon: Record<Level, string> = { ok: "✓", warn: "!", error: "✗" };
  for (const x of findings) {
    log(`${icon[x.level]} ${x.check.padEnd(11)} ${x.message}`);
    if (x.fix && x.level !== "ok") log(`  ${"".padEnd(11)} → ${x.fix}`);
  }
  const errors = findings.filter((x) => x.level === "error").length;
  const warns = findings.filter((x) => x.level === "warn").length;
  log(`\n${errors} error(s), ${warns} warning(s).`);
  return errors ? 1 : 0;
}

export { HOSTED_ORIGIN };
