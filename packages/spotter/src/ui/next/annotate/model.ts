/**
 * The annotation model: shapes in screenshot pixel space, an undo/redo
 * history, and the geometry the canvas and the keyboard alternative share.
 *
 * Everything here is pure (no DOM), so geometry, history and pixelation are
 * unit-tested directly; `render.ts` draws the result onto a 2D context.
 *
 * Coordinates are always screenshot pixels, never CSS pixels: the canvas is
 * displayed scaled to fit, and `toImagePoint` converts pointer positions. The
 * exported `AnnotationShape`s therefore line up with the uploaded screenshot
 * whatever size the reporter's panel was.
 */
import type { AnnotationShape } from "../../../core/schema.ts";

export type Tool = AnnotationShape["tool"];
export const TOOLS: readonly Tool[] = ["rect", "arrow", "freehand", "text", "pin", "blur"];

/** Single-key shortcuts (no modifier, only while the canvas has focus). */
export const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  r: "rect",
  a: "arrow",
  d: "freehand",
  t: "text",
  p: "pin",
  b: "blur",
};

export const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0090ff", "#18181b", "#ffffff"] as const;
export const DEFAULT_COLOR: string = COLORS[0];

export interface Point {
  x: number;
  y: number;
}

/** A shape as edited: the schema shape plus an id and per-point stylus widths (not exported). */
export interface Shape extends AnnotationShape {
  id: number;
  /** Freehand only: stroke width multiplier per point, from pointer pressure (0.25–1.75). */
  widths?: number[];
}

export interface Size {
  width: number;
  height: number;
}

// -- history ------------------------------------------------------------------------

/**
 * Immutable undo/redo over the shape list. Each committed edit pushes a
 * snapshot; undo moves back, redo forward, and a new edit after undo drops
 * the redo branch (the familiar editor behaviour).
 */
export interface History {
  readonly past: readonly (readonly Shape[])[];
  readonly present: readonly Shape[];
  readonly future: readonly (readonly Shape[])[];
}

export const MAX_HISTORY = 100;

export function createHistory(initial: readonly Shape[] = []): History {
  return { past: [], present: initial, future: [] };
}

export function commit(h: History, next: readonly Shape[]): History {
  const past = [...h.past, h.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, present: next, future: [] };
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1] as readonly Shape[];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future as [readonly Shape[], ...(readonly Shape[])[]];
  return { past: [...h.past, h.present], present: next, future: rest };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

// -- geometry -----------------------------------------------------------------------

export function clampPoint(p: Point, size: Size): Point {
  return { x: Math.min(Math.max(p.x, 0), size.width), y: Math.min(Math.max(p.y, 0), size.height) };
}

/** Pointer position (client px) → screenshot pixel, given the displayed canvas box. */
export function toImagePoint(
  client: Point,
  box: { left: number; top: number; width: number; height: number },
  image: Size,
): Point {
  const sx = box.width > 0 ? image.width / box.width : 1;
  const sy = box.height > 0 ? image.height / box.height : 1;
  return clampPoint({ x: (client.x - box.left) * sx, y: (client.y - box.top) * sy }, image);
}

/** A drag's two corners → top-left origin rectangle with non-negative size. */
export function normalizeRect(a: Point, b: Point): { x: number; y: number; width: number; height: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** The next pin number: one more than the highest existing pin, so numbers stay unique after deletes. */
export function nextPinNumber(shapes: readonly Shape[]): number {
  let max = 0;
  for (const s of shapes) if (s.tool === "pin") max = Math.max(max, Number(s.label) || 0);
  return max + 1;
}

/** The three points of an arrowhead at `to`, sized relative to the stroke width. */
export function arrowHead(from: Point, to: Point, strokeWidth: number): [Point, Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = Math.max(10, strokeWidth * 4.5);
  const spread = Math.PI / 7;
  return [
    to,
    { x: to.x - len * Math.cos(angle - spread), y: to.y - len * Math.sin(angle - spread) },
    { x: to.x - len * Math.cos(angle + spread), y: to.y - len * Math.sin(angle + spread) },
  ];
}

/** Stroke width for an image: proportional to its size so marks read the same on a phone or a 4K capture. */
export function strokeWidthFor(image: Size): number {
  return Math.max(2, Math.round(Math.min(image.width, image.height) / 220));
}

/** Pointer pressure → width multiplier. Mouse reports 0.5 while pressed (spec), which maps to 1×. */
export function pressureToWidth(pressure: number | undefined, pointerType: string): number {
  if (pointerType !== "pen" || pressure === undefined || pressure <= 0) return 1;
  return 0.25 + Math.min(pressure, 1) * 1.5;
}

/** Drop freehand points closer than `minDistance` to the previous one (keeps shapes small without visible loss). */
export function simplifyStroke(points: readonly Point[], minDistance = 1.5): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDistance) out.push(p);
  }
  const final = points[points.length - 1];
  if (final && out[out.length - 1] !== final && out.length > 0) out.push(final);
  return out;
}

/** Whether a finished drag is big enough to keep (ignores accidental clicks with the rect / arrow / blur tools). */
export function isMeaningful(shape: Pick<Shape, "tool" | "points">, minSize = 4): boolean {
  const pts = shape.points;
  switch (shape.tool) {
    case "text":
    case "pin":
      return pts.length >= 1;
    case "freehand":
      return pts.length >= 2;
    default: {
      if (pts.length < 2) return false;
      const [a, b] = pts as [Point, Point];
      return Math.abs(a.x - b.x) >= minSize || Math.abs(a.y - b.y) >= minSize;
    }
  }
}

/** Export for the ticket: schema shapes with integer coordinates and no editor-only fields. */
export function exportShapes(shapes: readonly Shape[]): AnnotationShape[] {
  return shapes.map((s) => {
    const out: AnnotationShape = {
      tool: s.tool,
      points: s.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    };
    if (s.color && s.tool !== "blur") out.color = s.color;
    if (s.label !== undefined) out.label = s.label;
    return out;
  });
}

// -- keyboard region selection --------------------------------------------------------

/**
 * The non-pointer alternative: a selection rectangle moved with the arrow
 * keys and resized with Shift+arrows, committed with Enter as the current
 * tool's shape. Steps are 2% of the image (Alt: 0.5%) so the whole image is
 * reachable in a few dozen presses.
 */
export interface KeyboardSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function initialSelection(image: Size): KeyboardSelection {
  const width = Math.round(image.width * 0.25);
  const height = Math.round(image.height * 0.2);
  return { x: Math.round((image.width - width) / 2), y: Math.round((image.height - height) / 2), width, height };
}

export function moveSelection(
  sel: KeyboardSelection,
  key: string,
  opts: { resize: boolean; fine: boolean },
  image: Size,
): KeyboardSelection {
  const step = Math.max(1, Math.round(Math.min(image.width, image.height) * (opts.fine ? 0.005 : 0.02)));
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  const min = Math.max(4, step);
  if (opts.resize) {
    const width = Math.min(Math.max(sel.width + dx, min), image.width - sel.x);
    const height = Math.min(Math.max(sel.height + dy, min), image.height - sel.y);
    return { ...sel, width, height };
  }
  const x = Math.min(Math.max(sel.x + dx, 0), image.width - sel.width);
  const y = Math.min(Math.max(sel.y + dy, 0), image.height - sel.height);
  return { ...sel, x, y };
}

/** Turn the keyboard selection into the current tool's shape. */
export function shapeFromSelection(
  sel: KeyboardSelection,
  tool: Tool,
  id: number,
  color: string,
  existing: readonly Shape[],
  text?: string,
): Shape | null {
  const tl = { x: sel.x, y: sel.y };
  const br = { x: sel.x + sel.width, y: sel.y + sel.height };
  const center = { x: sel.x + sel.width / 2, y: sel.y + sel.height / 2 };
  switch (tool) {
    case "rect":
    case "blur":
      return { id, tool, points: [tl, br], color };
    case "arrow":
      // Points at the selection from its lower-left, like a callout.
      return { id, tool, points: [{ x: Math.max(0, sel.x - sel.width * 0.4), y: br.y + sel.height * 0.4 }, center], color };
    case "pin":
      return { id, tool, points: [center], color, label: String(nextPinNumber(existing)) };
    case "text":
      return text ? { id, tool, points: [tl], color, label: text } : null;
    case "freehand":
      // An ellipse around the selection — the keyboard equivalent of circling something.
      return {
        id,
        tool,
        color,
        points: Array.from({ length: 33 }, (_, i) => {
          const t = (i / 32) * Math.PI * 2;
          return { x: center.x + (sel.width / 2) * Math.cos(t), y: center.y + (sel.height / 2) * Math.sin(t) };
        }),
      };
  }
}

// -- pixelation --------------------------------------------------------------------------

/**
 * Destructively pixelate a region of an RGBA buffer in place: every block
 * becomes its average colour, so the original pixels are unrecoverable from
 * the exported PNG (unlike a CSS blur or a translucent overlay).
 */
export function pixelate(
  data: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  region: { x: number; y: number; width: number; height: number },
  blockSize: number,
): void {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(imageWidth, Math.ceil(region.x + region.width));
  const y1 = Math.min(imageHeight, Math.ceil(region.y + region.height));
  const bs = Math.max(2, Math.floor(blockSize));
  for (let by = y0; by < y1; by += bs) {
    for (let bx = x0; bx < x1; bx += bs) {
      const ex = Math.min(bx + bs, x1);
      const ey = Math.min(by + bs, y1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * imageWidth + x) * 4;
          r += data[i] as number;
          g += data[i + 1] as number;
          b += data[i + 2] as number;
          a += data[i + 3] as number;
          n++;
        }
      }
      if (n === 0) continue;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      a = Math.round(a / n);
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * imageWidth + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = a;
        }
      }
    }
  }
}

/** Block size for redaction: large enough that text is unreadable at any capture scale. */
export function blurBlockSize(image: Size): number {
  return Math.max(8, Math.round(Math.min(image.width, image.height) / 60));
}
