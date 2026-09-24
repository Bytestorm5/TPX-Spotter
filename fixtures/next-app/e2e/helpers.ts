import { expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SHOTS = process.env.SPOTTER_SHOTS_DIR ?? "test-results/shots";
mkdirSync(SHOTS, { recursive: true });

/** Save a screenshot of a named UI state for visual review. */
export async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  await page.waitForTimeout(250); // let enter animations settle
  if (target) await target.screenshot({ path: join(SHOTS, `${name}.png`) });
  else await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

export type Variant = Partial<Record<"sp_locale" | "sp_theme" | "sp_mode" | "sp_preset" | "sp_review" | "sp_identify" | "sp_fields" | "sp_shortcut", string>>;

export async function useVariant(page: Page, variant: Variant): Promise<void> {
  await page.context().clearCookies();
  const cookies = Object.entries(variant).map(([name, value]) => ({ name, value: value ?? "", url: "http://localhost:3100" }));
  if (cookies.length) await page.context().addCookies(cookies);
}

export async function clearIssues(page: Page): Promise<void> {
  await page.request.delete("/api/test/issues");
}

export async function issues(page: Page): Promise<any[]> {
  return (await (await page.request.get("/api/test/issues")).json()) as any[];
}

/** Wait until the recorder hook has seen `n` issues (hooks run after the response). */
export async function waitForIssues(page: Page, n = 1): Promise<any[]> {
  let list: any[] = [];
  await expect
    .poll(
      async () => {
        list = await issues(page);
        return list.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(n);
  return list;
}

/** The floating trigger lives in the widget's shadow root; Playwright pierces open shadow roots. */
export function trigger(page: Page): Locator {
  return page.locator("[data-spotter-ui] .sp-trigger");
}

export function dialog(page: Page): Locator {
  return page.locator("[data-spotter-ui] [role=dialog][data-spotter-part=dialog]");
}

/** Visit and wait for the idle-mounted trigger. */
export async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(trigger(page)).toBeVisible({ timeout: 15_000 });
}
