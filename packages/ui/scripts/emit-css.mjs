#!/usr/bin/env node
/**
 * src/styles.css → src/css.ts: the stylesheet as a (lightly minified) string,
 * for hosts that can't import a .css file — a shadow root's constructed
 * stylesheet, most of all (the Spotter widget). `pnpm build` runs this;
 * test/styles.test.ts fails when css.ts is out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

export function minify(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

export function emit() {
  const css = minify(readFileSync(join(pkg, "src/styles.css"), "utf8"));
  return `// Generated from styles.css by scripts/emit-css.mjs — do not edit.\n/** The kit's stylesheet as a string (for a shadow root's constructed stylesheet). */\nexport const KIT_CSS = ${JSON.stringify(css)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(pkg, "src/css.ts"), emit());
  console.log("✓ src/css.ts");
}
