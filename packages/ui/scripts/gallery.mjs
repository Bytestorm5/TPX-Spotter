#!/usr/bin/env node
/** Build the component gallery: gallery/dist/index.html (self-contained). */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkg, "gallery/dist");
mkdirSync(out, { recursive: true });
const result = await build({
  entryPoints: [join(pkg, "gallery/gallery.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = readFileSync(join(pkg, "src/styles.css"), "utf8");
const js = result.outputFiles[0].text.replace(/<\/script/g, "<\\/script");
writeFileSync(
  join(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>@trusplex/ui gallery</title><style>body{margin:0}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`,
);
console.log(`✓ ${join(out, "index.html")}`);
