"use client";
/**
 * `Dialog`: a modal in a portal, with the Spotter widget's focus handling.
 *
 * - `role="dialog"` + `aria-modal`, named by its title (and described by
 *   its subtitle).
 * - Focus moves in on open (`[data-autofocus]`, else the first focusable
 *   in the body, else the dialog), Tab / Shift+Tab wrap inside, and focus
 *   returns to whatever had it before — across shadow roots.
 * - Escape and a press on the backdrop close it; with dialogs stacked
 *   (a picker inside an editor) only the topmost one reacts.
 * - The page behind doesn't scroll while any dialog is open.
 * - On narrow screens it becomes a bottom sheet.
 */
import { useEffect, useId, useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn.ts";
import { IconButton } from "./button.tsx";
import { CloseIcon } from "./icons.tsx";

const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** The focused element, looking through open shadow roots. */
export function deepActiveElement(): Element | null {
  let el: Element | null = typeof document !== "undefined" ? document.activeElement : null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Tabbable elements in `container`, in order, skipping inert and hidden ones. */
export function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.closest("[inert]")) return false;
    return el.getClientRects().length > 0 || el === document.activeElement;
  });
}

// Open dialogs, innermost last; only the last one handles Escape and the backdrop.
const stack: symbol[] = [];
let locked = 0;
let previousOverflow = "";

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "role"> {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** `danger` tints the header, for destructive dialogs. */
  tone?: "default" | "danger";
  /** Close on Escape and on a backdrop press. Default true. */
  dismissible?: boolean;
  /** The close button's accessible name. Default "Close". */
  closeLabel?: string;
  /** Hide the close button (the footer closes it). */
  hideClose?: boolean;
  /**
   * Where the dialog is portalled. Default `document.body`. Pass the themed
   * element when a theme is scoped to a subtree rather than `:root`.
   */
  container?: Element | null;
  children?: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  footer,
  size = "md",
  tone = "default",
  dismissible = true,
  closeLabel = "Close",
  hideClose,
  container,
  className,
  children,
  onKeyDown,
  ...rest
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const idRef = useRef<symbol | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    if (!open) return;
    const id = Symbol("dialog");
    idRef.current = id;
    stack.push(id);
    if (locked++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const previous = deepActiveElement() as HTMLElement | null;
    const node = ref.current;
    const raf = requestAnimationFrame(() => {
      if (!node) return;
      const body = bodyRef.current;
      const target =
        node.querySelector<HTMLElement>("[data-autofocus]") ?? (body ? focusables(body)[0] : undefined) ?? node;
      target.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (--locked === 0) document.body.style.overflow = previousOverflow;
      if (previous && previous.isConnected && !node?.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const topmost = () => stack[stack.length - 1] === idRef.current;
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      if (dismissible && topmost()) {
        e.stopPropagation();
        onCloseRef.current();
      }
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
  };

  return createPortal(
    <div
      className="tui-overlay"
      onMouseDown={(e) => {
        // Only a press that starts on the backdrop itself (not a drag out of the dialog).
        if (e.target === e.currentTarget && dismissible && topmost()) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={cn("tui-dialog", className)}
        data-size={size === "md" ? undefined : size}
        data-tone={tone === "default" ? undefined : tone}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        <div className="tui-dialog-header">
          <div className="tui-dialog-heading">
            <h2 className="tui-dialog-title" id={titleId}>
              {title}
            </h2>
            {subtitle ? (
              <p className="tui-dialog-subtitle" id={subtitleId}>
                {subtitle}
              </p>
            ) : null}
          </div>
          {hideClose ? null : (
            <IconButton label={closeLabel} onClick={() => onCloseRef.current()}>
              <CloseIcon />
            </IconButton>
          )}
        </div>
        <div ref={bodyRef} className="tui-dialog-body">
          {children}
        </div>
        {footer ? <div className="tui-dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    container ?? document.body,
  );
}
