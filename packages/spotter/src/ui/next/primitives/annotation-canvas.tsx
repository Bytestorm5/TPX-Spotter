"use client";
/**
 * `AnnotationCanvas` primitive: draw on a screenshot.
 *
 * Controlled: the parent owns the undo/redo `History`, the tool and the
 * colour, so any toolbar (ours or a custom one) can drive it. Pointer Events
 * cover mouse, touch and stylus uniformly; pen pressure sets freehand width.
 *
 * Keyboard (canvas focused): R A D T P B pick tools, ⌘/Ctrl+Z undo,
 * ⇧⌘Z / Ctrl+Y redo. Enter starts a selection box — the non-pointer way to
 * annotate — moved with the arrows, resized with Shift+arrows (Alt for fine
 * steps), placed with Enter as the current tool's shape, dismissed with Esc.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  commit,
  initialSelection,
  isMeaningful,
  moveSelection,
  nextPinNumber,
  pressureToWidth,
  redo,
  shapeFromSelection,
  simplifyStroke,
  toImagePoint,
  TOOL_KEYS,
  undo,
  type History,
  type KeyboardSelection,
  type Point,
  type Shape,
  type Tool,
} from "../annotate/model.ts";
import { renderAnnotated } from "../annotate/render.ts";
import type { LoadedImage } from "./screenshot.tsx";

export interface AnnotationCanvasProps {
  image: LoadedImage;
  history: History;
  onHistory: (next: History) => void;
  tool: Tool;
  onToolChange?: (tool: Tool) => void;
  color: string;
  /** Accessible name / instructions for the canvas. */
  label: string;
  /** Visible hint while a keyboard selection is active. */
  keyboardHint?: string;
  /** Placeholder / label for the text tool's input. */
  textLabel?: string;
  /** Screen-reader announcement after a shape is added. */
  announce?: (tool: Tool) => void;
  /** Fit inside this box (CSS px). Default: the parent element's size. */
  className?: string;
}

let nextId = 1;

export function AnnotationCanvas({
  image,
  history,
  onHistory,
  tool,
  onToolChange,
  color,
  label,
  keyboardHint,
  textLabel = "Label text",
  announce,
  className,
}: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const draft = useRef<Shape | null>(null);
  const raf = useRef(0);
  const [display, setDisplay] = useState<{ width: number; height: number } | null>(null);
  const [selection, setSelection] = useState<KeyboardSelection | null>(null);
  const [textAt, setTextAt] = useState<{ image: Point; css: Point } | null>(null);
  const [text, setText] = useState("");
  const size = { width: image.width, height: image.height };

  const historyRef = useRef(history);
  historyRef.current = history;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const shapes = draft.current ? [...historyRef.current.present, draft.current] : historyRef.current.present;
    renderAnnotated(ctx, image.source, shapes, size, true);
    if (selection) {
      ctx.save();
      const w = Math.max(2, Math.round(Math.min(size.width, size.height) / 300));
      ctx.lineWidth = w;
      ctx.setLineDash([w * 4, w * 3]);
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
      ctx.lineDashOffset = w * 3.5;
      ctx.strokeStyle = "#2563eb";
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
      ctx.restore();
    }
  }, [image, selection, size.width, size.height]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    paint();
  }, [image, history, paint]);

  // Fit the bitmap into the available box, keeping its aspect ratio.
  useEffect(() => {
    const frame = frameRef.current?.parentElement;
    if (!frame) return;
    const fit = () => {
      const cs = getComputedStyle(frame);
      const availW = frame.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const availH = frame.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (availW <= 0 || availH <= 0) return;
      const scale = Math.min(availW / image.width, availH / image.height, 1.5);
      setDisplay({ width: Math.floor(image.width * scale), height: Math.floor(image.height * scale) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [image]);

  const point = (e: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return toImagePoint({ x: e.clientX, y: e.clientY }, rect, size);
  };

  const add = (shape: Shape | null) => {
    if (!shape || !isMeaningful(shape)) return;
    onHistory(commit(historyRef.current, [...historyRef.current.present, shape]));
    announce?.(shape.tool);
  };

  const openText = (p: Point) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const frame = frameRef.current!.getBoundingClientRect();
    const css = { x: (p.x / size.width) * rect.width + rect.left - frame.left, y: (p.y / size.height) * rect.height + rect.top - frame.top };
    setText("");
    setTextAt({ image: p, css });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (textAt) return;
    e.preventDefault();
    canvasRef.current?.focus({ preventScroll: true });
    setSelection(null);
    const p = point(e);
    if (tool === "pin") {
      add({ id: nextId++, tool: "pin", points: [p], color, label: String(nextPinNumber(historyRef.current.present)) });
      return;
    }
    if (tool === "text") {
      openText(p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    draft.current =
      tool === "freehand"
        ? { id: nextId++, tool, points: [p], color, widths: [pressureToWidth(e.pressure, e.pointerType)] }
        : { id: nextId++, tool, points: [p, p], color };
    if (tool === "freehand" && e.pointerType !== "pen") delete draft.current.widths;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = draft.current;
    if (!d) return;
    // Coalesced events keep fast stylus strokes smooth.
    const events = (e.nativeEvent.getCoalescedEvents?.() ?? []).length > 0 ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    if (d.tool === "freehand") {
      for (const ev of events) {
        d.points.push(point(ev));
        if (d.widths) d.widths.push(pressureToWidth(ev.pressure, ev.pointerType));
      }
    } else {
      d.points[1] = point(events[events.length - 1]!);
    }
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(paint);
  };

  const onPointerUp = () => {
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    if (d.tool === "freehand" && !d.widths) d.points = simplifyStroke(d.points);
    if (isMeaningful(d)) add(d);
    else paint();
  };

  const commitText = () => {
    if (textAt && text.trim()) add({ id: nextId++, tool: "text", points: [textAt.image], color, label: text.trim() });
    setTextAt(null);
    canvasRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      onHistory(e.shiftKey ? redo(historyRef.current) : undo(historyRef.current));
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      onHistory(redo(historyRef.current));
      return;
    }
    if (selection) {
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        setSelection(moveSelection(selection, e.key, { resize: e.shiftKey, fine: e.altKey }, size));
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (tool === "text") {
          openText({ x: selection.x, y: selection.y });
        } else {
          add(shapeFromSelection(selection, tool, nextId++, color, historyRef.current.present));
        }
        setSelection(null);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // Cancel the selection, not the whole dialog.
        setSelection(null);
        return;
      }
    }
    if (!mod && !e.altKey && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setSelection(initialSelection(size));
      return;
    }
    const t = !mod && !e.altKey && !e.shiftKey ? TOOL_KEYS[e.key.toLowerCase()] : undefined;
    if (t) {
      e.preventDefault();
      onToolChange?.(t);
    }
  };

  useEffect(() => paint(), [selection, paint]);

  return (
    <div ref={frameRef} className={["sp-canvas-frame", className].filter(Boolean).join(" ")} data-spotter-part="canvasFrame">
      <canvas
        ref={canvasRef}
        className="sp-canvas"
        data-spotter-part="canvas"
        data-tool={tool}
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-roledescription="canvas"
        style={display ? { width: display.width, height: display.height } : { width: "100%" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      />
      {textAt ? (
        <input
          className="sp-textbox"
          aria-label={textLabel}
          placeholder={textLabel}
          autoFocus
          value={text}
          style={{ left: Math.max(4, textAt.css.x), top: Math.max(4, textAt.css.y) }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setTextAt(null);
              canvasRef.current?.focus({ preventScroll: true });
            }
          }}
        />
      ) : null}
      {selection && keyboardHint ? (
        <p className="sp-sr" role="status">
          {keyboardHint}
        </p>
      ) : null}
    </div>
  );
}
