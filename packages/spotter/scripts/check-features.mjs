#!/usr/bin/env node
/**
 * Feature stripping (release-blocking, run in CI): "a build with
 * `replay: false` contains no replay code".
 *
 * For each feature, esbuild bundles an entry that imports and keeps alive
 * the whole public API (`core` and `ui/next`), with the bundler defines a
 * `withSpotter()` build sets — that feature `false`, the others `true` — and
 * asserts that none of the feature's marker strings appear in ANY output
 * file, lazy chunks included (an emitted-but-never-loaded chunk still ships).
 *
 * Markers are found automatically, so they can't go stale: string literals
 * (≥ 10 chars) from the feature's own modules that survive into the all-on
 * build and are absent from a build with every feature off. A feature with
 * no surviving markers fails the check — it would prove nothing.
 */
import { build } from "esbuild";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURES = ["widget", "screenshot", "annotate", "replay", "analytics", "flags", "recording"];
const DEFINE_KEY = (f) => `__SPOTTER_${f.toUpperCase()}__`;
/** `--core-only`: skip `ui/next` (and the UI-only features) — useful while the UI is being worked on. */
const CORE_ONLY = process.argv.includes("--core-only");

/** Each feature's own modules (files or directories under src/). */
const FEATURE_SOURCES = {
  replay: ["core/replay"],
  screenshot: ["core/screenshot"],
  analytics: ["core/analytics"],
  recording: ["core/recording"],
  flags: ["core/flags.ts"],
  annotate: ["ui/next/annotate"],
  widget: ["ui/next/panel", "ui/next/widget"],
};

function files(p) {
  const abs = join(pkg, "src", p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { recursive: true })
    .map((f) => join(abs, String(f)))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
}

/** String literals worth using as markers: long, not generic. */
function literals(file) {
  const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  const out = new Set();
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.){10,})"|'((?:[^'\\\n]|\\.){10,})'/g)) {
    const s = m[1] ?? m[2];
    if (/^[./@]/.test(s) || /\\/.test(s) || /^(?:[a-z-]+\/)?[a-z0-9-]+$/i.test(s) && s.length < 14) continue;
    out.add(s);
  }
  // static parts of template literals
  for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`/g))
    for (const part of m[1].split(/\$\{[^}]*\}/)) if (part.length >= 10 && !/\\/.test(part) && !/^\s*$/.test(part)) out.add(part);
  return out;
}

async function bundleAll(defines) {
  const dir = mkdtempSync(join(tmpdir(), "spotter-features-"));
  const entry = join(pkg, `.features-entry-${process.pid}.ts`);
  const uiIndex = CORE_ONLY ? undefined : ["src/ui/next/index.ts", "src/ui/next/index.tsx"].find((f) => existsSync(join(pkg, f)));
  writeFileSync(
    entry,
    [
      `import * as core from "./src/core/index.ts";`,
      uiIndex ? `import * as ui from "./${uiIndex}";` : `const ui = {};`,
      `core.spotter.init({ project: "pk_live_featurecheck" });`,
      `(globalThis as any).__spotterApi = { core, ui };`,
    ].join("\n"),
  );
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      write: false,
      outdir: dir,
      absWorkingDir: pkg,
      define: { __SPOTTER_DEV__: "false", "process.env.NODE_ENV": '"production"', ...defines },
      external: ["react", "react-dom", "react/jsx-runtime", "next", "next/*", "node:*"],
      jsx: "automatic",
      logLevel: "silent",
      legalComments: "none",
    });
    return result.outputFiles.map((f) => ({ path: f.path.slice(dir.length + 1), text: f.text }));
  } finally {
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const definesFor = (off) => Object.fromEntries(FEATURES.map((f) => [DEFINE_KEY(f), off.includes(f) ? "false" : "true"]));
const contains = (outputs, s) => outputs.filter((o) => o.text.includes(s)).map((o) => o.path);

/** Literals used anywhere outside a feature's own modules can't prove anything about it. */
const allSources = files("core").concat(files("ui"));
function literalsOutside(own) {
  const mine = new Set(own);
  const out = new Set();
  for (const f of allSources) if (!mine.has(f)) for (const l of literals(f)) out.add(l);
  return out;
}

const allOn = await bundleAll(definesFor([]));
const allOff = await bundleAll(definesFor(FEATURES));
let failed = false;
const rows = [];

for (const feature of FEATURES) {
  const sources = FEATURE_SOURCES[feature].flatMap(files);
  if (CORE_ONLY && FEATURE_SOURCES[feature].every((p) => p.startsWith("ui/"))) {
    rows.push([feature, "SKIP", "--core-only"]);
    continue;
  }
  if (!sources.length) {
    rows.push([feature, "SKIP", `no modules at ${FEATURE_SOURCES[feature].join(", ")}`]);
    continue;
  }
  const elsewhere = literalsOutside(sources);
  const candidates = new Set(sources.flatMap((f) => [...literals(f)]).filter((l) => !elsewhere.has(l)));
  const surviving = [...candidates].filter((s) => contains(allOn, s).length > 0);
  const markers = surviving.filter((s) => contains(allOff, s).length === 0);
  if (!markers.length) {
    failed = true;
    rows.push([
      feature,
      "FAIL",
      surviving.length
        ? `all ${surviving.length} marker strings also ship with every feature off — e.g. ${JSON.stringify(surviving[0].slice(0, 40))} in ${contains(allOff, surviving[0])[0]}`
        : `none of ${candidates.size} string literals survive into the all-on build (can't prove removal)`,
    ]);
    continue;
  }
  const off = await bundleAll(definesFor([feature]));
  const leaks = markers.flatMap((m) => contains(off, m).map((file) => `${JSON.stringify(m.slice(0, 40))} in ${file}`));
  if (leaks.length) {
    failed = true;
    rows.push([feature, "FAIL", `${leaks.length} marker(s) present with ${feature}: false — ${leaks.slice(0, 3).join("; ")}`]);
  } else {
    rows.push([feature, "ok", `${markers.length} markers present when on, absent when off (${off.length} output files)`]);
  }
}

console.log("\nSpotter feature stripping (esbuild, withSpotter defines)\n");
for (const [f, status, note] of rows) console.log(`${f.padEnd(12)}${status.padEnd(6)}${note}`);
if (failed) {
  console.error("\nFeature check failed: disabled features must not ship any code.");
  process.exit(1);
}
console.log("\nAll disabled features are compiled out.");
