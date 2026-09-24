/**
 * `trusplex spotter init`: install the package, wrap next.config with
 * withSpotter(), mount the provider in the root layout, create the
 * /api/spotter route handler and write env placeholders. Idempotent — safe
 * to run again — and every step that can't be done safely prints the manual
 * edit instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findFile, LAYOUTS, NEXT_CONFIGS } from "./doctor.ts";
import { addEnv, addProviderToLayout, newNextConfig, ROUTE_FILE, wrapNextConfig } from "./transforms.ts";

export interface InitOptions {
  root: string;
  install?: boolean;
  project?: string;
  secretKey?: string;
  log?: (line: string) => void;
  /** Injectable for tests. */
  run?: (cmd: string, args: string[], cwd: string) => number;
}

export function detectPackageManager(root: string): "pnpm" | "yarn" | "bun" | "npm" {
  for (let dir = root, i = 0; i < 6; i++, dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
    if (dirname(dir) === dir) break;
  }
  return "npm";
}

const defaultRun = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;

export function init(options: InitOptions): number {
  const { root } = options;
  const log = options.log ?? console.log;
  const run = options.run ?? defaultRun;
  const rel = (p: string) => relative(root, p) || p;
  const manual: string[] = [];

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    log(`✗ No package.json in ${root}. Run this from your Next.js app's root.`);
    return 1;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) {
    log("✗ This doesn't look like a Next.js app (no `next` dependency). Spotter's installer targets Next.js; use @trusplex/spotter/core directly elsewhere.");
    return 1;
  }

  // 1. install
  if (deps["@trusplex/spotter"]) log("✓ @trusplex/spotter is already a dependency");
  else if (options.install === false) manual.push("Install the package: npm install @trusplex/spotter");
  else {
    const pm = detectPackageManager(root);
    const args = pm === "npm" ? ["install", "@trusplex/spotter"] : ["add", "@trusplex/spotter"];
    log(`→ ${pm} ${args.join(" ")}`);
    if (run(pm, args, root) !== 0) manual.push(`Install the package: ${pm} ${args.join(" ")} (the install failed)`);
    else log("✓ Installed @trusplex/spotter");
  }

  // 2. next.config
  const configFile = findFile(root, NEXT_CONFIGS);
  if (!configFile) {
    writeFileSync(join(root, "next.config.ts"), newNextConfig());
    log("✓ Created next.config.ts with withSpotter()");
  } else {
    const src = readFileSync(configFile, "utf8");
    const cjs = /\.cjs$/.test(configFile) || (/\.js$/.test(configFile) && /module\.exports\s*=/.test(src) && !/^export\s/m.test(src));
    const edit = wrapNextConfig(src, cjs ? "cjs" : "esm");
    if (!edit) manual.push(`Wrap the export in ${rel(configFile)}: export default withSpotter(nextConfig, { features: { … } }) — import { withSpotter } from "@trusplex/spotter/ui/next"`);
    else if (!edit.changed) log(`✓ ${rel(configFile)} already uses withSpotter()`);
    else {
      writeFileSync(configFile, edit.code);
      log(`✓ Wrapped ${rel(configFile)} with withSpotter()`);
    }
  }

  // 3. layout
  const layout = findFile(root, LAYOUTS);
  if (!layout) manual.push("Add <SpotterProvider>{children}<Spotter /></SpotterProvider> to your root layout (no app/layout found).");
  else {
    const edit = addProviderToLayout(readFileSync(layout, "utf8"));
    if (!edit) manual.push(`In ${rel(layout)}: import { SpotterProvider, Spotter } from "@trusplex/spotter/ui/next" and wrap {children} in <SpotterProvider>…<Spotter /></SpotterProvider> inside <body>.`);
    else if (!edit.changed) log(`✓ ${rel(layout)} already has <SpotterProvider>`);
    else {
      writeFileSync(layout, edit.code);
      log(`✓ Added <SpotterProvider> and <Spotter /> to ${rel(layout)}`);
    }
  }

  // 4. route handler (optional catch-all: the protocol has sub-paths)
  const appDir = existsSync(join(root, "src/app")) && !existsSync(join(root, "app")) ? "src/app" : "app";
  const routeDir = join(root, appDir, "api/spotter/[[...spotter]]");
  const routeFile = join(routeDir, existsSync(join(root, "tsconfig.json")) ? "route.ts" : "route.js");
  const legacy = join(root, appDir, "api/spotter/route.ts");
  if (existsSync(routeFile)) log(`✓ ${rel(routeFile)} exists`);
  else {
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(routeFile, ROUTE_FILE);
    log(`✓ Created ${rel(routeFile)}`);
    if (existsSync(legacy)) manual.push(`Remove ${rel(legacy)}: a non-catch-all route shadows /api/spotter and 404s the /v1/* sub-paths.`);
  }

  // 5. env
  const envFile = join(root, ".env.local");
  const envEdit = addEnv(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", {
    NEXT_PUBLIC_SPOTTER_PROJECT: options.project ?? "pk_live_REPLACE_ME",
    SPOTTER_SECRET_KEY: options.secretKey ?? "sk_live_REPLACE_ME",
  });
  if (envEdit.changed) {
    writeFileSync(envFile, envEdit.code);
    log(`✓ Wrote Spotter keys to .env.local${options.project ? "" : " (placeholders — paste your keys from Console)"}`);
  } else log("✓ .env.local already has Spotter keys");

  if (manual.length) {
    log("\nFinish by hand:");
    for (const m of manual) log(`  • ${m}`);
  }
  log("\nNext: run `npx trusplex spotter doctor` to check the setup.");
  return 0;
}
