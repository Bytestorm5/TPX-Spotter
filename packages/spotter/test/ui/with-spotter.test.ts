import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEnvDts } from "../../src/ui/next/config/env-dts.ts";
import { resolveSpotterBuild, scanAppRoutes, withSpotter } from "../../src/ui/next/config/with-spotter.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "spotter-ws-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("withSpotter", () => {
  it("injects every feature flag and __SPOTTER_DEV__ through compiler.define", () => {
    vi.stubEnv("NODE_ENV", "production");
    const cfg = withSpotter({ reactStrictMode: true }, { project: "pk_test_x", features: { replay: false, recording: true }, typesPath: join(tmp(), "t.d.ts") });
    expect(cfg.reactStrictMode).toBe(true);
    expect(cfg.compiler?.define).toMatchObject({
      __SPOTTER_DEV__: false,
      __SPOTTER_REPLAY__: false,
      __SPOTTER_RECORDING__: true,
      __SPOTTER_WIDGET__: true,
      __SPOTTER_ANALYTICS__: true,
    });
    expect(cfg.env?.NEXT_PUBLIC_SPOTTER_PROJECT).toBe("pk_test_x");
    expect(cfg.env?.NEXT_PUBLIC_SPOTTER_ENVIRONMENT).toBe("production");
  });

  it("keeps the user's compiler options, defines and env (theirs win)", () => {
    const cfg = withSpotter(
      { compiler: { removeConsole: true, define: { __SPOTTER_DEV__: true, FOO: "1" } }, env: { NEXT_PUBLIC_SPOTTER_PROJECT: "pk_mine" } },
      { project: "pk_other", typesPath: join(tmp(), "t.d.ts") },
    );
    expect(cfg.compiler?.removeConsole).toBe(true);
    expect(cfg.compiler?.define).toMatchObject({ FOO: "1", __SPOTTER_DEV__: true });
    expect(cfg.env?.NEXT_PUBLIC_SPOTTER_PROJECT).toBe("pk_mine");
  });

  it("wraps Next's function config form", async () => {
    const fn = withSpotter(async () => ({ basePath: "/app" }), { typesPath: join(tmp(), "t.d.ts") }) as unknown as (
      p: string,
      c: { defaultConfig: object },
    ) => Promise<{ basePath?: string; compiler?: { define?: object } }>;
    const cfg = await fn("phase-production-build", { defaultConfig: {} });
    expect(cfg.basePath).toBe("/app");
    expect(cfg.compiler?.define).toHaveProperty("__SPOTTER_WIDGET__", true);
  });

  it("only enables (and hooks) source-map upload with a secret key in production builds", () => {
    vi.stubEnv("NODE_ENV", "production");
    const noKey = withSpotter({}, { typesPath: join(tmp(), "t.d.ts") });
    expect(noKey.productionBrowserSourceMaps).toBeUndefined();
    expect(noKey.compiler?.runAfterProductionCompile).toBeUndefined();
    vi.stubEnv("SPOTTER_SECRET_KEY", "sk_test_1");
    const withKey = withSpotter({}, { typesPath: join(tmp(), "t.d.ts") });
    expect(withKey.productionBrowserSourceMaps).toBe(true);
    expect(typeof withKey.compiler?.runAfterProductionCompile).toBe("function");
    const off = withSpotter({}, { sourceMaps: { upload: false }, typesPath: join(tmp(), "t.d.ts") });
    expect(off.compiler?.runAfterProductionCompile).toBeUndefined();
  });

  it("detects releases from the platform env", () => {
    const b = resolveSpotterBuild({}, { NODE_ENV: "production", VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "abcdef1234", VERCEL_ENV: "preview" });
    expect(b.release).toMatchObject({ provider: "vercel", commit: "abcdef1234" });
    expect(b.environment).toBe("preview");
    expect(resolveSpotterBuild({}, { NODE_ENV: "development" }).environment).toBe("development");
  });

  it("writes spotter-env.d.ts idempotently", () => {
    const file = join(tmp(), "spotter-env.d.ts");
    withSpotter({}, { features: { analytics: false }, types: { events: ["signup"] }, typesPath: file });
    const first = readFileSync(file, "utf8");
    expect(first).toContain("analytics: false;");
    expect(first).toContain('events: "signup";');
    withSpotter({}, { features: { analytics: false }, types: { events: ["signup"] }, typesPath: file });
    expect(readFileSync(file, "utf8")).toBe(first);
  });

  it("scans app/ for dynamic route patterns", () => {
    const root = tmp();
    const mk = (p: string) => {
      mkdirSync(join(root, p), { recursive: true });
      writeFileSync(join(root, p, "page.tsx"), "export default function P() { return null }");
    };
    mk("app");
    mk("app/(marketing)/blog/[slug]");
    mk("app/docs/[[...path]]");
    mk("app/about");
    mkdirSync(join(root, "app/api/spotter/[[...spotter]]"), { recursive: true });
    writeFileSync(join(root, "app/api/spotter/[[...spotter]]/route.ts"), "");
    expect(scanAppRoutes(root)).toEqual(["/api/spotter/[[...spotter]]", "/blog/[slug]", "/docs/[[...path]]"]);
  });
});

describe("spotter-env.d.ts", () => {
  it("types flags, events, fields (select → union) and contexts", () => {
    const out = generateEnvDts(
      { widget: true, screenshot: true, annotate: true, replay: false, analytics: true, flags: true, recording: false },
      { events: ["a", "b", "a"], fields: { order: "text", plan: { type: "select", options: ["free", "pro"] }, tags: "multiselect", ok: "checkbox", stars: "rating", "odd-id": "file" }, contexts: ["cart"] },
    );
    expect(out).toContain('declare module "@trusplex/spotter/core"');
    expect(out).toContain("replay: false;");
    expect(out).toContain('events: "a" | "b";');
    expect(out).toContain('plan: "free" | "pro";');
    expect(out).toContain("tags: string[];");
    expect(out).toContain("ok: boolean;");
    expect(out).toContain("stars: number;");
    expect(out).toContain('"odd-id": string[];');
    expect(out).toContain("cart: { [key: string]: SpotterJson };");
    expect(generateEnvDts({ widget: true, screenshot: true, annotate: true, replay: true, analytics: true, flags: true, recording: false })).toContain(
      "interface SpotterRegister {}",
    );
  });
});
