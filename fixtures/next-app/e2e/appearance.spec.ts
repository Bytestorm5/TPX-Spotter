import { expect, test } from "@playwright/test";
import { clearIssues, dialog, shot, trigger, useVariant, visit, waitForIssues } from "./helpers";

test.describe("appearance, isolation and locales", () => {
  test.beforeEach(async ({ page }) => {
    await useVariant(page, {});
    await clearIssues(page);
  });

  test("mobile: edge tab, full-screen annotate step, then describe", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await visit(page, "/checkout");
    const t = trigger(page);
    const box = (await t.boundingBox())!;
    expect(box.width).toBeLessThan(36); // collapsed to an edge tab
    expect(box.x + box.width).toBeGreaterThanOrEqual(389); // flush with the right edge
    await shot(page, "20-mobile-trigger");
    await t.tap();
    const d = dialog(page);
    await expect(d.locator("canvas.sp-canvas")).toBeVisible({ timeout: 15_000 });
    await expect(d.locator("#sp-desc")).toBeHidden(); // annotate is its own step on phones
    await shot(page, "21-mobile-annotate");
    const c = (await d.locator("canvas.sp-canvas").boundingBox())!;
    // Drop a pin with a finger.
    await d.getByRole("button", { name: "Numbered pin" }).tap();
    await page.touchscreen.tap(c.x + c.width * 0.5, c.y + c.height * 0.4);
    await d.getByRole("button", { name: "Continue" }).tap();
    await expect(d.locator("#sp-desc")).toBeVisible();
    await d.locator("#sp-desc").fill("Pay button is hidden behind the keyboard.");
    await shot(page, "22-mobile-describe");
    await d.getByRole("button", { name: "Send report" }).tap();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    await shot(page, "23-mobile-sent");
    const [issue] = await waitForIssues(page, 1);
    expect(issue.environment.device).toMatch(/mobile|tablet/);
    expect(issue.content.annotations.map((a: { tool: string }) => a.tool)).toContain("pin");
    await context.close();
  });

  test("dark mode follows the host's class=\"dark\"", async ({ page }) => {
    await useVariant(page, { sp_theme: "dark" });
    await visit(page, "/checkout");
    await shot(page, "24-dark-trigger");
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.locator("canvas.sp-canvas")).toBeVisible({ timeout: 15_000 });
    await d.locator("#sp-desc").fill("Contrast of the summary card is too low.");
    const bg = await d.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(27, 27, 31)");
    await shot(page, "25-dark-panel");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    await shot(page, "26-dark-sent");
  });

  test("RTL: Arabic strings and right-to-left layout", async ({ page }) => {
    await useVariant(page, { sp_locale: "ar" });
    await visit(page, "/");
    await expect(trigger(page)).toHaveAttribute("aria-label", "الإبلاغ عن مشكلة");
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.getByRole("heading", { name: "الإبلاغ عن مشكلة" })).toBeVisible();
    const dir = await page.evaluate(() => document.querySelector("[data-spotter-ui]")!.shadowRoot!.querySelector(".sp-root")!.getAttribute("dir"));
    expect(dir).toBe("rtl");
    // Logical properties: the form column sits on the left in RTL.
    const side = (await d.locator("form.sp-side").boundingBox())!;
    const stage = (await d.locator(".sp-stage").boundingBox())!;
    expect(side.x).toBeLessThan(stage.x);
    await expect(d.locator("canvas.sp-canvas")).toBeVisible({ timeout: 15_000 });
    await d.locator("#sp-desc").fill("زر الدفع لا يعمل");
    await shot(page, "27-rtl-ar");
  });

  test("other locales load lazily (ja)", async ({ page }) => {
    await useVariant(page, { sp_locale: "ja" });
    await visit(page, "/");
    await expect(trigger(page)).toHaveAttribute("aria-label", "問題を報告");
    await page.getByTestId("suggest").click();
    await expect(dialog(page).getByRole("heading", { name: "アイデアを提案" })).toBeVisible();
    await shot(page, "28-ja-feature");
  });

  test("unstyled mode ships no CSS and no shadow root", async ({ page }) => {
    await useVariant(page, { sp_mode: "unstyled" });
    await page.goto("/");
    const t = page.locator("[data-spotter-ui] .sp-trigger");
    await expect(t).toBeAttached({ timeout: 15_000 });
    const info = await page.evaluate(() => {
      const host = document.querySelector("[data-spotter-ui]")!;
      return {
        shadow: !!host.shadowRoot,
        styles: document.querySelectorAll("style[data-spotter-style]").length,
        adopted: document.adoptedStyleSheets.length,
        position: getComputedStyle(host.querySelector(".sp-trigger")!).position,
      };
    });
    expect(info).toEqual({ shadow: false, styles: 0, adopted: 0, position: "static" });
    await t.click();
    await expect(page.locator("[data-spotter-ui] [role=dialog]")).toBeVisible();
    await shot(page, "29-unstyled");
  });

  test("shadow DOM isolation: aggressive host CSS doesn't leak in", async ({ page }) => {
    await visit(page, "/");
    await page.addStyleTag({ content: "* { color: rgb(255, 0, 0) !important; font-family: serif !important; } button { padding: 40px !important; border-radius: 0 !important; } div { margin: 20px !important; }" });
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.locator("#sp-desc")).toBeVisible();
    const style = await d.locator(".sp-title").evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, font: s.fontFamily };
    });
    expect(style.color).not.toBe("rgb(255, 0, 0)");
    expect(style.font).not.toBe("serif");
    const t = await trigger(page).evaluate((el) => getComputedStyle(el).paddingTop);
    expect(t).not.toBe("40px");
    const hostMargin = await page.evaluate(() => getComputedStyle(document.querySelector("[data-spotter-ui]")!).marginTop);
    expect(hostMargin).toBe("0px");
    await shot(page, "30-isolation");
  });

  test("no layout shift from the widget, and no Spotter requests before interaction", async ({ page }) => {
    const spotterRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/spotter")) spotterRequests.push(r.url());
    });
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await visit(page, "/blog/winter-layering-guide");
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.001);
    expect(spotterRequests).toEqual([]);
  });

  for (const preset of ["minimal", "rounded", "sharp"] as const) {
    test(`preset: ${preset}`, async ({ page }) => {
      await useVariant(page, { sp_preset: preset });
      await visit(page, "/");
      await page.getByTestId("suggest").click();
      await expect(dialog(page).locator("#sp-desc")).toBeVisible();
      await shot(page, `31-preset-${preset}`, dialog(page));
    });
  }
});
