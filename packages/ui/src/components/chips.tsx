"use client";
/**
 * Chips: pill toggles. `Chip` is one toggle button (`pressed`), or a link
 * with `asChild` (a filter). `ChipGroup` is a single- or multi-select set
 * of them with arrow-key navigation, the widget's category picker.
 */
import { useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../cn.ts";
import { Slot } from "./slot.tsx";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  asChild?: boolean;
}

export function Chip({ pressed, asChild, className, children, type, ...rest }: ChipProps) {
  const props = { className: cn("tui-chip", className), "aria-pressed": pressed, ...rest };
  if (asChild) return <Slot {...props}>{children}</Slot>;
  return (
    <button type={type ?? "button"} {...props}>
      {children}
    </button>
  );
}

export interface ChipOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

interface ChipGroupBase<V extends string> {
  options: ChipOption<V>[];
  /** The group's accessible name. */
  label: string;
  className?: string;
}

export type ChipGroupProps<V extends string> = ChipGroupBase<V> &
  (
    | { multiple?: false; value: V | null; onChange: (value: V | null) => void; allowDeselect?: boolean }
    | { multiple: true; value: V[]; onChange: (value: V[]) => void }
  );

export function ChipGroup<V extends string>(props: ChipGroupProps<V>) {
  const { options, label, className } = props;
  const ref = useRef<HTMLDivElement>(null);
  const isOn = (v: V) => (props.multiple ? props.value.includes(v) : props.value === v);
  const toggle = (v: V) => {
    if (props.multiple) props.onChange(isOn(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    else props.onChange(isOn(v) && props.allowDeselect !== false ? null : v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const chips = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight") ? 1 : -1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? chips.length - 1 : (i + step + chips.length) % chips.length;
    chips[next]?.focus();
  };
  // Single-select is a radio group: one tab stop, on the selection (or the first chip).
  const tabStop = props.multiple
    ? null
    : (options.find((o) => o.value === props.value && !o.disabled) ?? options.find((o) => !o.disabled))?.value;
  return (
    <div
      ref={ref}
      className={cn("tui-chips", className)}
      role={props.multiple ? "group" : "radiogroup"}
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="tui-chip"
          role={props.multiple ? undefined : "radio"}
          aria-checked={props.multiple ? undefined : isOn(o.value)}
          aria-pressed={props.multiple ? isOn(o.value) : undefined}
          tabIndex={tabStop === null || tabStop === undefined || tabStop === o.value ? 0 : -1}
          disabled={o.disabled}
          onClick={() => toggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
