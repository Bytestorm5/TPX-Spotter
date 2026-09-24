// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { collectStorage } from "../../src/core/capture/storage.ts";
import { collectPage, domSnapshot } from "../../src/core/capture/page.ts";
import { collectEnvironment } from "../../src/core/capture/environment.ts";
import { setUrl, testRuntime } from "./helpers.ts";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const c of document.cookie.split(";")) {
    const k = c.split("=")[0]?.trim();
    if (k) document.cookie = `${k}=; Max-Age=0; Path=/`;
  }
  document.body.innerHTML = "";
  setUrl("https://app.example.com/orders/7?token=abc");
});

describe("collectStorage", () => {
  it("captures keys only, values for allowlisted keys, redacted", () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("auth", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh");
    localStorage.setItem("user:jane@x.io", "1");
    sessionStorage.setItem("cart", '{"email":"a@b.co"}');
    document.cookie = "consent=yes; Path=/";
    document.cookie = "sid=secret; Path=/";
    const rt = testRuntime();
    const snap = collectStorage(rt, ["theme", "cart", "cons*"]);
    expect(snap.localStorage).toEqual(
      expect.arrayContaining([{ key: "theme", value: "dark" }, { key: "auth" }, { key: "user:[redacted:email]" }]),
    );
    expect(snap.sessionStorage).toEqual([{ key: "cart", value: '{"email":"[redacted:email]"}' }]);
    expect(snap.cookies).toEqual(expect.arrayContaining([{ key: "consent", value: "yes" }, { key: "sid" }]));
  });

  it("never throws when storage is blocked", () => {
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      expect(collectStorage(testRuntime(), ["x"]).localStorage).toEqual([]);
    } finally {
      if (desc) Object.defineProperty(window, "localStorage", desc);
    }
  });
});

describe("collectPage / domSnapshot", () => {
  const html = `
    <main id="app">
      <section class="checkout">
        <h2>Payment for jane@example.com</h2>
        <form>
          <input id="card" name="card" value="4242424242424242">
          <input type="password" value="hunter2">
          <textarea>private note</textarea>
          <select><option value="a" selected>Alpha</option><option value="b">Beta</option></select>
          <p data-spotter-mask>Account 12345</p>
          <div data-spotter-block>blocked secret</div>
          <button id="pay" onclick="steal()">Pay now</button>
          <a href="/reset?token=zzz">reset</a>
          <script>var secret = 1;</script>
        </form>
      </section>
    </main>
    <div data-spotter-ui>Spotter panel</div>`;

  it("builds a masked, redacted excerpt around the element", () => {
    document.body.innerHTML = html;
    document.querySelector<HTMLInputElement>("#card")!.value = "4111111111111111";
    const rt = testRuntime();
    const page = collectPage(rt, { element: document.getElementById("pay")! });
    expect(page.selector).toBe("#pay");
    expect(page.url).toBe("https://app.example.com/orders/7?token=[redacted]");
    const ex = page.domExcerpt!;
    expect(ex).toContain('data-spotter-target=""');
    expect(ex).toContain("Pay now");
    expect(ex).not.toContain("4242424242424242");
    expect(ex).not.toContain("4111111111111111");
    expect(ex).not.toContain("hunter2");
    expect(ex).not.toContain("private note");
    expect(ex).not.toContain("12345");
    expect(ex).toContain("******* *****");
    expect(ex).not.toContain("blocked secret");
    expect(ex).toContain("data-spotter-blocked");
    expect(ex).not.toContain("onclick");
    expect(ex).not.toContain("steal");
    expect(ex).not.toContain("<script");
    expect(ex).not.toMatch(/selected/);
    expect(ex).toContain('href="/reset?token=[redacted]"');
    expect(ex).not.toContain("Spotter panel");
    expect(ex.length).toBeLessThanOrEqual(8 * 1024);
    expect(page.nearbyText).toContain("Pay now");
    expect(page.nearbyText).toContain("[redacted:email]");
    expect(page.nearbyText).not.toContain("blocked secret");
    expect(page.nearbyText).not.toContain("12345");
  });

  it("masks all text under maskText: all, except unmasked", () => {
    document.body.innerHTML = `<div><p id="t">Hello there</p><p data-spotter-unmask>Visible</p></div>`;
    const rt = testRuntime({ privacy: { maskText: "all" } });
    const page = collectPage(rt, { element: document.getElementById("t")! });
    expect(page.domExcerpt).toContain("***** *****");
    expect(page.domExcerpt).toContain("Visible");
  });

  it("returns only page facts without an element, and skips Spotter UI targets", () => {
    document.body.innerHTML = html;
    const rt = testRuntime();
    expect(collectPage(rt).selector).toBeUndefined();
    const ui = document.querySelector("[data-spotter-ui]")!;
    expect(collectPage(rt, { element: ui }).selector).toBeUndefined();
  });

  it("serializes a full masked snapshot", () => {
    document.head.innerHTML = `<title>Orders</title><style>.a{color:red}</style><script>track()</script>`;
    document.body.innerHTML = html;
    const snap = domSnapshot(testRuntime());
    expect(snap.startsWith("<!DOCTYPE html><html")).toBe(true);
    expect(snap).toContain(".a{color:red}");
    expect(snap).not.toContain("track()");
    expect(snap).not.toContain("hunter2");
    expect(snap).not.toContain("jane@example.com");
    expect(snap).not.toContain("Spotter panel");
    expect(domSnapshot(testRuntime(), { maxBytes: 200 }).endsWith("<!-- truncated -->")).toBe(true);
  });
});

describe("collectEnvironment in a browser", () => {
  it("fills viewport, screen, dpr, locale and network", () => {
    const env = collectEnvironment();
    expect(env.runtime).toBe("browser");
    expect(env.viewport?.width).toBeGreaterThan(0);
    expect(typeof env.dpr).toBe("number");
    expect(env.network?.online).toBe(true);
    expect(env.userAgent).toBeTruthy();
  });
});
