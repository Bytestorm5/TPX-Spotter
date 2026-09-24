"use client";
/**
 * `Screenshot` primitive: shows a captured image. Drawn on a `<canvas>` from
 * an `ImageBitmap` rather than an `<img src="blob:…">`, so it needs no
 * `img-src blob:` in the host's CSP.
 */
import { useEffect, useRef, useState, type CanvasHTMLAttributes } from "react";

export type ImageInput = Blob | ImageBitmap | HTMLImageElement | HTMLCanvasElement;

export interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export async function loadImage(input: ImageInput): Promise<LoadedImage> {
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (typeof createImageBitmap === "function") {
      const bmp = await createImageBitmap(input);
      return { source: bmp, width: bmp.width, height: bmp.height };
    }
    const url = URL.createObjectURL(input);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (typeof HTMLImageElement !== "undefined" && input instanceof HTMLImageElement) {
    return { source: input, width: input.naturalWidth, height: input.naturalHeight };
  }
  const c = input as ImageBitmap | HTMLCanvasElement;
  return { source: c, width: c.width, height: c.height };
}

export interface ScreenshotProps extends Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "children"> {
  image: ImageInput | LoadedImage | null;
  /** Accessible description. */
  alt: string;
  /** Render at most this many CSS pixels wide (the bitmap is downscaled once, not per frame). */
  maxWidth?: number;
  /** Optional overlay drawer (the annotated preview uses it). */
  draw?: (ctx: CanvasRenderingContext2D, image: LoadedImage) => void;
}

export function Screenshot({ image, alt, maxWidth = 320, draw, ...rest }: ScreenshotProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  useEffect(() => {
    let alive = true;
    if (!image) return setLoaded(null);
    if ("source" in (image as LoadedImage)) setLoaded(image as LoadedImage);
    else void loadImage(image as ImageInput).then((l) => alive && setLoaded(l));
    return () => {
      alive = false;
    };
  }, [image]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !loaded) return;
    const dpr = typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 2) : 1;
    const scale = Math.min(1, (maxWidth * dpr) / loaded.width);
    canvas.width = Math.max(1, Math.round(loaded.width * scale));
    canvas.height = Math.max(1, Math.round(loaded.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.scale(scale, scale);
    ctx.drawImage(loaded.source, 0, 0);
    draw?.(ctx, loaded);
    ctx.restore();
  }, [loaded, maxWidth, draw]);
  return <canvas ref={ref} role="img" aria-label={alt} data-spotter-part="screenshot" {...rest} />;
}
