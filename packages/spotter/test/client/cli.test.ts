import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addEnv, addProviderToLayout, wrapNextConfig } from "../../src/cli/transforms.ts";
import { checkCsp, doctor, extractCsp } from "../../src/cli/doctor.ts";
import { init } from "../../src/cli/init.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spotter-cli-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const LAYOUT = `import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="x">
        {children}
      </body>
    </html>
  );
}
`;

describe("transforms", () => {
  it("wraps next.config (esm identifier / object / function, cjs) idempotently", () => {
    const ts = wrapNextConfig(`import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = { reactStrictMode: true };\n\nexport default nextConfig;\n`, "esm")!;
    expect(ts.code).toContain('import { withSpotter } from "@trusplex/spotter/ui/next";');
    expect(ts.code).toContain("const nextConfigBase = nextConfig;");
    expect(ts.code).toMatch(/export default withSpotter\(nextConfigBase, \{\n  project: process\.env\.NEXT_PUBLIC_SPOTTER_PROJECT/);
    expect(ts.code.indexOf("import { withSpotter }")).toBeGreaterThan(ts.code.indexOf('from "next"'));
    expect(wrapNextConfig(ts.code, "esm")).toEqual({ code: ts.code, changed: false });

    const obj = wrapNextConfig(`export default {\n  images: { unoptimized: true },\n};\n`, "esm")!;
    expect(obj.code).toContain("const nextConfigBase = {\n  images");

    const fn = wrapNextConfig(`export default async function config(phase) {\n  return {};\n}\n`, "esm")!;
    expect(fn.code).toContain("async function config(phase)");
    expect(fn.code).toContain("export default withSpotter(config,");

    const cjs = wrapNextConfig(`/** @type {import('next').NextConfig} */\nmodule.exports = { output: "standalone" };\n`, "cjs")!;
    expect(cjs.code).toContain('const { withSpotter } = require("@trusplex/spotter/ui/next");');
    expect(cjs.code).toContain("module.exports = withSpotter(nextConfigBase,");

    expect(wrapNextConfig(`export { default } from "./other.mjs";\n`, "esm")).toBeNull();
  });

  it("adds the provider around {children} in the root layout", () => {
    const edit = addProviderToLayout(LAYOUT)!;
    expect(edit.code).toContain('import { SpotterProvider, Spotter } from "@trusplex/spotter/ui/next";');
    expect(edit.code).toContain("<SpotterProvider>\n          {children}\n          <Spotter />\n        </SpotterProvider>");
    expect(addProviderToLayout(edit.code)!.changed).toBe(false);
    expect(addProviderToLayout("export default function L() { return null }")).toBeNull();
  });

  it("appends env placeholders without touching existing values", () => {
    const e = addEnv("NEXT_PUBLIC_SPOTTER_PROJECT=pk_live_real\n", { NEXT_PUBLIC_SPOTTER_PROJECT: "x", SPOTTER_SECRET_KEY: "sk_live_REPLACE_ME" });
    expect(e.code).toContain("NEXT_PUBLIC_SPOTTER_PROJECT=pk_live_real");
    expect(e.code).toContain("SPOTTER_SECRET_KEY=sk_live_REPLACE_ME");
    expect(e.code).not.toContain("NEXT_PUBLIC_SPOTTER_PROJECT=x");
  });
});

describe("init + doctor", () => {
  it("sets up a Next app end to end, and doctor is then clean except the placeholders", () => {
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16.3.6", react: "19.3.0" } }),
      "pnpm-lock.yaml": "",
      "tsconfig.json": "{}",
      "next.config.ts": `const nextConfig = {};\nexport default nextConfig;\n`,
      "app/layout.tsx": LAYOUT,
    });
    const ran: string[] = [];
    const lines: string[] = [];
    const code = init({ root, log: (l) => lines.push(l), run: (cmd, args) => (ran.push(`${cmd} ${args.join(" ")}`), 0) });
    expect(code).toBe(0);
    expect(ran).toEqual(["pnpm add @trusplex/spotter"]);
    expect(readFileSync(join(root, "next.config.ts"), "utf8")).toContain("withSpotter(nextConfigBase");
    expect(readFileSync(join(root, "app/layout.tsx"), "utf8")).toContain("<Spotter />");
    expect(readFileSync(join(root, "app/api/spotter/[[...spotter]]/route.ts"), "utf8")).toContain("createSpotterHandler");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toContain("NEXT_PUBLIC_SPOTTER_PROJECT=pk_live_REPLACE_ME");

    // idempotent
    const before = readFileSync(join(root, "next.config.ts"), "utf8");
    init({ root, log: () => {}, run: () => 0 });
    expect(readFileSync(join(root, "next.config.ts"), "utf8")).toBe(before);

    // doctor: the package isn't in package.json (install was mocked) and the keys are placeholders
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.3.6", "@trusplex/spotter": "^0.1.0" } }));
    const findings = doctor(root);
    const errors = findings.filter((f) => f.level === "error").map((f) => f.check);
    expect(errors).toEqual(["keys", "keys"]);
    expect(findings.find((f) => f.check === "route")!.level).toBe("ok");
  });

  it("doctor flags a non-catch-all route, a leaked secret and public source maps", () => {
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16", "@trusplex/spotter": "0.1.0" } }),
      ".env.local": "NEXT_PUBLIC_SPOTTER_PROJECT=pk_live_abcdefgh12\nNEXT_PUBLIC_OOPS=sk_live_abcdefgh12\n",
      "next.config.mjs": `export default { productionBrowserSourceMaps: true };\n`,
      "app/api/spotter/route.ts": `export const { GET, POST } = createSpotterHandler();\n`,
      ".next/static/chunks/main.js": "window.__trusplexSpotter=1",
      ".next/static/chunks/main.js.map": "{}",
    });
    const findings = doctor(root);
    const msg = findings.map((f) => `${f.level} ${f.check}: ${f.message}`).join("\n");
    expect(msg).toMatch(/error route: .* isn't a catch-all/);
    expect(msg).toMatch(/error keys: NEXT_PUBLIC_OOPS holds a secret key/);
    expect(msg).toMatch(/error config: next\.config\.mjs isn't wrapped/);
    expect(msg).toMatch(/warn sourcemaps: productionBrowserSourceMaps/);
    expect(msg).toMatch(/warn sourcemaps: 1 source map/);
    expect(msg).toMatch(/ok bundle: 1 chunk\(s\) contain Spotter/);
    expect(existsSync(join(root, "app/api/spotter/route.ts"))).toBe(true);
  });

  it("checks CSP connect-src / worker-src / img-src", () => {
    const policy = extractCsp(`const csp = ["default-src 'self'", "connect-src 'self' https://api.acme.com", "img-src 'self'", "worker-src 'self'"].join("; ");`)!;
    const first = checkCsp(policy, "/api/spotter");
    expect(first.filter((f) => f.level === "error")).toEqual([]);
    expect(first.map((f) => f.message).join("\n")).toMatch(/worker-src doesn't allow blob:/);
    const hosted = checkCsp(policy, "https://console.trusplex.com/hooks/spotter");
    expect(hosted.find((f) => f.level === "error")!.fix).toBe("Add https://console.trusplex.com to connect-src.");
  });
});
