"use client";
/**
 * Small primitives: `Submit` (busy-aware submit button), `Status` (a
 * report's public status), and `LiveRegion` (screen-reader announcements for
 * capture, submit and errors).
 */
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PublicStatus } from "../../../core/schema.ts";

export interface SubmitProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  busyLabel?: ReactNode;
}

/** A submit button that stays focusable while busy (so focus isn't lost) but ignores clicks. */
export const Submit = forwardRef<HTMLButtonElement, SubmitProps>(function Submit(
  { busy, busyLabel, children, onClick, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="submit"
      aria-busy={busy || undefined}
      aria-disabled={busy || rest.disabled || undefined}
      data-spotter-part="submit"
      className={className}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {busy ? (
        <>
          <span className="sp-spinner" aria-hidden="true" />
          {busyLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
});

export interface StatusProps {
  status: PublicStatus;
  /** Localized label for the status. */
  label: string;
  className?: string;
}

export function Status({ status, label, className }: StatusProps) {
  return (
    <span className={className ?? "sp-status"} data-status={status} data-spotter-part="status">
      {label}
    </span>
  );
}

/**
 * A polite (or assertive) live region. Changing `message` announces it; the
 * brief clear-then-set makes a repeated message announce again.
 */
export function LiveRegion({ message, assertive }: { message: string; assertive?: boolean }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
    if (!message) return;
    const t = setTimeout(() => setText(message), 60);
    return () => clearTimeout(t);
  }, [message]);
  return (
    <div className="sp-sr" role={assertive ? "alert" : "status"} aria-live={assertive ? "assertive" : "polite"} aria-atomic="true">
      {text}
    </div>
  );
}
