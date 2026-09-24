import { expect, test } from "@playwright/test";
import { clearIssues, dialog, shot, trigger, useVariant, visit, waitForIssues } from "./helpers";

test.describe("report flow", () => {
  test.beforeEach(async ({ page }) => {
    await useVariant(page, {});
    await clearIssues(page);
  });

  test("trigger → screenshot without panel → annotate → describe → submit → ticket", async ({ page }) => {
    await visit(page, "/checkout");
    // Reproduce the bug: typed values (masked in capture), then a failing payment.
    await page.getByTestId("name").fill("Ada Lovelace");
    await page.getByTestId("email").fill("ada@example.com");
    await page.getByTestId("continue").click();
    await page.getByTestId("card").fill("4242 4242 4242 4242");
    await page.getByTestId("password").fill("hunter2-secret");
    await page.getByTestId("pay").click();
    await expect(page.getByTestId("toast")).toBeVisible();
    await shot(page, "01-trigger");

    await trigger(page).hover();
    await trigger(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    const canvas = d.locator("canvas.sp-canvas");
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await shot(page, "02-annotate");

    // Draw a rectangle around the toast, then drop a numbered pin.
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.06);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.12, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.16, { steps: 5 });
    await page.mouse.up();
    await d.getByRole("button", { name: "Numbered pin" }).click();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.45);
    await d.getByRole("button", { name: "Hide sensitive info" }).click();
    await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.62, { steps: 4 });
    await page.mouse.up();
    await shot(page, "03-annotated");

    await d.locator("#sp-desc").fill("Paying fails with “Payment failed” and the total doesn't match the line items.");
    await d.getByRole("radio", { name: "Bug" }).click();
    await d.getByRole("button", { name: "Add what you expected" }).click();
    await d.locator("#sp-exp").fill("The order goes through and I see a confirmation.");
    await shot(page, "04-describe");
    await d.locator("#sp-email").fill("ada@example.com");
    await d.locator("#sp-email").scrollIntoViewIfNeeded();
    await shot(page, "05-contact");

    await d.getByRole("button", { name: "Send report" }).click();
    const ref = d.getByTestId("spotter-ref");
    await expect(ref).toHaveText(/^SPT-\d+/);
    await shot(page, "06-sent");
    await expect(d.getByRole("link", { name: "Powered by Spotter" })).toHaveAttribute("href", /trusplex\.com\/spotter\?ref=pk_test_fixture/);

    const [issue] = await waitForIssues(page, 1);
    expect(issue.schema).toBe("spotter.report.v1");
    expect(issue.ref).toBe(await ref.textContent());
    expect(issue.source).toBe("widget");
    expect(issue.test).toBe(true); // environment: development → test inbox
    expect(issue.content.description).toContain("Payment failed");
    expect(issue.content.expected).toContain("confirmation");
    expect(issue.content.category).toBe("bug");
    expect(issue.page.routePattern).toBe("/checkout");
    const tools = issue.content.annotations.map((a: { tool: string }) => a.tool);
    expect(tools).toEqual(expect.arrayContaining(["rect", "pin", "blur"]));
    expect(issue.content.annotations.find((a: { tool: string }) => a.tool === "pin").label).toBe("1");
    const kinds = issue.artifacts.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["screenshot", "annotated_screenshot"]));
    expect(issue.reporter.email).toBe("ada@example.com");

    // Signals: the console error, the failed request, and breadcrumbs.
    const consoleText = JSON.stringify(issue.signals.console);
    expect(consoleText).toContain("Payment failed");
    const failed = issue.signals.network.log.entries.find((e: { request: { url: string } }) => e.request.url.includes("/api/charge"));
    expect(failed?.response.status).toBe(502);
    expect(issue.signals.breadcrumbs.length).toBeGreaterThan(0);
    expect(issue.context.tags.fixture).toBe("next-app"); // beforeSend ran

    // Masking: typed values never leave the page, in any signal.
    const all = JSON.stringify(issue);
    expect(all).not.toContain("4242 4242 4242 4242");
    expect(all).not.toContain("hunter2-secret");

    // The screenshot excludes the panel: sample the stored image where the dim overlay would be.
    const shotArtifact = issue.artifacts.find((a: { kind: string }) => a.kind === "screenshot");
    expect(shotArtifact.url).toBeTruthy();
    const brightness = await page.evaluate(async (url) => {
      const blob = await (await fetch(url)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      // Top-left of the nav bar: white page chrome unless an overlay covered it.
      const p = ctx.getImageData(Math.round(bmp.width * 0.02), Math.round(bmp.height * 0.02), 1, 1).data;
      return (p[0]! + p[1]! + p[2]!) / 3;
    }, shotArtifact.url);
    expect(brightness).toBeGreaterThan(200);

    // Done closes and returns focus to the trigger.
    await d.getByRole("button", { name: "Done" }).click();
    await expect(d).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  test("panel is visible within 300 ms of a warmed trigger", async ({ page }) => {
    await visit(page, "/");
    await trigger(page).hover();
    await page.waitForTimeout(800); // hover warms core + the panel chunk
    const ms = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const host = document.querySelector("body > div[data-spotter-ui]")!;
          const btn = host.shadowRoot!.querySelector<HTMLButtonElement>(".sp-trigger")!;
          const t0 = performance.now();
          const check = () => {
            const d = host.shadowRoot!.querySelector("[role=dialog]");
            if (d && d.getBoundingClientRect().width > 0) resolve(performance.now() - t0);
            else requestAnimationFrame(check);
          };
          btn.click();
          requestAnimationFrame(check);
        }),
    );
    expect(ms).toBeLessThan(300);
  });

  test("keyboard only: shortcut, annotate with the keyboard, describe, send", async ({ page }) => {
    await visit(page, "/blog/winter-layering-guide");
    const d = dialog(page);
    // The shortcut listener installs at idle, just after the trigger mounts.
    await expect(async () => {
      await page.keyboard.press("Shift+Alt+B");
      await expect(d).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    const canvas = d.locator("canvas.sp-canvas[tabindex='0']"); // the interactive canvas, not the static preview shown while it loads
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    // Focus starts in "What went wrong?"; the canvas is a Tab stop.
    await expect(d.locator("#sp-desc")).toBeFocused();
    await canvas.focus();
    await page.keyboard.press("r"); // rectangle tool
    await page.keyboard.press("Enter"); // start a selection
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Enter"); // place it
    await page.keyboard.press("p");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+z"); // undo the pin
    await page.keyboard.press("Control+Shift+z"); // redo it
    await shot(page, "07-keyboard-annotate");
    // Tab through to the description and type.
    await d.locator("#sp-desc").focus();
    await page.keyboard.type("The second paragraph overlaps the header on scroll.");
    // Focus trap: tabbing past the end wraps inside the dialog.
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-spotter-ui"))).toBe(true);
    await page.keyboard.press("Control+Enter");
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.page.routePattern).toBe("/blog/[slug]");
    expect(issue.content.annotations.map((a: { tool: string }) => a.tool)).toEqual(["rect", "pin"]);
    await page.keyboard.press("Escape");
    await expect(d).toBeHidden();
  });

  test("Escape closes and restores focus to the opener", async ({ page }) => {
    await visit(page, "/");
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });
});
