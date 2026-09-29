"use client";
/**
 * Text inputs, textareas, selects, checkboxes and radios. Inside a `Field`
 * they pick up its id, description and error state.
 */
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../cn.ts";
import { useFieldControl } from "./field.tsx";
import { ChevronDownIcon } from "./icons.tsx";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  /** A leading icon (search, mail…), drawn inside the field. */
  icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", icon, className, ...rest },
  ref,
) {
  const props = useFieldControl(rest);
  const input = (
    <input ref={ref} className={cn("tui-input", className)} data-size={size === "md" ? undefined : size} {...props} />
  );
  if (!icon) return input;
  return (
    <span className="tui-input-wrap">
      {icon}
      {input}
    </span>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  const props = useFieldControl(rest);
  return <textarea ref={ref} className={cn("tui-textarea", className)} {...props} />;
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md";
  /** Class for the wrapper (width, layout); `className` goes on the `<select>`. */
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = "md", className, wrapperClassName, children, ...rest },
  ref,
) {
  const props = useFieldControl(rest);
  return (
    <span className={cn("tui-select-wrap", wrapperClassName)}>
      <select ref={ref} className={cn("tui-select", className)} data-size={size === "md" ? undefined : size} {...props}>
        {children}
      </select>
      <ChevronDownIcon />
    </span>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
  /** Class for the `<label>` wrapper. */
  wrapperClassName?: string;
}

/** A checkbox with its label; `Radio` is the same with `type="radio"`. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(props, ref) {
  return <Check ref={ref} type="checkbox" {...props} />;
});

export const Radio = forwardRef<HTMLInputElement, CheckboxProps>(function Radio(props, ref) {
  return <Check ref={ref} type="radio" {...props} />;
});

const Check = forwardRef<HTMLInputElement, CheckboxProps & { type: "checkbox" | "radio" }>(function Check(
  { label, description, wrapperClassName, className, ...rest },
  ref,
) {
  return (
    <label className={cn("tui-check", wrapperClassName)}>
      <input ref={ref} className={className} {...rest} />
      {description ? (
        <span className="tui-check-text">
          <span>{label}</span>
          <span className="tui-hint">{description}</span>
        </span>
      ) : (
        <span>{label}</span>
      )}
    </label>
  );
});
