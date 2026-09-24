/**
 * Screenshots, loaded as a lazy chunk behind FEATURE_SCREENSHOT.
 *
 * The default renders the DOM with `modern-screenshot` (SVG foreignObject →
 * canvas): no permission prompt, and masking is applied to the *cloned* DOM
 * while it's built — the live page is never touched:
 * - input, textarea and select values are always replaced by placeholders;
 * - text is masked per `maskText` / `data-spotter-mask` / mask selectors,
 *   with `data-spotter-unmask` honoured (nearest wins);
 * - blocked elements (`data-spotter-block`, block selectors) are drawn as
 *   solid boxes of the same size and their content is never cloned;
 * - Spotter's UI and `options.exclude` are left out entirely.
 *
 * Budget: < 1 s on a typical page — scale is the device pixel ratio capped at
 * 2, remote fetches (images, fonts) time out quickly, and web fonts are
 * skipped on font-heavy pages.
 *
 * `captureNativeScreenshot()` grabs one frame of the current tab via
 * `getDisplayMedia` — the fallback when DOM rendering fails, or on request
 * (`method: "native"`). The browser shows its own picker; nothing is masked
 * there beyond what the user chooses to share, so it's never used silently.
 */
import { domToCanvas } from "modern-screenshot";
import type { ScreenshotOptions, ScreenshotResult } from "../internal.ts";
import { BLOCK_ATTR, isSensitiveInput, isTextMasked, MASK_ATTR, placeholder, safeMatches, UI_ATTR, validSelectors } from "../capture/mask.ts";

export interface CaptureScreenshotOptions extends ScreenshotOptions {
  /** `auto` (default): DOM rendering, native capture if it fails. */
  method?: "auto" | "dom" | "native";
  /** Per-resource fetch timeout, ms. Default 1500. */
  resourceTimeoutMs?: number;
}

const MASK_CHAR = "•";
const BLOCK_COLOR = "#9ca3af";
const BUTTON_TYPES = new Set(["submit", "button", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"]);
/** 1×1 transparent GIF: blocked images must not be fetched or drawn. */
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))), "image/png");
  });
}

/** The node's parent in the composed tree (shadow children → their host). */
function composedParent(node: Node): Node | null {
  const p = node.parentNode;
  if (p && p.nodeType === 11 && (p as ShadowRoot).host) return (p as ShadowRoot).host;
  return p;
}

interface MaskPlan {
  maskText: ScreenshotOptions["maskText"];
  mask: string;
  block: string;
}

/**
 * Hooks for modern-screenshot that mask the clone as it's built.
 *
 * `filter(source)` runs (pre-order) just before a node is cloned, and
 * `onCloneEachNode(clone)` runs (post-order) once the clone's subtree is done
 * — for every node except text. So a stack pushed in `filter` and popped in
 * `onCloneEachNode` pairs each clone with its source. Should the pairing ever
 * disagree (a library change), `desynced` flips and `finalize` masks the whole
 * clone instead: failing closed.
 */
export function createMasker(root: Element, plan: MaskPlan, exclude: ReadonlySet<Element>, viewportShift?: { x: number; y: number }) {
  const stack: (Node | null)[] = [];
  const blocked = new WeakSet<Node>();
  let desynced = false;

  const filter = (node: Node): boolean => {
    try {
      const parent = composedParent(node);
      if (parent && blocked.has(parent)) return false;
      if (node.nodeType === 3) return true; // text: cloned without a hook call
      if (node.nodeType !== 1) {
        stack.push(null);
        return true;
      }
      const el = node as Element;
      if (exclude.has(el) || el.hasAttribute(UI_ATTR)) return false;
      if (safeMatches(el, plan.block)) blocked.add(el);
      stack.push(el);
      // modern-screenshot clones a same-origin iframe's documentElement in its place: one more hook call.
      if (el.localName === "iframe") {
        try {
          const inner = (el as HTMLIFrameElement).contentDocument?.documentElement;
          if (inner) stack.push(inner);
        } catch {
          /* cross-origin */
        }
      }
      return true;
    } catch {
      desynced = true;
      return true;
    }
  };

  const maskTextChildren = (clone: Node) => {
    for (let c = clone.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) (c as Text).data = placeholder((c as Text).data, MASK_CHAR);
    }
  };

  const drawBlock = (source: Element, clone: HTMLElement) => {
    let w = 0;
    let h = 0;
    try {
      const r = source.getBoundingClientRect();
      w = r.width;
      h = r.height;
    } catch {
      /* no layout */
    }
    while (clone.firstChild) clone.removeChild(clone.firstChild);
    for (const attr of ["src", "srcset", "poster", "alt", "title", "value", "placeholder"]) clone.removeAttribute?.(attr);
    if (clone.localName === "img") clone.setAttribute("src", BLANK_IMAGE);
    const s = clone.style;
    if (s) {
      if (getComputedStyle(source).display === "inline") s.setProperty("display", "inline-block");
      s.setProperty("width", `${w}px`, "important");
      s.setProperty("height", `${h}px`, "important");
      s.setProperty("background", BLOCK_COLOR, "important");
      s.setProperty("color", "transparent", "important");
      s.setProperty("box-shadow", "none");
      s.setProperty("filter", "none");
    }
  };

  const maskFormControl = (source: Element, clone: Element) => {
    const tag = source.localName;
    if (tag === "input") {
      const type = (source.getAttribute("type") || "text").toLowerCase();
      if (BUTTON_TYPES.has(type)) return;
      const value = (source as HTMLInputElement).value ?? "";
      const masked = isSensitiveInput(source) ? "" : placeholder(value, MASK_CHAR).replace(/\s/g, MASK_CHAR);
      clone.setAttribute("value", masked);
      if ((clone as HTMLInputElement).value !== undefined) (clone as HTMLInputElement).value = masked;
    } else if (tag === "textarea") {
      const masked = placeholder((source as HTMLTextAreaElement).value ?? "", MASK_CHAR);
      clone.textContent = masked;
      clone.setAttribute("value", masked);
    } else if (tag === "select") {
      clone.setAttribute("value", "");
      clone.querySelectorAll("option").forEach((o) => {
        o.textContent = placeholder(o.textContent ?? "", MASK_CHAR);
      });
    }
  };

  const onCloneEachNode = (clone: Node) => {
    if (desynced) return;
    try {
      const popped = stack.pop();
      const source = popped === undefined ? root : popped;
      if (!source || clone.nodeType !== 1) return;
      const src = source as Element;
      const el = clone as HTMLElement;
      // Canvas/video/iframe clone into other element types; anything else must match.
      if (!/^(canvas|video|iframe)$/.test(src.localName) && src.nodeName !== el.nodeName) {
        desynced = true;
        return;
      }
      if (blocked.has(src)) {
        drawBlock(src, el);
        return;
      }
      if (/^(input|textarea|select)$/.test(src.localName)) maskFormControl(src, el);
      else if (isTextMasked(src, plan)) maskTextChildren(el);
      // Inner scroll containers: show what's scrolled into view. (Not the document itself —
      // the viewport shift below handles that, and doing both would scroll twice.)
      if (src !== root && src !== document.documentElement && src !== document.body) {
        const top = (src as HTMLElement).scrollTop;
        const left = (src as HTMLElement).scrollLeft;
        if (top || left) {
          for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
            const cs = (c as HTMLElement).style;
            if (!cs) continue;
            const t = cs.transform;
            cs.transform = `translate(${-left}px, ${-top}px)${t && t !== "none" ? ` ${t}` : ""}`;
          }
        }
      }
      // Viewport capture shifts the root by the scroll offset; fixed elements must not move with it.
      if (viewportShift && el.style && el.style.position === "fixed") {
        const t = el.style.transform;
        el.style.transform = `translate(${viewportShift.x}px, ${viewportShift.y}px)${t && t !== "none" ? ` ${t}` : ""}`;
      }
    } catch {
      desynced = true;
    }
  };

  /** Fail closed: if pairing broke, mask every text node, every control and every blocked element in the clone. */
  const finalize = (cloneRoot: Node) => {
    if (!desynced || cloneRoot.nodeType !== 1) return;
    const r = cloneRoot as Element;
    const walker = r.ownerDocument.createTreeWalker(r, 4 /* SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) (n as Text).data = placeholder((n as Text).data, MASK_CHAR);
    r.querySelectorAll("input,textarea").forEach((c) => {
      c.setAttribute("value", "");
      if (c.localName === "textarea") c.textContent = "";
    });
    try {
      r.querySelectorAll(plan.block).forEach((c) => {
        while (c.firstChild) c.removeChild(c.firstChild);
        (c as HTMLElement).style?.setProperty("background", BLOCK_COLOR, "important");
      });
    } catch {
      /* selector didn't parse against the clone */
    }
  };

  return { filter, onCloneEachNode, finalize, get desynced() {
    return desynced;
  } };
}

/** Too many remote web fonts makes embedding slow; system fallbacks are fine for a bug screenshot. */
function shouldEmbedFonts(): boolean {
  try {
    let remote = 0;
    document.fonts?.forEach((f) => {
      if (f.status === "loaded") remote++;
    });
    return remote <= 6;
  } catch {
    return false;
  }
}

async function captureDom(options: CaptureScreenshotOptions): Promise<ScreenshotResult> {
  const doc = document.documentElement;
  const plan: MaskPlan = {
    maskText: options.maskText,
    mask: [`[${MASK_ATTR}]`, ...validSelectors(options.maskSelectors)].join(","),
    block: [`[${BLOCK_ATTR}]`, ...validSelectors(options.blockSelectors)].join(","),
  };
  const exclude = new Set(options.exclude ?? []);
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const timeout = options.resourceTimeoutMs ?? 1500;

  let root: Element = doc;
  let width: number;
  let height: number;
  let style: Partial<CSSStyleDeclaration> | undefined;
  let shift: { x: number; y: number } | undefined;
  if (options.scope === "element" && options.element) {
    root = options.element;
    const r = root.getBoundingClientRect();
    width = Math.ceil(r.width);
    height = Math.ceil(r.height);
  } else if (options.scope === "full") {
    width = Math.max(doc.scrollWidth, doc.clientWidth);
    height = Math.max(doc.scrollHeight, doc.clientHeight);
  } else {
    width = doc.clientWidth || window.innerWidth;
    height = doc.clientHeight || window.innerHeight;
    const x = Math.round(window.scrollX);
    const y = Math.round(window.scrollY);
    if (x || y) {
      shift = { x, y };
      style = { transform: `translate(${-x}px, ${-y}px)`, transformOrigin: "0 0" } as Partial<CSSStyleDeclaration>;
    }
  }
  if (!width || !height) throw new Error("nothing to capture (zero-sized target)");

  const masker = createMasker(root, plan, exclude, shift);
  // The root's own background if it has one (element scope), else the page's.
  const opaque = (c: string | undefined) => !!c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent";
  const rootBg = getComputedStyle(root).backgroundColor;
  const pageBg = getComputedStyle(document.body ?? doc).backgroundColor;
  const bg = opaque(rootBg) ? rootBg : pageBg;
  const canvas = await domToCanvas(root, {
    width,
    height,
    scale,
    style: style ?? null,
    backgroundColor: opaque(bg) ? bg : "#ffffff",
    filter: masker.filter,
    onCloneEachNode: masker.onCloneEachNode,
    onCloneNode: masker.finalize,
    timeout,
    font: shouldEmbedFonts() ? undefined : false,
    fetch: { requestInit: { cache: "force-cache" } },
    // Chrome/Safari/Firefox max canvas area is ~16k² / 268M px; keep well within.
    maximumCanvasSize: 16384,
    // Its scroll restoration also shifts the document's children; we do it ourselves (see createMasker).
    features: { restoreScrollPosition: false },
  });
  const blob = await canvasToBlob(canvas);
  return { blob, width: canvas.width, height: canvas.height, method: "dom" };
}

/**
 * One frame of the current tab via `getDisplayMedia` (the browser asks the
 * user). `preferCurrentTab` pre-selects this tab in Chromium.
 */
export async function captureNativeScreenshot(): Promise<ScreenshotResult> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getDisplayMedia) throw new Error("getDisplayMedia is not available");
  const stream = await media.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Let the picker's own UI fade out of the captured frame.
    await new Promise((r) => setTimeout(r, 250));
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error("no video frame");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(video, 0, 0, w, h);
    video.srcObject = null;
    const blob = await canvasToBlob(canvas);
    return { blob, width: w, height: h, method: "native" };
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

export async function captureScreenshot(options: CaptureScreenshotOptions): Promise<ScreenshotResult> {
  if (typeof document === "undefined") throw new Error("screenshots need a browser");
  const method = options.method ?? "auto";
  if (method === "native") return captureNativeScreenshot();
  try {
    return await captureDom(options);
  } catch (error) {
    if (method === "dom") throw error;
    return captureNativeScreenshot();
  }
}
