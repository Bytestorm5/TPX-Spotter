import { expect, test, type Page } from "@playwright/test";
import { clearIssues, dialog, shot, trigger, useVariant, visit, waitForIssues } from "./helpers";

async function fileReport(page: Page, text: string): Promise<string> {
  await trigger(page).click();
  const d = dialog(page);
  await expect(d.locator("#sp-desc")).toBeVisible();
  await d.locator("#sp-desc").fill(text);
  await d.getByRole("button", { name: "Send report" }).click();
  const ref = (await d.getByTestId("spotter-ref").textContent())!;
  await d.getByRole("button", { name: "Done" }).click();
  return ref;
}

test.describe("team mode and the closed loop", () => {
  test.beforeEach(async ({ page }) => {
    await useVariant(page, {});
    await clearIssues(page);
  });

  test("team mode: extra fields, dev details, duplicates with +1", async ({ page }) => {
    // A public report on the same page first, so there is something to match.
    await visit(page, "/checkout");
    await fileReport(page, "Pay button does nothing.");
    await waitForIssues(page, 1);

    // Signed in as a teammate (the token Console's connect popup would store).
    await page.addInitScript(() => sessionStorage.setItem("spotter:team", JSON.stringify({ token: "tt_fixture", name: "Grace" })));
    await visit(page, "/checkout");
    await page.evaluate(() => console.error("Stripe.js failed to load"));
    await trigger(page).click();
    const d = dialog(page);
    await expect(d.getByText("Team", { exact: true })).toBeVisible();
    await expect(d.locator("#sp-desc")).toBeVisible();
    await d.locator("#sp-desc").fill("Payment fails for every card.");
    await d.getByRole("radio", { name: "Critical" }).click();
    await d.getByLabel("Assignee").fill("payments@acme.test");
    await d.getByLabel("Labels").fill("checkout, p0");
    await d.getByText("Developer details").click();
    await expect(d.getByText("Stripe.js failed to load")).toBeVisible();
    await shot(page, "40-team");
    await d.getByRole("button", { name: "Send report" }).click();
    // Team mode checks for duplicates first.
    await expect(d.getByRole("heading", { name: "Others reported something similar" })).toBeVisible();
    await expect(d.getByText("Pay button does nothing.")).toBeVisible();
    await shot(page, "41-similar");
    await d.getByRole("button", { name: "Me too" }).click();
    await expect(d.getByRole("button", { name: "Added your +1" })).toBeVisible();
    await d.getByRole("button", { name: "Mine is different" }).click();
    await expect(d.getByTestId("spotter-ref")).toBeVisible();
    await shot(page, "42-team-sent");
    const list = await waitForIssues(page, 2);
    const team = list.find((i) => i.reporter.type === "team") ?? list[list.length - 1];
    expect(team.content.severity).toBe("critical");
    expect(team.content.fields["spotter.assignee"]).toBe("payments@acme.test");
    expect(team.content.fields["spotter.labels"]).toEqual(["checkout", "p0"]);
  });

  test("status badge: unread updates and an inline reply to a needs-info question", async ({ page }) => {
    await visit(page, "/");
    const ref = await fileReport(page, "Wishlist heart doesn't stay filled.");
    const [issue] = await waitForIssues(page, 1);
    expect(issue.ref).toBe(ref);
    const ask = await page.request.post("/api/test/ask", { data: { id: issue.id, question: "Which browser were you using, and were you signed in?" } });
    expect((await ask.json()).ok).toBe(true);

    await page.reload();
    const badge = page.locator("[data-spotter-part=statusHost] .sp-status-pill");
    await expect(badge).toBeVisible({ timeout: 20_000 });
    await expect(badge.locator(".sp-count")).toHaveText("1");
    await shot(page, "43-status-badge");
    await badge.click();
    const pop = page.locator("[data-spotter-part=statusHost] .sp-popover");
    await expect(pop.getByText("Needs info")).toBeVisible();
    await expect(pop.getByText("Which browser were you using")).toBeVisible();
    await shot(page, "44-status-popover");
    await pop.getByRole("textbox").fill("Safari 18 on macOS, signed in.");
    await pop.getByRole("button", { name: "Send reply" }).click();
    await expect(pop.getByText("Reply sent")).toBeVisible();
    await shot(page, "45-status-replied");
  });
});
