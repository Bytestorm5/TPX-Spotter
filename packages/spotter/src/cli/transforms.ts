/**
 * Source transforms for `trusplex spotter init`: careful string edits, no
 * AST (the CLI has no dependencies). Each one is idempotent and returns
 * `null` when the file doesn't have a shape it can edit safely — the CLI
 * then prints the manual step instead of guessing.
 */

export const IMPORT_PATH = "@trusplex/spotter/ui/next";

export interface ConfigEdit {
  code: string;
  changed: boolean;
}

const SPOTTER_OPTIONS = `{
  project: process.env.NEXT_PUBLIC_SPOTTER_PROJECT,
  features: {
    widget: true,
    screenshot: true,
    annotate: true,
    replay: true,
    analytics: true,
    flags: true,
    recording: false,
  },
}`;

/** Insert after the last top-of-file import / require / directive line. */
function insertImport(code: string, line: string): string {
  const lines = code.split("\n");
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (/^(import\s|["']use (client|server)["']|const .*= require\(|\/\/|\/\*|\*|$)/.test(l)) {
      if (/^(import\s|["']use |const .*= require\()/.test(l)) at = i + 1;
      continue;
    }
    break;
  }
  lines.splice(at, 0, line);
  return lines.join("\n");
}

/**
 * Wrap `next.config.(ts|mjs|js|cjs)` with `withSpotter()`. Works for
 * `export default <expr>` and `module.exports = <expr>` (object, identifier,
 * function — withSpotter accepts Next's function form) by binding the
 * original to `nextConfigBase` and exporting the wrapped value.
 */
export function wrapNextConfig(code: string, kind: "esm" | "cjs"): ConfigEdit | null {
  if (/\bwithSpotter\s*\(/.test(code)) return { code, changed: false };
  if (kind === "esm") {
    const matches = code.match(/^export\s+default\s+/gm) ?? [];
    if (matches.length !== 1) return null;
    // `export default function name()` / class: bind by declaration instead
    const fn = /^export\s+default\s+(async\s+)?function\s*([A-Za-z_$][\w$]*)?\s*\(/m.exec(code);
    let out: string;
    if (fn) {
      const name = fn[2] ?? "nextConfigBase";
      out = code.replace(/^export\s+default\s+(async\s+)?function\s*([A-Za-z_$][\w$]*)?/m, `${fn[1] ?? ""}function ${name}`);
      out = `${out.trimEnd()}\n\nexport default withSpotter(${name}, ${SPOTTER_OPTIONS});\n`;
    } else {
      out = code.replace(/^export\s+default\s+/m, "const nextConfigBase = ");
      out = `${out.trimEnd()}\n\nexport default withSpotter(nextConfigBase, ${SPOTTER_OPTIONS});\n`;
    }
    return { code: insertImport(out, `import { withSpotter } from "${IMPORT_PATH}";`), changed: true };
  }
  const matches = code.match(/^module\.exports\s*=\s*/gm) ?? [];
  if (matches.length !== 1) return null;
  let out = code.replace(/^module\.exports\s*=\s*/m, "const nextConfigBase = ");
  out = `${out.trimEnd()}\n\nmodule.exports = withSpotter(nextConfigBase, ${SPOTTER_OPTIONS});\n`;
  return { code: insertImport(out, `const { withSpotter } = require("${IMPORT_PATH}");`), changed: true };
}

export function newNextConfig(): string {
  return `import type { NextConfig } from "next";
import { withSpotter } from "${IMPORT_PATH}";

const nextConfig: NextConfig = {};

export default withSpotter(nextConfig, ${SPOTTER_OPTIONS});
`;
}

/** Add `<SpotterProvider>` around `{children}` and `<Spotter />` after it in the root layout. */
export function addProviderToLayout(code: string): ConfigEdit | null {
  if (/SpotterProvider/.test(code)) return { code, changed: false };
  const body = /<body\b[^>]*>/.exec(code);
  if (!body) return null;
  const after = code.slice(body.index + body[0].length);
  const child = /\{\s*children\s*\}/.exec(after);
  if (!child) return null;
  const start = body.index + body[0].length + child.index;
  const indent = /\n([ \t]*)[^\n]*$/.exec(code.slice(0, start))?.[1] ?? "        ";
  const wrapped = `<SpotterProvider>\n${indent}  {children}\n${indent}  <Spotter />\n${indent}</SpotterProvider>`;
  const out = code.slice(0, start) + wrapped + code.slice(start + child[0].length);
  return { code: insertImport(out, `import { SpotterProvider, Spotter } from "${IMPORT_PATH}";`), changed: true };
}

export const ROUTE_FILE = `// Spotter's first-party ingest: reports, uploads, analytics, flags and status.
// The optional catch-all matters: the wire protocol uses sub-paths (/v1/...).
import { createSpotterHandler } from "${IMPORT_PATH}";
// import { github } from "@trusplex/spotter/core";

export const { GET, POST, PUT, HEAD, OPTIONS } = createSpotterHandler({
  hooks: [
    // github({ repo: "owner/name", token: process.env.GITHUB_TOKEN }),
  ],
});
`;

/** Append missing env vars; existing ones are never touched. */
export function addEnv(existing: string, vars: Record<string, string>): ConfigEdit {
  const have = new Set([...existing.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]));
  const add = Object.entries(vars).filter(([k]) => !have.has(k));
  if (!add.length) return { code: existing, changed: false };
  const block = ["", "# Spotter — https://console.trusplex.com (project settings → keys)", ...add.map(([k, v]) => `${k}=${v}`), ""].join("\n");
  return { code: `${existing.replace(/\n*$/, existing ? "\n" : "")}${block}`, changed: true };
}
