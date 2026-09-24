// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { cssSelector } from "../../src/core/selector.ts";
import { isTextMasked, maskRules, placeholder, validSelectors, isSensitiveInput } from "../../src/core/capture/mask.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("cssSelector", () => {
  it("prefers a stable id", () => {
    document.body.innerHTML = `<div><button id="pay">Pay</button></div>`;
    expect(cssSelector(document.getElementById("pay")!)).toBe("#pay");
  });

  it("skips generated ids and uses data-testid / data-spotter-id", () => {
    document.body.innerHTML = `<button id=":r1:" data-testid="submit">Go</button><a data-spotter-id="nav-home">Home</a>`;
    expect(cssSelector(document.querySelector("button")!)).toBe('[data-testid="submit"]');
    expect(cssSelector(document.querySelector("a")!)).toBe('[data-spotter-id="nav-home"]');
    document.body.innerHTML = `<div id="radix-12"><span id="mui-3485">x</span></div>`;
    expect(cssSelector(document.querySelector("span")!)).not.toContain("mui-3485");
  });

  it("falls back to a short unique nth-of-type path anchored on an ancestor", () => {
    document.body.innerHTML = `<main id="app"><ul><li>a</li><li>b</li><li><span>c</span></li></ul></main>`;
    const span = document.querySelectorAll("span")[0]!;
    const sel = cssSelector(span);
    expect(document.querySelectorAll(sel)).toHaveLength(1);
    expect(document.querySelector(sel)).toBe(span);
    const li = document.querySelectorAll("li")[1]!;
    const liSel = cssSelector(li);
    expect(liSel).toContain("li:nth-of-type(2)");
    expect(document.querySelector(liSel)).toBe(li);
  });

  it("caps depth on deep trees", () => {
    let html = "";
    for (let i = 0; i < 20; i++) html += "<div><div>";
    html += "<b>x</b><b>y</b>";
    for (let i = 0; i < 20; i++) html += "</div></div>";
    document.body.innerHTML = html;
    const sel = cssSelector(document.querySelectorAll("b")[1]!);
    expect(sel.split(" > ").length).toBeLessThanOrEqual(5);
  });

  it("describes elements in shadow roots with the host prefix", () => {
    const host = document.createElement("x-widget");
    host.id = "widget";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button data-testid="inner">b</button>`;
    expect(cssSelector(root.querySelector("button")!)).toBe('#widget >>> [data-testid="inner"]');
  });
});

describe("mask rules", () => {
  it("nearest of mask/unmask wins; maskText all masks by default", () => {
    document.body.innerHTML = `
      <p id="plain">hi</p>
      <div data-spotter-mask><p id="m">secret</p><div data-spotter-unmask><p id="mu">open</p></div></div>
      <div data-spotter-unmask><p id="u">shown</p><span class="pii" id="cls">x</span></div>`;
    const inputs = maskRules({ maskText: "inputs", maskSelectors: [".pii"] });
    const all = maskRules({ maskText: "all" });
    const $ = (id: string) => document.getElementById(id);
    expect(isTextMasked($("plain"), inputs)).toBe(false);
    expect(isTextMasked($("m"), inputs)).toBe(true);
    expect(isTextMasked($("mu"), inputs)).toBe(false);
    expect(isTextMasked($("cls"), inputs)).toBe(true);
    expect(isTextMasked($("plain"), all)).toBe(true);
    expect(isTextMasked($("u"), all)).toBe(false);
  });

  it("drops invalid selectors instead of breaking masking", () => {
    expect(validSelectors([".ok", "::::bad", "", "[data-x]"])).toEqual([".ok", "[data-x]"]);
    const rules = maskRules({ blockSelectors: ["::::bad", ".ad"] });
    expect(rules.block).toBe("[data-spotter-block],[data-spotter-ui],.ad");
  });

  it("placeholders keep length and whitespace", () => {
    expect(placeholder("Jane Doe\nx")).toBe("**** ***\n*");
  });

  it("flags password / card / otp inputs as sensitive", () => {
    document.body.innerHTML = `<input type="password"><input autocomplete="cc-number"><input autocomplete="one-time-code"><input type="text">`;
    const [pw, cc, otp, text] = Array.from(document.querySelectorAll("input"));
    expect(isSensitiveInput(pw!)).toBe(true);
    expect(isSensitiveInput(cc!)).toBe(true);
    expect(isSensitiveInput(otp!)).toBe(true);
    expect(isSensitiveInput(text!)).toBe(false);
  });
});
