// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installConsole, runUncaptured } from "../../src/core/capture/console.ts";
import { installErrors } from "../../src/core/capture/errors.ts";
import { finalizeConsole, finalizeCrumbs } from "../../src/core/capture/finalize.ts";
import { errorEntryFrom, finalizeError, parseStack } from "../../src/core/capture/stack.ts";
import { LABEL } from "../../src/core/internal.ts";
import { testRuntime } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("installConsole", () => {
  it("captures levels with serialized, redacted args and leaves output working", () => {
    const rt = testRuntime();
    const originalLog = console.log;
    const spy = vi.fn();
    console.log = spy;
    try {
      const sig = installConsole(rt, { max: 10 });
      const arg = { email: "a@b.co", n: 1 };
      console.log("user", arg);
      expect(spy).toHaveBeenCalledWith("user", { email: "a@b.co", n: 1 }); // host output untouched
      arg.n = 2; // copied at call time: a later mutation doesn't change the record
      // Held raw; serialized and redacted at snapshot time.
      const [entry] = finalizeConsole(sig.snapshot(), rt.redactor);
      expect(entry?.level).toBe("log");
      expect(entry?.args).toEqual(["user", { email: "[redacted:email]", n: 1 }]);
      expect(entry?.stack).toBeUndefined();
      sig.destroy();
      expect(console.log).toBe(spy);
    } finally {
      console.log = originalLog;
    }
  });

  it("adds stacks and breadcrumbs for warn/error", () => {
    const rt = testRuntime();
    const original = console.error;
    console.error = () => {};
    try {
      const sig = installConsole(rt, { max: 10 });
      console.error("boom", new Error("x"));
      const [entry] = sig.snapshot();
      expect(entry?.level).toBe("error");
      expect(typeof entry?.stack).toBe("string");
      expect(entry?.stack).not.toContain("spotterConsole");
      expect(rt.crumbs.at(-1)).toMatchObject({ category: "console", level: "error", message: "boom" });
      sig.destroy();
    } finally {
      console.error = original;
    }
  });

  it("is bounded by count", () => {
    const rt = testRuntime();
    const original = console.info;
    console.info = () => {};
    try {
      const sig = installConsole(rt, { max: 3 });
      for (let i = 0; i < 10; i++) console.info(i);
      expect(sig.snapshot().map((e) => e.args[0])).toEqual([7, 8, 9]);
      sig.destroy();
    } finally {
      console.info = original;
    }
  });

  it("never captures Spotter's own output or recurses", () => {
    const rt = testRuntime();
    const original = console.warn;
    console.warn = () => {};
    try {
      // A breadcrumb sink that logs would recurse without the guard.
      rt.breadcrumb = () => console.warn("from inside");
      const sig = installConsole(rt, { max: 10 });
      console.warn("[spotter] dev warning");
      runUncaptured(() => console.warn("uncaptured"));
      console.warn("host");
      expect(sig.snapshot().map((e) => e.args[0])).toEqual(["host"]);
      sig.destroy();
    } finally {
      console.warn = original;
    }
  });

  it("becomes a pass-through when someone wrapped after us", () => {
    const rt = testRuntime();
    const original = console.debug;
    const base = vi.fn();
    console.debug = base;
    try {
      const sig = installConsole(rt, { max: 10 });
      const ours = console.debug;
      const theirs = (...a: unknown[]) => ours(...a);
      console.debug = theirs;
      sig.destroy();
      expect(console.debug).toBe(theirs); // not clobbered
      console.debug("still works");
      expect(base).toHaveBeenCalledWith("still works");
      expect(sig.snapshot()).toEqual([]);
    } finally {
      console.debug = original;
    }
  });

  it("faults (and disables) instead of throwing into the host", () => {
    const rt = testRuntime();
    rt.now = () => {
      throw new Error("clock broke");
    };
    const original = console.log;
    const spy = vi.fn();
    console.log = spy;
    try {
      const sig = installConsole(rt, { max: 10 });
      expect(() => console.log("x")).not.toThrow();
      expect(spy).toHaveBeenCalled();
      expect(rt.faults[0]?.signal).toBe("console");
      sig.destroy();
    } finally {
      console.log = original;
    }
  });
});

describe("parseStack", () => {
  it("parses V8 frames", () => {
    const stack = [
      "TypeError: x is undefined",
      "    at handleClick (https://app.example.com/_next/static/chunks/app.js:10:25)",
      "    at async Promise.all (index 0)",
      "    at https://app.example.com/main.js:1:200",
      "    at new Widget (webpack-internal:///./src/widget.ts:4:9)",
      "    at eval (eval at run (https://app.example.com/a.js:3:4), <anonymous>:1:1)",
      "    at Array.map (<anonymous>)",
    ].join("\n");
    expect(parseStack(stack)).toEqual([
      { function: "handleClick", file: "https://app.example.com/_next/static/chunks/app.js", line: 10, column: 25 },
      { function: "Promise.all" },
      { file: "https://app.example.com/main.js", line: 1, column: 200 },
      { function: "new Widget", file: "webpack-internal:///./src/widget.ts", line: 4, column: 9 },
      { function: "eval", file: "https://app.example.com/a.js", line: 3, column: 4 },
      { function: "Array.map", file: "<anonymous>" },
    ]);
  });

  it("parses SpiderMonkey frames", () => {
    const stack = [
      "handleClick@https://app.example.com/app.js:10:25",
      "@https://app.example.com/main.js:1:200",
      "run@https://app.example.com/a.js line 3 > eval:1:1",
      "",
    ].join("\n");
    expect(parseStack(stack)).toEqual([
      { function: "handleClick", file: "https://app.example.com/app.js", line: 10, column: 25 },
      { file: "https://app.example.com/main.js", line: 1, column: 200 },
      { function: "run", file: "https://app.example.com/a.js", line: 3 },
    ]);
  });

  it("parses JavaScriptCore frames", () => {
    const stack = ["handleClick@https://cdn.example.com/pkg@1.2.0/app.js:10:25", "forEach@[native code]", "global code@https://app.example.com/:5:3"].join("\n");
    expect(parseStack(stack)).toEqual([
      { function: "handleClick", file: "https://cdn.example.com/pkg@1.2.0/app.js", line: 10, column: 25 },
      { function: "forEach", file: "[native code]" },
      { function: "global code", file: "https://app.example.com/", line: 5, column: 3 },
    ]);
  });

  it("returns nothing for junk", () => {
    expect(parseStack("")).toEqual([]);
    expect(parseStack("just a message")).toEqual([]);
  });
});

describe("errorEntryFrom", () => {
  it("normalizes Errors, strings and objects", () => {
    const e = errorEntryFrom(new RangeError("too big"), "captured", undefined, 0);
    expect(e).toMatchObject({ type: "RangeError", message: "too big", mechanism: "captured", at: "1970-01-01T00:00:00.000Z" });
    expect(e.frames.length).toBeGreaterThan(0);
    expect(errorEntryFrom("plain", "uncaught")).toMatchObject({ type: "Error", message: "plain", frames: [] });
    expect(errorEntryFrom({ code: 42 }, "unhandledrejection").message).toBe('Non-Error thrown: {"code":42}');
    expect(errorEntryFrom(null, "unhandledrejection").message).toBe("Non-Error thrown: null");
  });

  it("folds cause and component stacks, and redacts", () => {
    const err = Object.assign(new Error("for a@b.co", { cause: new Error("root cause") }), { componentStack: "\n    at Checkout" });
    const e = errorEntryFrom(err, "boundary", (v) => v.replace(/a@b\.co/g, "[redacted:email]"));
    expect(e.message).toBe("for [redacted:email]");
    expect(e.stack).toContain("Caused by: Error: root cause");
    expect(e.componentStack).toContain("Checkout");
  });
});

describe("installErrors", () => {
  it("captures uncaught errors and rejections once, with breadcrumbs and rt.error", () => {
    const rt = testRuntime();
    const sig = installErrors(rt);
    cleanups.push(() => sig.destroy());
    const error = new Error("kaput");
    window.dispatchEvent(new ErrorEvent("error", { error, message: "kaput" }));
    window.dispatchEvent(new ErrorEvent("error", { error, message: "kaput" })); // duplicate object
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new TypeError("async fail");
    window.dispatchEvent(rejection);
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", filename: "https://cdn/x.js", lineno: 1, colno: 2 }));

    const entries = sig.snapshot();
    expect(entries.map((e) => [e.type, e.message, e.mechanism])).toEqual([
      ["Error", "kaput", "uncaught"],
      ["TypeError", "async fail", "unhandledrejection"],
      ["Error", "Script error.", "uncaught"],
    ]);
    expect(entries[2]?.frames).toEqual([{ file: "https://cdn/x.js", line: 1, column: 2 }]);
    expect(rt.errors).toHaveLength(3);
    expect(rt.crumbs.filter((c) => c.category === "error")).toHaveLength(3);

    sig.destroy();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("after"), message: "after" }));
    expect(rt.errors).toHaveLength(3);
  });

  it("ignores resource load errors", () => {
    const rt = testRuntime();
    const sig = installErrors(rt);
    cleanups.push(() => sig.destroy());
    const img = document.createElement("img");
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error"));
    expect(sig.snapshot()).toEqual([]);
  });
});

describe("snapshot-time finishing", () => {
  it("serializes and redacts raw errors, from a copy taken when they were thrown", () => {
    const rt = testRuntime();
    const sig = installErrors(rt);
    cleanups.push(() => sig.destroy());
    const thrown = { user: "a@b.co" };
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = thrown;
    window.dispatchEvent(rejection);
    thrown.user = "changed later";
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("for a@b.co"), message: "for a@b.co" }));
    const [a, b] = sig.snapshot().map((e) => finalizeError(e, rt.redactor.redact));
    expect(a?.message).toBe('Non-Error thrown: {"user":"[redacted:email]"}');
    expect(b?.message).toBe("for [redacted:email]");
    expect(b?.stack).not.toContain("a@b.co");
    expect(b?.frames.length).toBeGreaterThan(0);
  });

  it("finishes raw breadcrumbs: serialized console args, caps, redacted labels and URLs", () => {
    const rt = testRuntime();
    const [con, err, click, net] = finalizeCrumbs(
      [
        { at: "t", category: "console", level: "warning", message: "", value: { card: "4111 1111 1111 1111" }, max: 200 },
        { at: "t", category: "error", level: "error", message: `Error: ${"x".repeat(500)}`, max: 200 },
        { at: "t", category: "click", message: `Clicked "${LABEL}"`, label: `mail jane@x.io ${"y".repeat(100)}`, selector: "#b" },
        { at: "t", category: "network", message: "GET /api?token=abc 500", data: { url: "https://a.com/api?token=abc", status: 500 } },
      ],
      rt.redactor,
    );
    expect(con?.message).toBe('{"card":"[redacted:card]"}');
    expect(con).not.toHaveProperty("value");
    expect(err?.message.startsWith(`Error: ${"x".repeat(193)}…[truncated`)).toBe(true);
    expect(click?.message).toMatch(/^Clicked "mail \[redacted:email\] y+…\[truncated \d+ chars\]"$/);
    expect(click).not.toHaveProperty("label");
    expect(net).toMatchObject({ message: "GET /api?token=[redacted] 500", data: { url: "https://a.com/api?token=[redacted]", status: 500 } });
  });
});
