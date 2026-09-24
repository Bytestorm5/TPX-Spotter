#!/usr/bin/env node
/**
 * Build @trusplex/spotter:
 *
 * 1. `tsc -p tsconfig.build.json` → dist/ (ESM, .d.ts, maps). Files are
 *    emitted 1:1, so `"use client"` directives in src/ui/next survive; this
 *    script verifies it (a lost directive breaks RSC).
 * 2. dist/cli/index.js gets its shebang checked and is made executable.
 * 3. CDN builds with esbuild: dist/cdn/spotter.min.js (IIFE, `window.Spotter`,
 *    everything inlined) and dist/cdn/esm/ (ESM with lazy chunks), plus
 *    dist/cdn/sri.json with a sha384 Subresource Integrity hash per file.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const walk = (dir) =>
  existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)])) : [];

rmSync(dist, { recursive: true, force: true });

// 1. TypeScript
const tsc = join(pkg, "node_modules/.bin/tsc");
const res = spawnSync(existsSync(tsc) ? tsc : "tsc", ["-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
if (res.status !== 0) fail("tsc failed");
console.log("✓ tsc → dist/");

// "use client" must survive in every emitted file whose source starts with it
let directives = 0;
for (const src of walk(join(pkg, "src/ui"))) {
  if (!/\.(ts|tsx)$/.test(src) || /\.d\.ts$/.test(src)) continue;
  const text = readFileSync(src, "utf8");
  const directive = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*["'](use client|use server)["']/.exec(text)?.[1];
  if (!directive) continue;
  const out = join(dist, relative(join(pkg, "src"), src)).replace(/\.tsx?$/, ".js");
  if (!existsSync(out)) fail(`${relative(pkg, out)} missing`);
  const head = readFileSync(out, "utf8").trimStart();
  if (!head.startsWith(`"${directive}"`) && !head.startsWith(`'${directive}'`)) fail(`"${directive}" was lost in ${relative(pkg, out)}`);
  directives++;
}
console.log(`✓ ${directives} "use client"/"use server" directive(s) preserved`);

// 2. CLI
const cli = join(dist, "cli/index.js");
if (!existsSync(cli)) fail("dist/cli/index.js missing");
if (!readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")) fail("dist/cli/index.js lost its shebang");
chmodSync(cli, 0o755);
console.log("✓ dist/cli/index.js is executable");

// 3. CDN
const common = {
  bundle: true,
  minify: true,
  target: "es2020",
  platform: "browser",
  legalComments: "none",
  logLevel: "warning",
  define: { __SPOTTER_DEV__: "false", "process.env.NODE_ENV": '"production"' },
  absWorkingDir: pkg,
};
await build({ ...common, entryPoints: ["scripts/cdn-entry.ts"], format: "iife", globalName: "Spotter", outfile: "dist/cdn/spotter.min.js" });
await build({
  ...common,
  entryPoints: { spotter: "scripts/cdn-entry.ts" },
  format: "esm",
  splitting: true,
  outdir: "dist/cdn/esm",
  chunkNames: "chunks/[name]-[hash]",
});
const sri = {};
for (const file of walk(join(dist, "cdn")).filter((f) => f.endsWith(".js")).sort()) {
  sri[relative(join(dist, "cdn"), file)] = `sha384-${createHash("sha384").update(readFileSync(file)).digest("base64")}`;
}
writeFileSync(join(dist, "cdn/sri.json"), `${JSON.stringify(sri, null, 2)}\n`);
console.log(`✓ CDN: spotter.min.js (${(statSync(join(dist, "cdn/spotter.min.js")).size / 1024).toFixed(1)} KB), esm/ (${Object.keys(sri).length - 1} files), sri.json`);
