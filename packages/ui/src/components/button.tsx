/**
 * Buttons. `Button` for actions (primary, secondary, soft, ghost, danger),
 * `IconButton` for icon-only controls (the label is required: it is the
 * accessible name), `Spinner` for busy states. `asChild` renders a router
 * link (or anything) with the button's look.
 */
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn, flag } from "../cn.ts";
import { Slot } from "./slot.tsx";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger" | "danger-solid";
export type ControlSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Full width. */
  block?: boolean;
  /** Shows a spinner and ignores clicks, but stays focusable so focus isn't lost. */
  busy?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  /** Render the single child (e.g. a `<Link>`) with the button's look instead of a `<button>`. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    block,
    busy,
    iconStart,
    iconEnd,
    asChild,
    className,
    children,
    type,
    onClick,
    ...rest
  },
  ref,
) {
  const props = {
    className: cn("tui-btn", className),
    "data-variant": variant === "primary" ? undefined : variant,
    "data-size": size === "md" ? undefined : size,
    "data-block": flag(block),
    "aria-busy": busy || undefined,
    "aria-disabled": busy || undefined,
    ...rest,
  };
  if (asChild) return <Slot {...props}>{children}</Slot>;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...props}
    >
      {busy ? <Spinner /> : iconStart}
      {children}
      {iconEnd}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The accessible name (and the tooltip). */
  label: string;
  size?: ControlSize;
  shape?: "square" | "circle";
  asChild?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", shape = "square", asChild, className, children, type, title, ...rest },
  ref,
) {
  const props = {
    className: cn("tui-icon-btn", className),
    "aria-label": label,
    title: title ?? label,
    "data-size": size === "md" ? undefined : size,
    "data-shape": shape === "square" ? undefined : shape,
    ...rest,
  };
  if (asChild) return <Slot {...props}>{children}</Slot>;
  return (
    <button ref={ref} type={type ?? "button"} {...props}>
      {children}
    </button>
  );
});

export function Spinner({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("tui-spinner", className)} aria-hidden="true" {...rest} />;
}
