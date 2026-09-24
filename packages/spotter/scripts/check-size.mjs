#!/usr/bin/env node
/**
 * Performance budgets (release-blocking, run in CI):
 *
 *   loader  < 6 KB gzip — what a Next app adds to its initial JS: the
 *           `ui/next` trigger shell (`src/ui/next/loader-entry.ts` when the
 *           UI provides one) or, without it, the core client facade that
 *           `import { spotter } from "@trusplex/spotter/core"` pulls in.
 *   core    < 15 KB gzip — everything loaded once Spotter has initialized:
 *           the core client (`src/core/singleton.ts`, the `spotter` the UI
 *           loads on idle) plus the engine chunk it loads on idle (capture
 *           signals). Feature chunks — analytics, replay, screenshot,
 *           recording — and the session chunk (transport, report pipeline,
 *           flags; loaded on first interaction) are listed but not counted.
 *
 * Production defines (dev warnings compiled out), minified, ESM with
 * splitting — the way a bundler ships it. React / Next are the app's, so
 * they're external. Sizes are per-chunk gzip (level 9), summed.
 */
import { build } from "esbuild";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => join(pkg, "src", p);
const BUDGET = { loader: 6 * 1024, core: 15 * 1024 };

/** Chunks that load at init (idle), counted in the core budget. */
const INIT_CHUNKS = ["src/core/engine.ts"];

export const PRODUCTION_DEFINE = {
  __SPOTTER_DEV__: "false",
  "process.env.NODE_ENV": '"production"',
};

export async function bundle(entryContents, { define = {}, name = "entry" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spotter-size-"));
  const entry = join(pkg, `.size-${name}-${process.pid}.ts`);
  writeFileSync(entry, entryContents);
  try {
    const result = await build({
      entryPoints: { [name]: entry },
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      treeShaking: true,
      write: false,
      metafile: true,
      outdir: dir,
      define: { ...PRODUCTION_DEFINE, ...define },
      external: ["react", "react-dom", "react/jsx-runtime", "next", "next/*", "node:*"],
      jsx: "automatic",
      logLevel: "silent",
      absWorkingDir: pkg,
      legalComments: "none",
    });
    // metafile paths are relative to absWorkingDir; key everything by absolute path
    const files = new Map(result.outputFiles.map((f) => [f.path, f.contents]));
    const outputs = {};
    for (const [out, meta] of Object.entries(result.metafile.outputs)) {
      const abs = resolve(pkg, out);
      outputs[abs] = {
        ...meta,
        imports: meta.imports.map((i) => ({ ...i, path: i.external ? i.path : resolve(pkg, i.path) })),
        contents: files.get(abs) ?? new Uint8Array(),
      };
    }
    const entryOutput = Object.keys(outputs).find((k) => outputs[k].entryPoint && resolve(pkg, outputs[k].entryPoint) === entry);
    return { outputs, entryOutput };
  } finally {
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The output plus everything it statically imports, transitively. */
export function staticClosure(outputs, start) {
  const seen = new Set();
  const walk = (k) => {
    if (!k || seen.has(k) || !outputs[k]) return;
    seen.add(k);
    for (const imp of outputs[k].imports) if (imp.kind === "import-statement" && !imp.external) walk(imp.path);
  };
  walk(start);
  return seen;
}

function gz(buf) {
  return gzipSync(buf, { level: 9 }).byteLength;
}

function chunkFor(outputs, srcPath) {
  return Object.keys(outputs).find((k) => outputs[k].entryPoint && resolve(pkg, outputs[k].entryPoint) === resolve(pkg, srcPath));
}

const kb = (n) => `${(n / 1024).toFixed(2)} KB`;

export async function measure() {
  const uiLoader = src("ui/next/loader-entry.ts");
  const coreEntry = `import { spotter } from "./src/core/singleton.ts";\nspotter.init({ project: "pk_live_sizecheck1" });\n(globalThis as any).__s = spotter;\n`;
  // Keep every export alive: an entry that only re-exports would tree-shake to nothing.
  const loaderEntry = existsSync(uiLoader)
    ? `import * as loader from "./src/ui/next/loader-entry.ts";\n(globalThis as any).__spotterLoader = loader;\n`
    : coreEntry;

  const loader = await bundle(loaderEntry, { name: "loader" });
  const loaderSet = staticClosure(loader.outputs, loader.entryOutput);
  const loaderBytes = [...loaderSet].reduce((n, k) => n + gz(loader.outputs[k].contents), 0);

  const core = await bundle(coreEntry, { name: "core" });
  const coreSet = staticClosure(core.outputs, core.entryOutput);
  for (const c of INIT_CHUNKS) {
    const out = chunkFor(core.outputs, c);
    if (out) for (const k of staticClosure(core.outputs, out)) coreSet.add(k);
  }
  const coreBytes = [...coreSet].reduce((n, k) => n + gz(core.outputs[k].contents), 0);

  const lazy = Object.entries(core.outputs)
    .filter(([k]) => k.endsWith(".js") && !coreSet.has(k))
    .map(([k, o]) => ({ chunk: k, from: o.entryPoint ?? "(shared chunk)", gzip: gz(o.contents) }));

  return {
    loader: { bytes: loaderBytes, source: existsSync(uiLoader) ? "src/ui/next/loader-entry.ts" : "core client facade (no ui loader-entry yet)", chunks: [...loaderSet] },
    core: { bytes: coreBytes, chunks: [...coreSet].map((k) => ({ chunk: k, from: core.outputs[k].entryPoint ?? "(shared chunk)", gzip: gz(core.outputs[k].contents) })) },
    lazy,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await measure();
  const rows = [
    ["loader (initial JS)", m.loader.bytes, BUDGET.loader, m.loader.source],
    ["core once initialized", m.core.bytes, BUDGET.core, `${m.core.chunks.length} chunks`],
  ];
  console.log("\nSpotter bundle budgets (minified + gzip)\n");
  console.log(`${"budget".padEnd(24)}${"size".padStart(10)}${"limit".padStart(10)}  status  notes`);
  let failed = false;
  for (const [name, size, limit, note] of rows) {
    const ok = size < limit;
    failed ||= !ok;
    console.log(`${name.padEnd(24)}${kb(size).padStart(10)}${kb(limit).padStart(10)}  ${ok ? "ok    " : "OVER  "}  ${note}`);
  }
  console.log("\ncore chunks:");
  for (const c of m.core.chunks) console.log(`  ${kb(c.gzip).padStart(9)}  ${c.from}`);
  console.log("\nlazy chunks (not counted):");
  for (const c of m.lazy.sort((a, b) => b.gzip - a.gzip)) console.log(`  ${kb(c.gzip).padStart(9)}  ${c.from}`);
  if (failed) {
    console.error("\nBudget exceeded.");
    process.exit(1);
  }
  console.log("\nAll budgets met.");
}
