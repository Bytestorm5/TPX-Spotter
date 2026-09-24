import { describe, expect, it } from "vitest";
import { byteSize, mapStrings, safeSerialize, truncate, utf8Length } from "../../src/core/serialize.ts";
import { RingBuffer } from "../../src/core/buffer.ts";

describe("safeSerialize", () => {
  it("passes plain JSON through", () => {
    expect(safeSerialize({ a: 1, b: "x", c: [true, null] })).toEqual({ a: 1, b: "x", c: [true, null] });
  });

  it("handles circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    a.list = [a];
    expect(safeSerialize(a)).toEqual({ name: "a", self: "[Circular]", list: ["[Circular]"] });
  });

  it("re-serializes shared (non-circular) references", () => {
    const shared = { x: 1 };
    expect(safeSerialize({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("renders primitives that JSON can't hold", () => {
    expect(safeSerialize(undefined)).toBe("[undefined]");
    expect(safeSerialize(Number.NaN)).toBe("[NaN]");
    expect(safeSerialize(Infinity)).toBe("[Infinity]");
    expect(safeSerialize(-Infinity)).toBe("[-Infinity]");
    expect(safeSerialize(10n)).toBe("10n");
    expect(safeSerialize(Symbol("s"))).toBe("Symbol(s)");
    expect(safeSerialize(function named() {})).toBe("[Function: named]");
    expect(safeSerialize(() => {})).toBe("[Function]");
  });

  it("serializes errors with cause", () => {
    const err = new TypeError("bad", { cause: new Error("root") });
    const out = safeSerialize(err) as Record<string, unknown>;
    expect(out.name).toBe("TypeError");
    expect(out.message).toBe("bad");
    expect(typeof out.stack).toBe("string");
    expect((out.cause as Record<string, unknown>).message).toBe("root");
  });

  it("serializes Map, Set, Date, RegExp, typed arrays", () => {
    expect(safeSerialize(new Map([["k", 1]]))).toEqual({ "@type": "Map", entries: [["k", 1]] });
    expect(safeSerialize(new Set([1, 2]))).toEqual({ "@type": "Set", values: [1, 2] });
    expect(safeSerialize(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(safeSerialize(new Date(Number.NaN))).toBe("[Invalid Date]");
    expect(safeSerialize(/a+/g)).toBe("/a+/g");
    expect(safeSerialize(new Uint8Array(1024))).toBe("[Uint8Array(1024)]");
    expect(safeSerialize(new ArrayBuffer(8))).toBe("[ArrayBuffer(8)]");
    expect(safeSerialize(Promise.resolve())).toBe("[Promise]");
  });

  it("truncates huge strings at 8 KB with a marker", () => {
    const s = "x".repeat(10_000);
    const out = safeSerialize(s) as string;
    expect(out.startsWith("x".repeat(8192))).toBe(true);
    expect(out).toContain("[truncated 1808 chars]");
    expect(truncate("short", 10)).toBe("short");
  });

  it("caps depth, keys and array length", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(safeSerialize(deep, { maxDepth: 2 })).toEqual({ a: { b: "[Object]" } });
    const wide = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const out = safeSerialize(wide, { maxKeys: 3 }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["k0", "k1", "k2", "…"]);
    expect(safeSerialize([1, 2, 3, 4], { maxKeys: 2 })).toEqual([1, 2, "[… 2 more items]"]);
  });

  it("never throws on hostile objects", () => {
    const hostile = {
      ok: 1,
      get boom() {
        throw new Error("getter");
      },
    };
    expect(safeSerialize(hostile)).toEqual({ ok: 1, boom: "[Throws]" });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => safeSerialize(revoked.proxy)).not.toThrow();
    const badJson = { toJSON: () => {
      throw new Error("nope");
    } };
    expect(safeSerialize(badJson)).toBe("[Unserializable]");
  });

  it("bounds total work on huge graphs", () => {
    const big = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => ({ v: 1 })));
    const out = JSON.stringify(safeSerialize(big, { maxNodes: 50 }));
    expect(out.length).toBeLessThan(2000);
  });

  it("maps strings for redaction", () => {
    expect(mapStrings({ a: ["x", 1, { b: "y" }] }, (s) => s.toUpperCase())).toEqual({ a: ["X", 1, { b: "Y" }] });
  });

  it("measures UTF-8 bytes", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect(byteSize({ a: "é" })).toBe(JSON.stringify({ a: "é" }).length + 1);
  });
});

// @vitest-environment happy-dom is not needed for describeNode: fake nodes are enough.
describe("safeSerialize DOM-ish values", () => {
  it("renders element-like objects as tags", () => {
    const el = { nodeType: 1, nodeName: "DIV", id: "main", classList: ["a", "b"] };
    expect(safeSerialize(el)).toBe("<div#main.a.b>");
    expect(safeSerialize({ nodeType: 3, nodeName: "#text", data: "hi" })).toBe('#text "hi"');
    expect(safeSerialize({ nodeType: 9, nodeName: "#document" })).toBe("[Document]");
  });
});

describe("RingBuffer", () => {
  it("drops oldest by count", () => {
    const b = new RingBuffer<number>(3, 1e9, () => 1);
    for (let i = 0; i < 5; i++) b.push(i);
    expect(b.toArray()).toEqual([2, 3, 4]);
    expect(b.length).toBe(3);
    expect(b.bytes).toBe(3);
  });

  it("drops oldest by bytes", () => {
    const b = new RingBuffer<string>(100, 10, (s) => s.length);
    b.push("aaaa");
    b.push("bbbb");
    b.push("cccc");
    expect(b.toArray()).toEqual(["bbbb", "cccc"]);
    expect(b.bytes).toBe(8);
  });

  it("refuses an entry larger than the whole budget", () => {
    const b = new RingBuffer<string>(100, 10, (s) => s.length);
    b.push("ok");
    b.push("x".repeat(11));
    expect(b.toArray()).toEqual(["ok"]);
  });

  it("uses JSON byte size by default and survives compaction", () => {
    const b = new RingBuffer<{ v: number }>(10, 1e6);
    for (let i = 0; i < 500; i++) b.push({ v: i });
    expect(b.length).toBe(10);
    expect(b.toArray()[0]).toEqual({ v: 490 });
    expect(b.bytes).toBe(10 * byteSize({ v: 490 }));
    b.clear();
    expect(b.length).toBe(0);
    expect(b.bytes).toBe(0);
  });

  it("maxCount 0 keeps nothing", () => {
    const b = new RingBuffer<number>(0, 100);
    b.push(1);
    expect(b.length).toBe(0);
  });
});
