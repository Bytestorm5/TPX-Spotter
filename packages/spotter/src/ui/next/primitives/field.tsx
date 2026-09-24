"use client";
/**
 * `Field` primitive: renders any custom field declaration (text, textarea,
 * select, multiselect, checkbox, rating, file) with its label, hint and
 * error wired up for assistive tech (`aria-describedby`, `aria-invalid`,
 * `aria-required`). Unstyled apart from the `sp-*` classes the styled panel
 * targets; visibility (`showWhen`) and validation live in
 * `internal/fields.ts` so they're shared with the submit path.
 */
import { useId, type ReactNode } from "react";
import type { CustomFieldDeclaration, FieldValue } from "../../../core/schema.ts";
import type { FieldIssue } from "../internal/fields.ts";
import { ChevronDown, StarIcon } from "../internal/icons.tsx";

export interface FieldLabels {
  optional: string;
  select: string;
  rating: (value: number, max: number) => string;
  file: string;
  fileNone: string;
  error: (issue: FieldIssue) => string;
}

const DEFAULT_LABELS: FieldLabels = {
  optional: "Optional",
  select: "Select…",
  rating: (v, m) => `${v} out of ${m}`,
  file: "Choose file",
  fileNone: "No file chosen",
  error: (i) => i.message ?? "Check this field.",
};

export interface FieldProps {
  field: CustomFieldDeclaration;
  value: FieldValue | undefined;
  onChange: (value: FieldValue, files?: File[]) => void;
  issue?: FieldIssue | null;
  labels?: Partial<FieldLabels>;
  /** Called on blur, for validate-on-blur. */
  onBlur?: () => void;
  id?: string;
}

export function Field({ field, value, onChange, issue, labels: partial, onBlur, id: idProp }: FieldProps) {
  const labels = { ...DEFAULT_LABELS, ...partial };
  const auto = useId();
  const id = idProp ?? `sp-f-${auto}`;
  const errorId = `${id}-err`;
  const hintId = `${id}-hint`;
  const described = [field.placeholder && field.type === "file" ? hintId : null, issue ? errorId : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    "aria-invalid": issue ? (true as const) : undefined,
    "aria-required": field.required || undefined,
    "aria-describedby": described,
    onBlur,
  };

  let control: ReactNode;
  switch (field.type) {
    case "text":
      control = (
        <input
          {...common}
          className="sp-input"
          data-spotter-part="input"
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "textarea":
      control = (
        <textarea
          {...common}
          className="sp-textarea"
          data-size="sm"
          data-spotter-part="textarea"
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "select":
      control = (
        <div className="sp-select-wrap">
          <select
            {...common}
            className="sp-select"
            data-spotter-part="select"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">{field.placeholder ?? labels.select}</option>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown />
        </div>
      );
      break;
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      control = (
        <div className="sp-chips" role="group" aria-labelledby={`${id}-label`} aria-describedby={described} data-spotter-part="chips">
          {field.options?.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                className="sp-chip"
                aria-pressed={on}
                onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case "checkbox":
      // The label is the checkbox's own text; no separate label row.
      return (
        <div className="sp-field" data-spotter-part="field">
          <label className="sp-check">
            <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span>{field.label}</span>
          </label>
          {issue ? (
            <p id={errorId} className="sp-error" role="alert">
              {labels.error(issue)}
            </p>
          ) : null}
        </div>
      );
    case "rating": {
      const max = field.validation?.max ?? 5;
      const current = typeof value === "number" ? value : 0;
      control = (
        <div className="sp-rating" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={described} data-spotter-part="rating">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              className="sp-star"
              aria-checked={current === n}
              aria-label={labels.rating(n, max)}
              data-on={n <= current ? "" : undefined}
              tabIndex={current === n || (current === 0 && n === 1) ? 0 : -1}
              onClick={() => onChange(n)}
              onKeyDown={(e) => {
                const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? Math.min(max, n + 1) : e.key === "ArrowLeft" || e.key === "ArrowDown" ? Math.max(1, n - 1) : null;
                if (next === null) return;
                e.preventDefault();
                onChange(next);
                const sib = (e.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined) ?? null;
                sib?.focus();
              }}
            >
              <StarIcon />
            </button>
          ))}
        </div>
      );
      break;
    }
    case "file": {
      const names = Array.isArray(value) ? value : [];
      control = (
        <div className="sp-file">
          <label className="sp-btn sp-btn-secondary sp-btn-sm">
            <input
              {...common}
              type="file"
              multiple={(field.validation?.max ?? 1) > 1}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                onChange(files.length ? files.map((f) => f.name) : null, files);
              }}
            />
            {labels.file}
          </label>
          <span aria-live="polite">{names.length ? names.join(", ") : labels.fileNone}</span>
        </div>
      );
      break;
    }
  }

  return (
    <div className="sp-field" data-spotter-part="field">
      <div className="sp-label-row">
        {field.type === "multiselect" || field.type === "rating" ? (
          <span id={`${id}-label`} className="sp-label" data-spotter-part="label">
            {field.label}
          </span>
        ) : (
          <label id={`${id}-label`} htmlFor={id} className="sp-label" data-spotter-part="label">
            {field.label}
          </label>
        )}
        {!field.required ? <span className="sp-optional">{labels.optional}</span> : null}
      </div>
      {control}
      {issue ? (
        <p id={errorId} className="sp-error" role="alert" data-spotter-part="error">
          {labels.error(issue)}
        </p>
      ) : null}
    </div>
  );
}
