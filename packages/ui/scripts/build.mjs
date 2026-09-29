#!/usr/bin/env node
/**
 * Build @trusplex/ui:
 *
 * 1. `tsc -p tsconfig.build.json` → dist/ (ESM, .d.ts, maps), emitted 1:1 so
 *    each component's `"use client"` survives; this script verifies it (a
 *    lost directive breaks React Server Components).
 * 2. src/styles.css → dist/styles.css, unchanged: the stylesheet is the
 *    kit's other public API (`@trusplex/ui/styles.css`).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
    : [];

rmSync(dist, { recursive: true, force: true });

const tsc = join(pkg, "node_modules/typescript/bin/tsc");
const res = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
if (res.status !== 0) fail("tsc failed");
console.log("✓ tsc → dist/");

let directives = 0;
for (const src of walk(join(pkg, "src"))) {
  if (!/\.tsx?$/.test(src) || /\.d\.ts$/.test(src)) continue;
  if (!/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*["']use client["']/.test(readFileSync(src, "utf8"))) continue;
  const out = join(dist, relative(join(pkg, "src"), src)).replace(/\.tsx?$/, ".js");
  if (!existsSync(out)) fail(`${relative(pkg, out)} missing`);
  const head = readFileSync(out, "utf8").trimStart();
  if (!head.startsWith('"use client"') && !head.startsWith("'use client'"))
    fail(`"use client" was lost in ${relative(pkg, out)}`);
  directives++;
}
console.log(`✓ ${directives} "use client" directive(s) preserved`);

copyFileSync(join(pkg, "src/styles.css"), join(dist, "styles.css"));
console.log("✓ styles.css → dist/");
