/**
 * Real-browser check for the screenshot and replay chunks (they need a real
 * layout engine, canvas and MutationObserver semantics that happy-dom lacks).
 *
 *   node test/signals/browser/run.mjs [outDir]
 *
 * Bundles harness.ts with esbuild, opens page.html in Chromium via Playwright
 * (from fixtures/next-app), captures screenshots in each scope (PNGs written
 * to outDir for eyeballing) and records a replay, then asserts that nothing
 * masked, blocked or typed into an input leaks into either.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, strFromU8 } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "../../..");
const out = resolve(process.argv[2] ?? join(tmpdir(), "spotter-browser-check"));
mkdirSync(out, { recursive: true });

const esbuild = createRequire(join(pkg, "package.json"))("esbuild");
const { chromium } = createRequire(resolve(pkg, "../../fixtures/next-app/package.json"))("@playwright/test");

await esbuild.build({
  entryPoints: [join(here, "harness.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: join(out, "harness.js"),
  logLevel: "error",
});
copyFileSync(join(here, "page.html"), join(out, "page.html"));

/** Prefer Playwright's pinned browser; fall back to any Chromium under PLAYWRIGHT_BROWSERS_PATH. */
function executablePath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const p = join(root, dir, "chrome-linux", "chrome");
    if (existsSync(p)) return p;
  }
  return undefined;
}

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: executablePath() });
}
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`file://${join(out, "page.html")}`);

// -- screenshots ------------------------------------------------------------------------
await page.evaluate(() => {
  window.scrollTo(0, 300);
  const sc = document.getElementById("scroller");
  sc.scrollTop = sc.scrollHeight;
});
for (const [scope, maskText, sel] of [
  ["viewport", "inputs"],
  ["viewport", "all"],
  ["element", "inputs", "#visible-card"],
  ["full", "inputs"],
]) {
  const r = await page.evaluate(([s, m, q]) => window.__spotter.screenshot(s, m, q), [scope, maskText, sel]);
  const file = join(out, `screenshot-${scope}-${maskText}.png`);
  writeFileSync(file, Buffer.from(r.png, "base64"));
  console.log(`     ${scope}/${maskText}: ${r.width}x${r.height} in ${r.ms} ms → ${file}`);
  check(r.method === "dom" && r.width > 0 && r.height > 0, `screenshot ${scope}/${maskText} rendered`);
  if (scope === "viewport" && maskText === "inputs") check(r.ms < 1000, `viewport screenshot under 1 s (${r.ms} ms)`);
}
// The live page must be untouched by masking.
const live = await page.evaluate(() => ({
  email: document.getElementById("email").value,
  masked: document.querySelector("[data-spotter-mask]").textContent,
  blocked: document.querySelector("[data-spotter-block]").textContent.trim(),
}));
check(live.email === "secret@example.com" && live.masked === "MASKED_ACCOUNT 12345" && live.blocked.startsWith("BLOCKED_SECRET"), "live DOM unchanged after capture");

// -- replay ---------------------------------------------------------------------------------
await page.evaluate(() => window.__spotter.replay("buffer"));
await page.fill("#email", "typed-secret@example.com");
await page.fill("#pw", "typed-hunter3");
await page.fill("#note", "TYPED_NOTE");
await page.click("#pay");
for (let i = 0; i < 4; i++) await page.click("#dead", { delay: 10 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const p = document.createElement("p");
  p.textContent = "late";
  document.body.appendChild(p);
});
const res = await page.evaluate(() => window.__spotter.flush());
check(!!res && res.events > 0, `replay flushed ${res?.events} events`);
const json = strFromU8(gunzipSync(Uint8Array.from(res.data)));
const events = JSON.parse(json);
writeFileSync(join(out, "replay.json"), json);
check(events.some((e) => e.type === 2), "replay contains a full snapshot");
for (const secret of ["secret@example.com", "typed-secret", "hunter2", "typed-hunter3", "PRIVATE_NOTE", "TYPED_NOTE", "MASKED_ACCOUNT", "12345", "PII_CLASS_TEXT", "BLOCKED_SECRET", "AD_TEXT", "SPOTTER_UI_PANEL"]) {
  check(!json.includes(secret), `replay does not contain ${secret}`);
}
check(json.includes("UNMASKED_INSIDE"), "replay keeps data-spotter-unmask text");
check(json.includes("Pay now") && json.includes("Paid!"), "replay records ordinary text and mutations");
check(!/"tagName":"canvas"[^}]*"rr_dataURL"/.test(json), "canvas content not recorded by default");
console.log(`     derived signals: ${JSON.stringify(res.signals)}`);
check(res.signals.some((s) => s.kind === "rage_click"), "rage click derived from replay");
check(res.seq === 0, "on-demand segment uploaded");

// -- DOM snapshot artifact ------------------------------------------------------------------
const snap = await page.evaluate(() => window.__spotter.snapshot());
for (const secret of ["typed-secret", "hunter", "PRIVATE_NOTE", "MASKED_ACCOUNT", "BLOCKED_SECRET", "SPOTTER_UI_PANEL"]) {
  check(!snap.includes(secret), `dom snapshot does not contain ${secret}`);
}

const path = await page.evaluate(() => window.__spotter.compressionPath());
console.log(`     compression path: ${path}`);
check(path === "worker", "gzip ran in a Web Worker");
check(errors.length === 0, `no page errors ${errors.join("; ")}`);

// -- sampled mode + CSP that blocks workers (gzipSync fallback) -------------------------------
const html = readFileSync(join(out, "page.html"), "utf8").replace(
  "<head>",
  `<head><meta http-equiv="Content-Security-Policy" content="worker-src 'none'; script-src 'self' 'unsafe-inline'">`,
);
writeFileSync(join(out, "page-csp.html"), html);
const page2 = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors2 = [];
page2.on("pageerror", (e) => errors2.push(String(e)));
await page2.goto(`file://${join(out, "page-csp.html")}`);
await page2.evaluate(() => window.__spotter.replay("sampled"));
await page2.fill("#email", "csp-secret@example.com");
await page2.click("#pay");
const sampled = await page2.evaluate(() => window.__spotter.sampledSegment());
const segJson = strFromU8(gunzipSync(Uint8Array.from(sampled.segments[0]?.data ?? [])));
check(sampled.seq === 0 && sampled.segments.length === 1, `sampled mode streamed segment #${sampled.seq} (${sampled.segments[0]?.bytes} bytes gz)`);
check(JSON.parse(segJson).some((e) => e.type === 2), "first sampled segment starts with a full snapshot");
check(!segJson.includes("csp-secret"), "sampled segment masks typed input");
const path2 = await page2.evaluate(() => window.__spotter.compressionPath());
check(path2 === "sync", `CSP-blocked worker falls back to gzipSync (path: ${path2})`);
check(errors2.length === 0, `no page errors under CSP ${errors2.join("; ")}`);
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
