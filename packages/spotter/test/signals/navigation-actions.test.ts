// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNavigation, onNavigation } from "../../src/core/capture/navigation.ts";
import { installActions, isRageBurst } from "../../src/core/capture/actions.ts";
import { noteNetworkActivity } from "../../src/core/capture/network.ts";
import { finalizeCrumbs, finalizeNavigation } from "../../src/core/capture/finalize.ts";
import type { Signal } from "../../src/core/internal.ts";
import { setUrl, testRuntime, type TestRuntime } from "./helpers.ts";

let rt: TestRuntime;
const signals: Signal<unknown>[] = [];

beforeEach(() => {
  setUrl("https://app.example.com/start?token=abc");
  document.body.innerHTML = "";
  rt = testRuntime();
});
afterEach(() => {
  for (const s of signals.splice(0)) s.destroy();
  vi.useRealTimers();
});

describe("installNavigation", () => {
  it("records load, push, replace, pop and hash, with redacted URLs and history", () => {
    const listener = vi.fn();
    const off = onNavigation(listener);
    const sig = installNavigation(rt, { max: 3 });
    signals.push(sig);
    history.pushState({}, "", "/products/1?session=xyz");
    history.replaceState({}, "", "/products/1?tab=reviews");
    history.replaceState({}, "", "/products/1?tab=reviews"); // same URL: ignored
    history.pushState({}, "", "/cart");
    history.pushState({}, "", "/cart#summary");
    off();

    // Held raw; URLs are redacted when the session snapshots them.
    expect(sig.snapshot().entries[0]?.to).toBe("https://app.example.com/start?token=abc");
    const { entries, history: hist } = finalizeNavigation(sig.snapshot(), rt.redactor);
    expect(entries.map((e) => [e.kind, e.to])).toEqual([
      ["load", "https://app.example.com/start?token=[redacted]"],
      ["push", "https://app.example.com/products/1?session=[redacted]"],
      ["replace", "https://app.example.com/products/1?tab=reviews"],
      ["push", "https://app.example.com/cart"],
      ["hash", "https://app.example.com/cart#summary"],
    ]);
    expect(entries[1]?.from).toBe("https://app.example.com/start?token=[redacted]");
    expect(hist).toEqual(["https://app.example.com/products/1?tab=reviews", "https://app.example.com/cart", "https://app.example.com/cart#summary"]);
    expect(rt.navs).toHaveLength(5);
    expect(listener).toHaveBeenCalledTimes(5);
    expect(finalizeCrumbs(rt.crumbs, rt.redactor).filter((c) => c.category === "navigation").at(1)?.message).toBe("/start?token=[redacted] → /products/1?session=[redacted]");
  });

  it("records popstate, uses route patterns, and unpatches history", () => {
    rt.routePattern = (url) => (url?.includes("/blog/") ? "/blog/[slug]" : undefined);
    const push = history.pushState;
    const sig = installNavigation(rt, { max: 20 });
    history.pushState({}, "", "/blog/hello");
    expect(rt.navs.at(-1)?.routePattern).toBe("/blog/[slug]");
    setUrl("https://app.example.com/back");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(rt.navs.at(-1)?.kind).toBe("pop");
    sig.destroy();
    expect(history.pushState).toBe(push);
    history.pushState({}, "", "/after");
    expect(rt.navs.at(-1)?.to).not.toContain("/after");
  });
});

describe("installActions", () => {
  const click = (el: Element, x = 10, y = 10) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: x, clientY: y }));

  it("records clicks with selector, redacted label and coordinates", () => {
    document.body.innerHTML = `<button id="pay"><span>Pay jane@x.io</span></button>`;
    signals.push(installActions(rt));
    click(document.querySelector("span")!, 40, 50);
    const c = finalizeCrumbs(rt.crumbs, rt.redactor).find((x) => x.category === "click");
    expect(c).toMatchObject({ selector: "#pay", message: 'Clicked "Pay [redacted:email]"' });
    expect(c).not.toHaveProperty("label");
    expect(c?.data).toMatchObject({ x: 40, y: 50 });
    expect(c?.data).toHaveProperty("docWidth");
    expect(c?.data).toHaveProperty("docHeight");
  });

  it("does not label masked elements", () => {
    document.body.innerHTML = `<div data-spotter-mask><button id="acct">Account 12345</button></div>`;
    signals.push(installActions(rt));
    click(document.getElementById("acct")!);
    expect(rt.crumbs[0]?.message).toBe("Clicked #acct");
  });

  it("never records input values", () => {
    document.body.innerHTML = `<input id="email" type="email" name="email" value="">`;
    signals.push(installActions(rt));
    const input = document.getElementById("email") as HTMLInputElement;
    input.value = "secret@example.com";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const crumbs = rt.crumbs.filter((c) => c.category === "input");
    expect(crumbs).toHaveLength(1); // one per burst
    expect(JSON.stringify(crumbs)).not.toContain("secret@example.com");
    expect(crumbs[0]).toMatchObject({ selector: "#email", data: { type: "email" } });
  });

  it("ignores events from Spotter's UI, including inside shadow roots", () => {
    const host = document.createElement("div");
    host.setAttribute("data-spotter-ui", "");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button>Send report</button>`;
    signals.push(installActions(rt));
    click(root.querySelector("button")!);
    expect(rt.crumbs).toEqual([]);
  });

  it("detects rage clicks once per burst", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    signals.push(installActions(rt));
    const b = document.getElementById("b")!;
    for (let i = 0; i < 5; i++) {
      rt.clock.t += 100;
      click(b, 100 + i, 100);
    }
    const rage = rt.crumbs.filter((c) => c.category === "rage_click");
    expect(rage).toHaveLength(1);
    expect(rage[0]?.data).toMatchObject({ x: 102, y: 100 });
    expect(isRageBurst([{ t: 0, x: 0, y: 0 }, { t: 500, x: 100, y: 0 }, { t: 900, x: 0, y: 5 }], 900)).toBe(false);
  });

  it("detects dead clicks: no mutation, no request within 1 s", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<button id="dead">Nothing</button><button id="live">Live</button><button id="net">Net</button>`;
    signals.push(installActions(rt));
    click(document.getElementById("dead")!);
    vi.advanceTimersByTime(1100);
    expect(rt.crumbs.filter((c) => c.category === "dead_click").map((c) => c.selector)).toEqual(["#dead"]);

    click(document.getElementById("live")!);
    document.body.appendChild(document.createElement("p"));
    await Promise.resolve(); // MutationObserver microtask
    vi.advanceTimersByTime(1100);

    click(document.getElementById("net")!);
    noteNetworkActivity();
    vi.advanceTimersByTime(1100);
    expect(rt.crumbs.filter((c) => c.category === "dead_click")).toHaveLength(1);
  });

  it("detects error clicks", () => {
    document.body.innerHTML = `<button id="b">Save</button>`;
    signals.push(installActions(rt));
    click(document.getElementById("b")!);
    rt.clock.t += 200;
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("x"), message: "x" }));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("y"), message: "y" }));
    const ec = rt.crumbs.filter((c) => c.category === "error_click");
    expect(ec).toHaveLength(1);
    expect(ec[0]?.selector).toBe("#b");
  });

  it("removes its listeners on destroy", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const sig = installActions(rt);
    sig.destroy();
    click(document.getElementById("b")!);
    expect(rt.crumbs).toEqual([]);
  });
});
