/**
 * Draw annotation shapes onto a 2D context — used both for the live canvas
 * and for flattening the annotated PNG, so what the reporter sees is exactly
 * what the team receives.
 */
import {
  arrowHead,
  blurBlockSize,
  normalizeRect,
  pixelate,
  strokeWidthFor,
  type Point,
  type Shape,
  type Size,
} from "./model.ts";

type Ctx = CanvasRenderingContext2D;

const FONT = '600 {size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Readable ink on a coloured pin / label. */
function inkOn(color: string): string {
  return color.toLowerCase() === "#ffffff" || color.toLowerCase() === "#f5a524" ? "#18181b" : "#ffffff";
}

function drawArrow(ctx: Ctx, from: Point, to: Point, width: number, color: string): void {
  const [tip, l, r] = arrowHead(from, to, width);
  // Stop the shaft inside the head so the tip stays sharp at wide strokes.
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const shaftEnd = { x: tip.x - Math.cos(ang) * width * 2, y: tip.y - Math.sin(ang) * width * 2 };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(l.x, l.y);
  ctx.lineTo(r.x, r.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawFreehand(ctx: Ctx, shape: Shape, width: number, color: string): void {
  const pts = shape.points;
  if (pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const widths = shape.widths;
  if (!widths) {
    ctx.beginPath();
    ctx.moveTo((pts[0] as Point).x, (pts[0] as Point).y);
    // Quadratic smoothing through midpoints: smooth curves without a spline library.
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i] as Point;
      const n = pts[i + 1] as Point;
      ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
    }
    const last = pts[pts.length - 1] as Point;
    ctx.lineTo(last.x, last.y);
    ctx.lineWidth = width;
    ctx.stroke();
    return;
  }
  // Variable width (stylus pressure): one segment per pair.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point;
    const b = pts[i] as Point;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = width * (widths[i] ?? 1);
    ctx.stroke();
  }
}

function drawPin(ctx: Ctx, at: Point, label: string, image: Size, color: string): void {
  const r = Math.max(11, Math.round(Math.min(image.width, image.height) / 55));
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = r / 2;
  ctx.shadowOffsetY = r / 8;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(2, r / 6);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = inkOn(color);
  ctx.font = FONT.replace("{size}", String(Math.round(r * 1.1)));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, at.x, at.y + r * 0.05);
}

function drawText(ctx: Ctx, at: Point, label: string, image: Size, color: string): void {
  const size = Math.max(14, Math.round(Math.min(image.width, image.height) / 32));
  ctx.font = FONT.replace("{size}", String(size));
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const pad = size * 0.35;
  const w = ctx.measureText(label).width;
  // A solid label box keeps text legible on any screenshot.
  ctx.fillStyle = color;
  roundRect(ctx, at.x, at.y, w + pad * 2, size + pad * 1.6, size * 0.25);
  ctx.fill();
  ctx.fillStyle = inkOn(color);
  ctx.fillText(label, at.x + pad, at.y + pad * 0.8);
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Redact blur regions in the context's pixels. Reads back from the context
 * (which must hold the screenshot) and pixelates in place.
 */
export function applyBlurs(ctx: Ctx, shapes: readonly Shape[], image: Size): void {
  const blurs = shapes.filter((s) => s.tool === "blur" && s.points.length >= 2);
  if (blurs.length === 0) return;
  const block = blurBlockSize(image);
  for (const s of blurs) {
    const r = normalizeRect(s.points[0] as Point, s.points[1] as Point);
    const x = Math.floor(r.x);
    const y = Math.floor(r.y);
    const w = Math.ceil(r.width);
    const h = Math.ceil(r.height);
    if (w < 1 || h < 1) continue;
    const img = ctx.getImageData(x, y, w, h);
    pixelate(img.data, w, h, { x: 0, y: 0, width: w, height: h }, block);
    ctx.putImageData(img, x, y);
  }
}

/** Draw every non-blur shape (blurs are pixel operations, see `applyBlurs`). */
export function drawShapes(ctx: Ctx, shapes: readonly Shape[], image: Size, opts: { showBlurOutline?: boolean } = {}): void {
  const width = strokeWidthFor(image);
  for (const s of shapes) {
    const color = s.color ?? "#e5484d";
    ctx.save();
    switch (s.tool) {
      case "rect": {
        if (s.points.length < 2) break;
        const r = normalizeRect(s.points[0] as Point, s.points[1] as Point);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        roundRect(ctx, r.x, r.y, r.width, r.height, Math.min(width * 1.5, r.width / 2, r.height / 2));
        ctx.stroke();
        break;
      }
      case "arrow":
        if (s.points.length >= 2) drawArrow(ctx, s.points[0] as Point, s.points[1] as Point, width, color);
        break;
      case "freehand":
        drawFreehand(ctx, s, width, color);
        break;
      case "pin":
        if (s.points[0]) drawPin(ctx, s.points[0], s.label ?? "1", image, color);
        break;
      case "text":
        if (s.points[0] && s.label) drawText(ctx, s.points[0], s.label, image, color);
        break;
      case "blur":
        if (opts.showBlurOutline && s.points.length >= 2) {
          const r = normalizeRect(s.points[0] as Point, s.points[1] as Point);
          ctx.setLineDash([width * 2, width * 1.5]);
          ctx.strokeStyle = "rgba(24,24,27,0.7)";
          ctx.lineWidth = Math.max(1, width / 2);
          ctx.strokeRect(r.x, r.y, r.width, r.height);
        }
        break;
    }
    ctx.restore();
  }
}

/** Screenshot + shapes → one bitmap on `ctx` (which must be image-sized). */
export function renderAnnotated(ctx: Ctx, base: CanvasImageSource, shapes: readonly Shape[], image: Size, live = false): void {
  ctx.clearRect(0, 0, image.width, image.height);
  ctx.drawImage(base, 0, 0, image.width, image.height);
  applyBlurs(ctx, shapes, image);
  drawShapes(ctx, shapes, image, { showBlurOutline: live });
}

/** Flatten into a PNG blob for the `annotated_screenshot` artifact. */
export async function flattenToPng(base: CanvasImageSource, shapes: readonly Shape[], image: Size): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  renderAnnotated(ctx, base, shapes, image, false);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}
