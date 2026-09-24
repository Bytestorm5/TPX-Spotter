import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Use a preinstalled Chromium when the one this Playwright version expects
 * isn't there (sandboxed CI images ship browsers in PLAYWRIGHT_BROWSERS_PATH
 * and forbid `playwright install`). `SPOTTER_CHROMIUM` overrides.
 */
function chromium(): string | undefined {
  if (process.env.SPOTTER_CHROMIUM) return process.env.SPOTTER_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort();
  for (const d of dirs.reverse()) {
    const bin = join(root, d, "chrome-linux", "chrome");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

/**
 * Builds and starts the fixture on :3100, then drives Spotter like a user.
 * Screenshots of every major UI state go to SPOTTER_SHOTS_DIR (default
 * test-results/shots) for visual review.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: chromium(),
      // Let getDisplayMedia() pick the current tab without a picker, for the screen-recording flow.
      args: ["--auto-accept-this-tab-capture", "--auto-select-desktop-capture-source=Entire screen", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  webServer: {
    command: process.env.SPOTTER_SKIP_BUILD ? "pnpm start" : "pnpm build && pnpm start",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
