import { describe, expect, it } from "vitest";
import {
  arrowHead,
  blurBlockSize,
  canRedo,
  canUndo,
  commit,
  createHistory,
  exportShapes,
  initialSelection,
  isMeaningful,
  MAX_HISTORY,
  moveSelection,
  nextPinNumber,
  normalizeRect,
  pixelate,
  pressureToWidth,
  redo,
  shapeFromSelection,
  simplifyStroke,
  toImagePoint,
  undo,
  type Shape,
} from "../../src/ui/next/annotate/model.ts";
import { applyBlurs, drawShapes, renderAnnotated } from "../../src/ui/next/annotate/render.ts";

const rect = (id: number): Shape => ({ id, tool: "rect", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: "#e5484d" });

describe("history", () => {
  it("undoes and redoes in order", () => {
    let h = createHistory();
    h = commit(h, [rect(1)]);
    h = commit(h, [rect(1), rect(2)]);
    expect(h.present.map((s) => s.id)).toEqual([1, 2]);
    h = undo(h);
    expect(h.present.map((s) => s.id)).toEqual([1]);
    expect(canRedo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h); // no-op at the start
    h = redo(redo(h));
    expect(h.present.map((s) => s.id)).toEqual([1, 2]);
    expect(redo(h)).toBe(h);
  });

  it("drops the redo branch on a new edit", () => {
    let h = commit(commit(createHistory(), [rect(1)]), [rect(1), rect(2)]);
    h = undo(h);
    h = commit(h, [rect(1), rect(3)]);
    expect(canRedo(h)).toBe(false);
    expect(h.present.map((s) => s.id)).toEqual([1, 3]);
  });

  it("caps its length", () => {
    let h = createHistory();
    for (let i = 0; i < MAX_HISTORY + 20; i++) h = commit(h, [rect(i)]);
    expect(h.past.length).toBe(MAX_HISTORY);
  });
});

describe("geometry", () => {
  it("maps client points into screenshot pixels and clamps", () => {
    const box = { left: 100, top: 50, width: 400, height: 250 };
    const img = { width: 1600, height: 1000 };
    expect(toImagePoint({ x: 300, y: 175 }, box, img)).toEqual({ x: 800, y: 500 });
    expect(toImagePoint({ x: 0, y: 0 }, box, img)).toEqual({ x: 0, y: 0 });
    expect(toImagePoint({ x: 9999, y: 9999 }, box, img)).toEqual({ x: 1600, y: 1000 });
  });

  it("normalizes drags in any direction", () => {
    expect(normalizeRect({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it("builds an arrowhead ending at the tip, symmetric about the shaft", () => {
    const [tip, l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(tip).toEqual({ x: 100, y: 0 });
    expect(l.x).toBeLessThan(100);
    expect(l.y).toBeCloseTo(-r.y);
  });

  it("numbers pins after the highest existing one", () => {
    const pins: Shape[] = [
      { id: 1, tool: "pin", points: [{ x: 1, y: 1 }], label: "1" },
      { id: 2, tool: "pin", points: [{ x: 1, y: 1 }], label: "4" },
    ];
    expect(nextPinNumber([])).toBe(1);
    expect(nextPinNumber(pins)).toBe(5);
  });

  it("ignores accidental clicks with drag tools", () => {
    expect(isMeaningful({ tool: "rect", points: [{ x: 5, y: 5 }, { x: 6, y: 6 }] })).toBe(false);
    expect(isMeaningful({ tool: "rect", points: [{ x: 5, y: 5 }, { x: 40, y: 6 }] })).toBe(true);
    expect(isMeaningful({ tool: "pin", points: [{ x: 5, y: 5 }] })).toBe(true);
    expect(isMeaningful({ tool: "freehand", points: [{ x: 5, y: 5 }] })).toBe(false);
  });

  it("maps stylus pressure to width, mouse to 1x", () => {
    expect(pressureToWidth(0.5, "mouse")).toBe(1);
    expect(pressureToWidth(0, "pen")).toBe(1);
    expect(pressureToWidth(1, "pen")).toBeCloseTo(1.75);
    expect(pressureToWidth(0.1, "pen")).toBeCloseTo(0.4);
  });

  it("simplifies strokes but keeps the endpoints", () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: i * 0.1, y: 0 }));
    const out = simplifyStroke(pts, 1.5);
    expect(out.length).toBeLessThan(20);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("exports schema shapes with integer points and no editor fields", () => {
    const out = exportShapes([
      { id: 9, tool: "freehand", points: [{ x: 1.4, y: 2.6 }, { x: 3, y: 4 }], color: "#0090ff", widths: [1, 1.2] },
      { id: 10, tool: "blur", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: "#e5484d" },
      { id: 11, tool: "pin", points: [{ x: 7, y: 7 }], color: "#e5484d", label: "1" },
    ]);
    expect(out[0]).toEqual({ tool: "freehand", points: [{ x: 1, y: 3 }, { x: 3, y: 4 }], color: "#0090ff" });
    expect(out[1]).toEqual({ tool: "blur", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
    expect(out[2]).toMatchObject({ tool: "pin", label: "1" });
    expect(out[0]).not.toHaveProperty("id");
  });
});

describe("keyboard region selection", () => {
  const img = { width: 1000, height: 500 };

  it("starts centred and moves in 2% steps, clamped to the image", () => {
    const s = initialSelection(img);
    expect(s.x + s.width / 2).toBeCloseTo(500, -1);
    const moved = moveSelection(s, "ArrowRight", { resize: false, fine: false }, img);
    expect(moved.x - s.x).toBe(10);
    let far = s;
    for (let i = 0; i < 200; i++) far = moveSelection(far, "ArrowLeft", { resize: false, fine: false }, img);
    expect(far.x).toBe(0);
    for (let i = 0; i < 200; i++) far = moveSelection(far, "ArrowDown", { resize: false, fine: false }, img);
    expect(far.y + far.height).toBe(500);
  });

  it("resizes with Shift, never below a minimum or past the edge", () => {
    const s = initialSelection(img);
    const bigger = moveSelection(s, "ArrowRight", { resize: true, fine: false }, img);
    expect(bigger.width).toBe(s.width + 10);
    expect(bigger.x).toBe(s.x);
    let small = s;
    for (let i = 0; i < 200; i++) small = moveSelection(small, "ArrowUp", { resize: true, fine: true }, img);
    expect(small.height).toBeGreaterThanOrEqual(4);
    let wide = s;
    for (let i = 0; i < 200; i++) wide = moveSelection(wide, "ArrowRight", { resize: true, fine: false }, img);
    expect(wide.x + wide.width).toBe(1000);
  });

  it("commits the selection as the current tool's shape", () => {
    const sel = { x: 100, y: 100, width: 200, height: 100 };
    expect(shapeFromSelection(sel, "rect", 1, "#e5484d", [])?.points).toEqual([{ x: 100, y: 100 }, { x: 300, y: 200 }]);
    expect(shapeFromSelection(sel, "pin", 2, "#e5484d", [])?.label).toBe("1");
    expect(shapeFromSelection(sel, "pin", 2, "#e5484d", [])?.points).toEqual([{ x: 200, y: 150 }]);
    expect(shapeFromSelection(sel, "arrow", 3, "#e5484d", [])?.points[1]).toEqual({ x: 200, y: 150 });
    expect(shapeFromSelection(sel, "text", 4, "#e5484d", [])).toBeNull();
    expect(shapeFromSelection(sel, "text", 4, "#e5484d", [], "Here")?.label).toBe("Here");
    expect(shapeFromSelection(sel, "freehand", 5, "#e5484d", [])?.points.length).toBe(33);
  });
});

describe("pixelation (blur / redact)", () => {
  function gradient(w: number, h: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        d[i] = x * 7;
        d[i + 1] = y * 5;
        d[i + 2] = (x * y) % 255;
        d[i + 3] = 255;
      }
    return d;
  }

  it("replaces each block with its average so the original pixels are gone", () => {
    const w = 32;
    const h = 32;
    const data = gradient(w, h);
    const before = data.slice();
    pixelate(data, w, h, { x: 8, y: 8, width: 16, height: 16 }, 8);
    // Inside: every block uniform.
    for (const [bx, by] of [
      [8, 8],
      [16, 16],
    ]) {
      const first = (by! * w + bx!) * 4;
      for (let y = by!; y < by! + 8; y++)
        for (let x = bx!; x < bx! + 8; x++) {
          const i = (y * w + x) * 4;
          expect([data[i], data[i + 1], data[i + 2]]).toEqual([data[first], data[first + 1], data[first + 2]]);
        }
    }
    // Changed inside, untouched outside.
    let changed = 0;
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) if (data[(y * w + x) * 4] !== before[(y * w + x) * 4]) changed++;
    expect(changed).toBeGreaterThan(200);
    for (const [x, y] of [
      [0, 0],
      [31, 31],
      [7, 20],
      [24, 3],
    ])
      expect(data[(y! * w + x!) * 4]).toBe(before[(y! * w + x!) * 4]);
  });

  it("clips regions to the image", () => {
    const data = gradient(10, 10);
    expect(() => pixelate(data, 10, 10, { x: -5, y: -5, width: 100, height: 100 }, 4)).not.toThrow();
  });

  it("uses blocks big enough to defeat reading text", () => {
    expect(blurBlockSize({ width: 390, height: 844 })).toBeGreaterThanOrEqual(8);
    expect(blurBlockSize({ width: 3840, height: 2160 })).toBeGreaterThanOrEqual(36);
  });
});

/** A 2D context stand-in that records calls and keeps a real pixel buffer. */
function fakeContext(w: number, h: number) {
  const pixels = new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) % 256));
  const calls: string[] = [];
  const ctx = new Proxy(
    {
      pixels,
      calls,
      getImageData(x: number, y: number, cw: number, ch: number) {
        const data = new Uint8ClampedArray(cw * ch * 4);
        for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) for (let k = 0; k < 4; k++) data[(yy * cw + xx) * 4 + k] = pixels[((y + yy) * w + x + xx) * 4 + k]!;
        return { data, width: cw, height: ch };
      },
      putImageData(img: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
        calls.push("putImageData");
        for (let yy = 0; yy < img.height; yy++)
          for (let xx = 0; xx < img.width; xx++) for (let k = 0; k < 4; k++) pixels[((y + yy) * w + x + xx) * 4 + k] = img.data[(yy * img.width + xx) * 4 + k]!;
      },
      measureText: (s: string) => ({ width: s.length * 8 }),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          calls.push(prop);
          void args;
        };
      },
      set(target, prop: string, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  return ctx as unknown as CanvasRenderingContext2D & { pixels: Uint8ClampedArray; calls: string[] };
}

describe("flattening", () => {
  it("burns blur regions into the pixels and draws every other shape on top", () => {
    const ctx = fakeContext(64, 64);
    const before = ctx.pixels.slice();
    const shapes: Shape[] = [
      { id: 1, tool: "blur", points: [{ x: 0, y: 0 }, { x: 32, y: 32 }] },
      { id: 2, tool: "rect", points: [{ x: 40, y: 40 }, { x: 60, y: 60 }], color: "#e5484d" },
      { id: 3, tool: "arrow", points: [{ x: 5, y: 60 }, { x: 30, y: 40 }], color: "#e5484d" },
      { id: 4, tool: "pin", points: [{ x: 50, y: 10 }], color: "#e5484d", label: "1" },
      { id: 5, tool: "text", points: [{ x: 34, y: 20 }], color: "#18181b", label: "Here" },
      { id: 6, tool: "freehand", points: [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 2 }], color: "#0090ff" },
    ];
    renderAnnotated(ctx, {} as CanvasImageSource, shapes, { width: 64, height: 64 });
    expect(ctx.calls[0]).toBe("clearRect");
    expect(ctx.calls[1]).toBe("drawImage");
    expect(ctx.calls).toContain("putImageData");
    // Blur happens before strokes, so annotations stay crisp above redaction.
    expect(ctx.calls.indexOf("putImageData")).toBeLessThan(ctx.calls.indexOf("stroke"));
    expect(ctx.calls).toContain("fillText"); // pin number + text label
    let changed = 0;
    for (let i = 0; i < 32 * 64 * 4; i++) if (ctx.pixels[i] !== before[i]) changed++;
    expect(changed).toBeGreaterThan(1000);
    // Outside the blur region the base pixels are untouched by the pixel pass.
    expect(ctx.pixels[(63 * 64 + 63) * 4]).toBe(before[(63 * 64 + 63) * 4]);
  });

  it("outlines blur regions only in the live view", () => {
    const live = fakeContext(16, 16);
    drawShapes(live, [{ id: 1, tool: "blur", points: [{ x: 0, y: 0 }, { x: 8, y: 8 }] }], { width: 16, height: 16 }, { showBlurOutline: true });
    expect(live.calls).toContain("strokeRect");
    const exported = fakeContext(16, 16);
    applyBlurs(exported, [{ id: 1, tool: "blur", points: [{ x: 0, y: 0 }, { x: 8, y: 8 }] }], { width: 16, height: 16 });
    drawShapes(exported, [{ id: 1, tool: "blur", points: [{ x: 0, y: 0 }, { x: 8, y: 8 }] }], { width: 16, height: 16 });
    expect(exported.calls).not.toContain("strokeRect");
  });
});
