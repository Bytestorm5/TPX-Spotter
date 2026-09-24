"use client";
/**
 * Public, lazy entry points to annotation (`features.annotate`).
 *
 * The canvas and the renderer are their own chunk, behind an inline
 * compile-time guard, so a build with `annotate: false` contains none of
 * their code — not even an unused chunk — while `AnnotationCanvas` and
 * `loadAnnotationTools()` stay importable (they render nothing / reject).
 */
import { lazy, Suspense, type ComponentType } from "react";
import { FEATURE_ANNOTATE } from "../../../core/features.ts";
import type { AnnotationCanvasProps } from "./annotation-canvas.tsx";

declare const __SPOTTER_ANNOTATE__: boolean | undefined;

type CanvasModule = typeof import("./annotation-canvas.tsx");
type RenderModule = typeof import("../annotate/render.ts");
type ModelModule = typeof import("../annotate/model.ts");

let canvasChunk: Promise<CanvasModule> | null = null;
let renderChunk: Promise<RenderModule> | null = null;

/** The canvas chunk (the panel warms it as soon as it opens). */
export function loadCanvas(): Promise<CanvasModule> | null {
  if ((typeof __SPOTTER_ANNOTATE__ === "boolean" ? __SPOTTER_ANNOTATE__ : true) && FEATURE_ANNOTATE) {
    canvasChunk ??= import("./annotation-canvas.tsx");
    return canvasChunk;
  }
  return null;
}

/** The renderer (flattening, blur): used to export the annotated PNG. */
export function loadRenderer(): Promise<RenderModule> | null {
  if ((typeof __SPOTTER_ANNOTATE__ === "boolean" ? __SPOTTER_ANNOTATE__ : true) && FEATURE_ANNOTATE) {
    renderChunk ??= import("../annotate/render.ts");
    return renderChunk;
  }
  return null;
}

/** For custom UIs: history helpers, geometry and `flattenToPng`, loaded on demand. */
export async function loadAnnotationTools(): Promise<ModelModule & Pick<RenderModule, "flattenToPng" | "renderAnnotated">> {
  const render = loadRenderer();
  if (!render) throw new Error("Spotter: annotation is not compiled into this build (features.annotate).");
  const [model, r] = await Promise.all([import("../annotate/model.ts"), render]);
  return { ...model, flattenToPng: r.flattenToPng, renderAnnotated: r.renderAnnotated };
}

const LazyCanvas = lazy(async () => {
  const chunk = loadCanvas();
  if (!chunk) return { default: (() => null) as ComponentType<AnnotationCanvasProps> };
  return { default: (await chunk).AnnotationCanvas };
});

/** `AnnotationCanvas` primitive (see `annotation-canvas.tsx` for the props and keyboard model). */
export function AnnotationCanvas(props: AnnotationCanvasProps & { fallback?: React.ReactNode }) {
  const { fallback = null, ...rest } = props;
  return (
    <Suspense fallback={fallback}>
      <LazyCanvas {...rest} />
    </Suspense>
  );
}

export type { AnnotationCanvasProps };
