"use client";
/**
 * `Field`: a label, the control, a hint and an error — wired together. The
 * control inside (`Input`, `Textarea`, `Select`, or anything calling
 * `useFieldControl`) gets the field's id, `aria-describedby` pointing at the
 * hint and error, `aria-invalid` when there is an error, and `required`.
 */
import { createContext, useContext, useId, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn.ts";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: ReactNode;
  /** The control's id; generated when absent. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Shows "Optional" (or your text) beside the label. */
  optional?: boolean | ReactNode;
  /** Visually hide the label (it still names the control). */
  hideLabel?: boolean;
  /** Extra props for the label and the error message (a class, a data attribute, a style). */
  labelProps?: PartProps;
  errorProps?: PartProps;
  children: ReactNode;
}

type PartProps = { className?: string; style?: CSSProperties; [data: `data-${string}`]: string | undefined };

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  optional,
  hideLabel,
  labelProps,
  errorProps,
  className,
  children,
  ...rest
}: FieldProps) {
  const auto = useId();
  const id = htmlFor ?? `tui-${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required: Boolean(required) }}>
      <div className={cn("tui-field", className)} {...rest}>
        <div className={cn("tui-label-row", hideLabel && "tui-sr-only")}>
          <label {...labelProps} className={cn("tui-label", labelProps?.className)} htmlFor={id}>
            {label}
            {required ? (
              <span className="tui-required" aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
          {optional ? <span className="tui-optional">{optional === true ? "Optional" : optional}</span> : null}
        </div>
        {children}
        {hint ? (
          <p className="tui-hint" id={hintId}>
            {hint}
          </p>
        ) : null}
        {error ? (
          <p {...errorProps} className={cn("tui-error", errorProps?.className)} id={errorId} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** The props a control inside a `Field` should carry; its own props win. */
export function useFieldControl<
  P extends { id?: string; "aria-describedby"?: string; "aria-invalid"?: unknown; required?: boolean },
>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-describedby": [field.describedBy, props["aria-describedby"]].filter(Boolean).join(" ") || undefined,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
    required: props.required ?? (field.required || undefined),
  };
}
