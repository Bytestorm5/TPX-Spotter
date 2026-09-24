import { expect, test } from "@playwright/test";
import { clearIssues, dialog, shot, trigger, useVariant, visit, waitForIssues } from "./helpers";

test.describe("alternate flows", () => {
  test.beforeEach(async ({ page }) => {
    await useVariant(page, {});
    await clearIssues(page);
  });

  test("text-only report from the host's own link (SpotterTrigger asChild)", async ({ page }) => {
    await visit(page, "/");
    const link = page.locator("#report-link");
    await expect(link).toHaveAttribute("aria-haspopup", "dialog");
    await link.click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d).toHaveAttribute("data-layout", "compact");
    await expect(d.locator("canvas.sp-canvas")).toHaveCount(0);
    expect(page.url()).not.toContain("#report"); // the href didn't navigate
    await d.locator("#sp-desc").fill("The size guide link in the footer goes nowhere.");
    await shot(page, "10-text-only");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.artifacts.some((a: { kind: string }) => a.kind === "screenshot")).toBe(false);
    expect(issue.content.category).toBe("bug");
  });

  test("feature-request mode: no screenshot, idea category", async ({ page }) => {
    await visit(page, "/");
    await page.getByTestId("suggest").click();
    const d = dialog(page);
    await expect(d.getByRole("heading", { name: "Suggest an idea" })).toBeVisible();
    await expect(d.getByText("What would you like to see?")).toBeVisible();
    await expect(d.getByRole("radiogroup")).toHaveCount(0); // no category chips for ideas
    await d.locator("#sp-desc").fill("Let me save items to a wishlist.");
    await shot(page, "11-feature");
    await d.getByRole("button", { name: "Send idea" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.content.category).toBe("feature");
    expect(issue.artifacts.some((a: { kind: string }) => a.kind === "screenshot")).toBe(false);
  });

  test("element picker: hover highlights, click reports that element", async ({ page }) => {
    await visit(page, "/");
    await page.getByTestId("point").click();
    const hint = page.locator("[data-spotter-ui] [data-spotter-part=picker]");
    await expect(hint).toBeVisible();
    const card = page.getByTestId("product-3");
    await card.locator("h3").hover();
    await expect(page.locator("[data-spotter-ui] .sp-picker-box")).toBeVisible();
    await shot(page, "12-picker");
    await card.locator("h3").click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.locator("canvas.sp-canvas")).toBeVisible({ timeout: 15_000 });
    await expect(d.getByText(/Element: h3/)).toBeVisible();
    await d.locator("#sp-desc").fill("The product name is truncated on the card.");
    await shot(page, "13-element-report");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.page.selector).toBeTruthy();
    expect(issue.page.selector).toMatch(/h3/);
    // The picked element comes pre-outlined on the screenshot.
    expect(issue.content.annotations[0]?.tool).toBe("rect");
    // The pick click never reached the page (no navigation happened).
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("element report from a 'Report this' link", async ({ page }) => {
    await visit(page, "/");
    await page.getByTestId("report-2").click();
    const d = dialog(page);
    await expect(d.locator("canvas.sp-canvas")).toBeVisible({ timeout: 15_000 });
    await expect(d.getByText(/Element: article#product-2/)).toBeVisible();
    await d.locator("#sp-desc").fill("Price shows $89 but the cart says $95.");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.page.selector).toContain("product-2");
  });

  test("error boundary: captures the exception and opens a prefilled report", async ({ page }) => {
    await visit(page, "/broken");
    await page.getByTestId("check-balance").click();
    await expect(page.getByTestId("boundary")).toBeVisible();
    await page.getByTestId("boundary-report").click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByText("Something went wrong on this page.")).toBeVisible();
    await expect(d.locator("#sp-desc")).toHaveAttribute("placeholder", "Something broke. Tell us what you were doing?");
    await shot(page, "14-error-boundary");
    await d.locator("#sp-desc").fill("I entered my gift card code and pressed Check balance.");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const list = await waitForIssues(page, 2);
    const fromBoundary = list.find((i) => i.source === "error");
    expect(fromBoundary).toBeTruthy();
    expect(JSON.stringify(fromBoundary.signals.errors)).toMatch(/Cannot read properties of undefined/);
    const fromWidget = list.find((i) => i.source === "widget");
    expect(fromWidget.content.title).toMatch(/TypeError/);
  });

  test("review before send lists attachments and lets the reporter remove them", async ({ page }) => {
    await useVariant(page, { sp_review: "1" });
    await visit(page, "/checkout");
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.locator("canvas.sp-canvas")).toBeVisible({ timeout: 15_000 });
    await d.locator("#sp-desc").fill("Shipping cost looks wrong.");
    await d.getByRole("button", { name: "Review and send" }).click();
    await expect(d.getByRole("heading", { name: "Review before sending" })).toBeVisible();
    await expect(d.getByText("Browser, device and page address")).toBeVisible();
    await d.getByRole("button", { name: /Remove Screenshot of this page/ }).click();
    await expect(d.getByText("Removed")).toBeVisible();
    await shot(page, "15-review");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.artifacts.some((a: { kind: string }) => a.kind === "screenshot")).toBe(false);
  });

  test("contact is skipped when identify() was called", async ({ page }) => {
    await useVariant(page, { sp_identify: "1" });
    await visit(page, "/blog/winter-layering-guide");
    // Needs the client's identity() getter (requested from core); without it an identify() made before core loads is invisible to the UI.
    const hasIdentity = await page.evaluate(() => typeof (window as any).__trusplexSpotter?.identity === "function");
    test.skip(!hasIdentity, "core client lacks identity(): pending integration");
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.locator("#sp-desc")).toBeVisible();
    await expect(d.locator("#sp-email")).toHaveCount(0);
    await d.locator("#sp-desc").fill("Images in this post load slowly.");
    await d.getByRole("radio", { name: "Slow" }).click();
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.reporter.id).toBe("user_42");
    expect(issue.content.category).toBe("performance");
  });

  test("custom fields: conditional visibility and validation", async ({ page }) => {
    await useVariant(page, { sp_fields: "1" });
    await visit(page, "/checkout");
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.locator("#sp-desc")).toBeVisible();
    await expect(d.getByLabel("Order number")).toHaveCount(0);
    await d.getByRole("radio", { name: "Bug" }).click();
    await expect(d.getByLabel("Order number")).toBeVisible();
    await d.locator("#sp-desc").fill("Charged twice.");
    await d.getByLabel("Order number").fill("12");
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByText("Use the format ORD-1234")).toBeVisible();
    await shot(page, "16-fields-validation");
    await d.getByLabel("Order number").fill("ORD-5521");
    await d.getByLabel("Your plan").selectOption("pro");
    await d.getByRole("radio", { name: "4 out of 5" }).click();
    await d.getByRole("button", { name: "Send report" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    const [issue] = await waitForIssues(page, 1);
    expect(issue.content.fields).toMatchObject({ order_number: "ORD-5521", plan: "pro", rating: 4 });
  });
});
