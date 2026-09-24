"use client";
/**
 * `Panel` primitive: an accessible modal dialog, unstyled.
 *
 * - `role="dialog"` + `aria-modal`, labelled by its title.
 * - Focus moves in on open (`[data-autofocus]`, else the first focusable),
 *   Tab / Shift+Tab wrap inside, Escape calls `onClose`, and focus returns to
 *   whatever had it before — across shadow roots, which `document.activeElement`
 *   alone can't see.
 */
import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** The focused element, looking through open shadow roots. */
export function deepActiveElement(): Element | null {
  let el: Element | null = typeof document !== "undefined" ? document.activeElement : null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

export function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.closest("[inert]")) return false;
    // Skip elements hidden by CSS (display:none has no client rects) but keep zero-size focus targets like visually hidden inputs out.
    return el.getClientRects().length > 0 || el === document.activeElement;
  });
}

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  open?: boolean;
  onClose: () => void;
  /** id of the element that names the dialog (usually its heading). */
  labelledBy?: string;
  /** Return focus to the previously focused element on close. Default true. */
  restoreFocus?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  children?: ReactNode;
}

export function Panel({ open = true, onClose, labelledBy, restoreFocus = true, closeOnEscape = true, children, onKeyDown, ...rest }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = deepActiveElement() as HTMLElement | null;
    const node = ref.current;
    // Next frame: children (and lazy content) have laid out.
    const raf = requestAnimationFrame(() => {
      if (!node) return;
      const target = node.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(node)[0] ?? node;
      target.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      if (restoreFocus && previous && previous.isConnected && !node?.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open, restoreFocus]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      data-spotter-part="dialog"
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Escape" && closeOnEscape) {
          e.stopPropagation();
          onCloseRef.current();
          return;
        }
        if (e.key !== "Tab" || !ref.current) return;
        const items = focusables(ref.current);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = deepActiveElement();
        if (e.shiftKey && (active === first || !ref.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
