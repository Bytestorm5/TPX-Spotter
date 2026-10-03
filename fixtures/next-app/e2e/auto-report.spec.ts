import { expect, test, type Page } from "@playwright/test";
import { clearIssues, dialog, issues, shot, trigger, useVariant, visit, waitForIssues } from "./helpers";

const auto = (list: any[]) => list.filter((i) => i.context?.tags?.["spotter.auto"] === "true");

/** The engine, session and auto-report chunks load on idle after the trigger mounts. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__trusplexSpotter?.initialized === true);
  await page.waitForTimeout(1500);
}

async function waitForAuto(page: Page, n = 1): Promise<any[]> {
  let list: any[] = [];
  await expect
    .poll(
      async () => {
        list = auto(await issues(page));
        return list.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(n);
  return list;
}

test.describe("automatic reports", () => {
  test.beforeEach(async ({ page }) => {
    await useVariant(page, { sp_auto: "1" });
    await clearIssues(page);
  });

  test("an uncaught error files a detailed report on its own", async ({ page }) => {
    await visit(page, "/broken/crash");
    await settle(page);
    // Replay records from a quiet moment at least 2 s after load (an error before then is reported without one).
    await page.waitForTimeout(2500);
    await page.getByTestId("throw").click();
    const [issue] = await waitForAuto(page);
    await shot(page, "auto-01-after-crash");

    expect(issue.source).toBe("error");
    expect(issue.content.title).toMatch(/^TypeError: .*(lines|undefined)/);
    expect(issue.content.severity).toBe("error");
    expect(issue.content.description).toContain("Spotter filed this report automatically");
    expect(issue.content.description).toContain("**What happened**");
    expect(issue.page.routePattern).toBe("/broken/crash");
    expect(issue.context.tags).toMatchObject({ "spotter.auto": "true", "spotter.trigger": "error", "error.type": "TypeError", fixture: "next-app" });
    expect(issue.context.contexts.autoReport.trigger).toBe("error");
    expect(issue.context.contexts.autoReport.page.readyState).toBe("complete");
    // The error, parsed, with the steps that led up to it.
    expect(issue.signals.errors.some((e: any) => e.type === "TypeError" && e.frames.length > 0)).toBe(true);
    expect(issue.signals.breadcrumbs.some((b: any) => b.category === "click")).toBe(true);
    // Everything attached that a person-filed report gets.
    const kinds = issue.artifacts.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["screenshot", "replay", "dom_snapshot"]));
    expect(issue.environment.browser?.name).toBeTruthy();

    // It's silent: the visitor sees no Spotter UI and no entry in "my reports".
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__trusplexSpotter.myReports().length)).toBe(0);

    // The same crash again in this tab is the same problem: no second report.
    await page.getByTestId("throw").click();
    await page.waitForTimeout(2500);
    expect(auto(await issues(page))).toHaveLength(1);
  });

  test("a 502 is reported, an API 404 is not", async ({ page }) => {
    await visit(page, "/broken/crash");
    await settle(page);
    await page.getByTestId("missing-request").click();
    await expect(page.getByTestId("crash-status")).toHaveText("missing: 404");
    await page.waitForTimeout(2000);
    expect(auto(await issues(page))).toHaveLength(0);

    await page.getByTestId("fail-request").click();
    await expect(page.getByTestId("crash-status")).toHaveText("charge: 502");
    const [issue] = await waitForAuto(page);
    expect(issue.content.title).toBe("POST /api/charge responded 502 Bad Gateway");
    expect(issue.context.tags["http.status"]).toBe("502");
    const event = issue.context.contexts.autoReport.events[0];
    expect(event).toMatchObject({ kind: "network", method: "POST", status: 502 });
    expect(event.durationMs).toBeGreaterThan(0);
    const har = issue.signals.network.log.entries.find((e: any) => e.request.url.includes("/api/charge"));
    expect(har.response.status).toBe(502);
  });

  test("this site counts page 404s: a broken link is reported", async ({ page }) => {
    const res = await page.goto("/no-such-page");
    expect(res?.status()).toBe(404);
    const [issue] = await waitForAuto(page);
    expect(issue.context.tags["spotter.trigger"]).toBe("page");
    expect(issue.content.title).toBe("Page /no-such-page responded 404");
    expect(issue.content.severity).toBe("warning");
  });

  test("a server render error is reported from the server, and the error page from the browser", async ({ page }) => {
    const res = await page.goto("/broken/server");
    expect(res?.status()).toBe(500);
    const list = await waitForAuto(page, 2);
    await shot(page, "auto-02-server-error");
    const server = list.find((i) => i.source === "server");
    const browser = list.find((i) => i.source === "error");
    expect(server, JSON.stringify(list.map((i) => i.content.title))).toBeTruthy();
    expect(server.content.title).toBe("Error: Inventory service returned no data");
    expect(server.context.tags).toMatchObject({ "spotter.trigger": "server", "next.routePath": "/broken/server", "next.routeType": "render", "http.status": "500" });
    expect(server.context.contexts.exception.next.routerKind).toBe("App Router");
    expect(server.signals.errors.at(-1).frames.length).toBeGreaterThan(0);
    // The browser saw the 500 page.
    expect(browser.context.tags["spotter.trigger"]).toBe("page");
    expect(browser.content.title).toBe("Page /broken/server responded 500");
  });

  test("a throwing route handler: one report from each side, linked by session", async ({ page }) => {
    await visit(page, "/broken/crash");
    await settle(page);
    await page.getByTestId("server-error").click();
    await expect(page.getByTestId("crash-status")).toHaveText("explode: 500");
    const list = await waitForAuto(page, 2);
    const server = list.find((i) => i.source === "server");
    const browser = list.find((i) => i.source === "error");
    expect(server.content.title).toMatch(/^TypeError: /);
    expect(server.context.tags).toMatchObject({ "next.routePath": "/api/explode", "next.routeType": "route" });
    expect(browser.content.title).toBe("POST /api/explode responded 500 Internal Server Error");
    // The fetch carried the tab's session id, so the server report points at the browser session (and its replay).
    const sessionId = await page.evaluate(() => (window as any).__trusplexSpotter.sessionId);
    expect(server.trace.sessionId).toBe(sessionId);
    expect(browser.trace.sessionId).toBe(sessionId);
  });

  test("off unless configured", async ({ page }) => {
    await useVariant(page, {});
    await visit(page, "/broken/crash");
    await settle(page);
    await page.getByTestId("throw").click();
    await page.getByTestId("fail-request").click();
    await page.waitForTimeout(2500);
    expect(auto(await issues(page))).toHaveLength(0);
    await expect(trigger(page)).toBeVisible();
  });
});

test("the widget still files its own report next to automatic ones", async ({ page }) => {
  await useVariant(page, { sp_auto: "1" });
  await clearIssues(page);
  await visit(page, "/broken/crash");
  await settle(page);
  await page.getByTestId("fail-request").click();
  await waitForAuto(page);
  await trigger(page).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.locator("#sp-desc").fill("Paying fails every time.");
  await d.getByRole("button", { name: "Send report" }).click();
  await expect(d.getByTestId("spotter-ref")).toHaveText(/^SPT-\d+/);
  const all = await waitForIssues(page, 2);
  expect(all.map((i) => i.source).sort()).toEqual(["error", "widget"]);
});
