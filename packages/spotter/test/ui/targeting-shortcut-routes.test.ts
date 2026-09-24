import { describe, expect, it } from "vitest";
import { detectRelease, releaseName } from "../../src/ui/next/internal/release.ts";
import { appDirToPattern, deriveRoutePattern, matchRoutePattern } from "../../src/ui/next/internal/route-pattern.ts";
import { formatShortcut, isTypingTarget, matchesShortcut, parseShortcut } from "../../src/ui/next/internal/shortcut.ts";
import { evaluateTargeting, routeMatches, type TargetingContext } from "../../src/ui/next/internal/targeting.ts";

describe("targeting", () => {
  const base: TargetingContext = { path: "/checkout/pay", environment: "staging", release: "2.14.0", reporter: { identified: true, type: "public", traits: { beta: true, plan: "pro" } } };

  it("matches route globs", () => {
    expect(routeMatches("/checkout/*", "/checkout/pay")).toBe(true);
    expect(routeMatches("/checkout/*", "/checkout")).toBe(true);
    expect(routeMatches("/checkout/*", "/checkout/pay/confirm")).toBe(false);
    expect(routeMatches("/checkout/**", "/checkout/pay/confirm")).toBe(true);
    expect(routeMatches("/blog/[slug]", "/blog/[slug]")).toBe(true);
    expect(routeMatches("/", "/")).toBe(true);
    expect(routeMatches("/a.b", "/axb")).toBe(false);
  });

  it("ANDs dimensions and ORs within one", () => {
    expect(evaluateTargeting(undefined, base)).toBe(true);
    expect(evaluateTargeting({ environments: ["staging", "preview"] }, base)).toBe(true);
    expect(evaluateTargeting({ environments: ["production"] }, base)).toBe(false);
    expect(evaluateTargeting({ routes: ["/checkout/*"], environments: ["staging"] }, base)).toBe(true);
    expect(evaluateTargeting({ routes: ["/blog/*"], environments: ["staging"] }, base)).toBe(false);
    expect(evaluateTargeting({ releases: ["2.14.*"] }, base)).toBe(true);
    expect(evaluateTargeting({ releases: ["3.*"] }, base)).toBe(false);
  });

  it("lets excludeRoutes win and matches route patterns too", () => {
    expect(evaluateTargeting({ routes: ["/**"], excludeRoutes: ["/checkout/*"] }, base)).toBe(false);
    expect(evaluateTargeting({ routes: ["/blog/[slug]"] }, { ...base, path: "/blog/hello", routePattern: "/blog/[slug]" })).toBe(true);
  });

  it("targets segments: identified, anonymous, team, traits", () => {
    expect(evaluateTargeting({ segments: ["identified"] }, base)).toBe(true);
    expect(evaluateTargeting({ segments: ["anonymous"] }, base)).toBe(false);
    expect(evaluateTargeting({ segments: ["team"] }, base)).toBe(false);
    expect(evaluateTargeting({ segments: ["trait:beta"] }, base)).toBe(true);
    expect(evaluateTargeting({ segments: ["trait:plan=pro"] }, base)).toBe(true);
    expect(evaluateTargeting({ segments: ["trait:plan=free"] }, base)).toBe(false);
    expect(evaluateTargeting({ segments: ["team", "trait:plan=pro"] }, base)).toBe(true);
  });
});

describe("shortcuts", () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: "", code: "", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });

  it("parses modifier+key strings in any order and case", () => {
    expect(parseShortcut("Shift+Alt+B")).toEqual({ key: "b", shift: true, alt: true, ctrl: false, meta: false });
    expect(parseShortcut("alt + shift + b")).toEqual(parseShortcut("Shift+Alt+B"));
    expect(parseShortcut("Cmd+K")).toMatchObject({ meta: true, key: "k" });
    expect(parseShortcut("Mod+K", true)).toMatchObject({ meta: true, ctrl: false });
    expect(parseShortcut("Mod+K", false)).toMatchObject({ ctrl: true, meta: false });
    expect(parseShortcut("Ctrl+Shift++")).toMatchObject({ key: "+", ctrl: true, shift: true });
    expect(parseShortcut("Alt+Esc")).toMatchObject({ key: "escape" });
  });

  it("rejects off, empty, malformed and bare printable keys", () => {
    for (const s of [null, undefined, "", "off", "none", "Shift+", "Alt+B+C", "B", "Shift+B"]) expect(parseShortcut(s)).toBeNull();
    expect(parseShortcut("F2")).toMatchObject({ key: "f2" });
  });

  it("matches on the physical key so Alt/Shift-altered characters still fire", () => {
    const s = parseShortcut("Shift+Alt+B")!;
    // macOS: Alt+Shift+B produces "ı" as event.key.
    expect(matchesShortcut(ev({ key: "ı", code: "KeyB", shiftKey: true, altKey: true }), s)).toBe(true);
    expect(matchesShortcut(ev({ key: "B", code: "KeyB", shiftKey: true }), s)).toBe(false);
    expect(matchesShortcut(ev({ key: "B", code: "KeyB", shiftKey: true, altKey: true, ctrlKey: true }), s)).toBe(false);
    const f = parseShortcut("Alt+F2")!;
    expect(matchesShortcut(ev({ key: "F2", code: "F2", altKey: true }), f)).toBe(true);
  });

  it("formats for aria-keyshortcuts", () => {
    expect(formatShortcut(parseShortcut("shift+alt+b")!)).toBe("Alt+Shift+B");
    expect(formatShortcut(parseShortcut("ctrl+arrowup")!)).toBe("Control+ArrowUp");
  });

  it("knows typing targets", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("route patterns", () => {
  it("derives patterns from params", () => {
    expect(deriveRoutePattern("/blog/hello-world", { slug: "hello-world" })).toBe("/blog/[slug]");
    expect(deriveRoutePattern("/shop/shoes/42", { category: "shoes", id: "42" })).toBe("/shop/[category]/[id]");
    expect(deriveRoutePattern("/docs/a/b/c", { path: ["a", "b", "c"] })).toBe("/docs/[...path]");
    expect(deriveRoutePattern("/blog/caf%C3%A9", { slug: "café" })).toBe("/blog/[slug]");
    expect(deriveRoutePattern("/about", {})).toBe("/about");
    expect(deriveRoutePattern("/about?x=1", null)).toBe("/about");
  });

  it("maps app/ folders to URL patterns", () => {
    expect(appDirToPattern("")).toBe("/");
    expect(appDirToPattern("(marketing)/blog/[slug]")).toBe("/blog/[slug]");
    expect(appDirToPattern("@modal/photo/[id]")).toBe("/photo/[id]");
    expect(appDirToPattern("(.)photo/[id]")).toBeNull();
    expect(appDirToPattern("_components")).toBeNull();
  });

  it("matches URLs to the most specific pattern, App Router style", () => {
    const patterns = ["/blog/[slug]", "/blog/[...rest]", "/docs/[[...path]]", "/shop/[category]/[id]", "/blog/featured/[slug]"];
    expect(matchRoutePattern("/blog/hello", patterns)).toBe("/blog/[slug]");
    expect(matchRoutePattern("/blog/a/b", patterns)).toBe("/blog/[...rest]");
    expect(matchRoutePattern("/blog/featured/x", patterns)).toBe("/blog/featured/[slug]");
    expect(matchRoutePattern("/docs", patterns)).toBe("/docs/[[...path]]");
    expect(matchRoutePattern("/docs/x/y", patterns)).toBe("/docs/[[...path]]");
    expect(matchRoutePattern("/shop/shoes/1", patterns)).toBe("/shop/[category]/[id]");
    expect(matchRoutePattern("/shop/shoes", patterns)).toBeUndefined();
    expect(matchRoutePattern("/about", patterns)).toBeUndefined();
  });
});

describe("release detection", () => {
  it("reads Vercel", () => {
    const r = detectRelease({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "abcdef1234567890", VERCEL_DEPLOYMENT_ID: "dpl_1", VERCEL_ENV: "preview" });
    expect(r).toMatchObject({ provider: "vercel", commit: "abcdef1234567890", deployId: "dpl_1", environment: "preview", version: "abcdef123456" });
  });
  it("reads Netlify and normalises its contexts", () => {
    expect(detectRelease({ NETLIFY: "true", COMMIT_REF: "c1", DEPLOY_ID: "d1", CONTEXT: "deploy-preview" }, "1.2.3")).toMatchObject({
      provider: "netlify",
      environment: "preview",
      version: "1.2.3",
    });
    expect(detectRelease({ NETLIFY: "true", CONTEXT: "branch-deploy" }).environment).toBe("staging");
  });
  it("reads Cloudflare Pages", () => {
    expect(detectRelease({ CF_PAGES: "1", CF_PAGES_COMMIT_SHA: "c2", CF_PAGES_BRANCH: "main", CF_PAGES_URL: "https://abc123.site.pages.dev" })).toMatchObject({
      provider: "cloudflare-pages",
      environment: "production",
      deployId: "abc123",
    });
    expect(detectRelease({ CF_PAGES: "1", CF_PAGES_BRANCH: "feature-x" }).environment).toBe("preview");
  });
  it("prefers Console-managed deploys, then explicit options", () => {
    expect(detectRelease({ TPX_DEPLOY_ID: "tpx_9", TPX_COMMIT: "c3", VERCEL: "1" })).toMatchObject({ provider: "trusplex", deployId: "tpx_9" });
    expect(detectRelease({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "c4" }, "1.0.0", { version: "2.0.0" })).toMatchObject({ version: "2.0.0", provider: "explicit" });
    expect(detectRelease({}, "0.4.0")).toEqual({ version: "0.4.0", provider: "package" });
  });
  it("names releases version+sha", () => {
    expect(releaseName({ version: "1.2.3", commit: "abcdef123" })).toBe("1.2.3+abcdef1");
    expect(releaseName({ version: "abcdef123456", commit: "abcdef123456" })).toBe("abcdef123456");
  });
});
