/**
 * Custom field logic: conditional visibility (`showWhen`) and validation.
 * Pure, shared by the `Field` primitive and the submit path, so a hidden
 * field is neither validated nor sent.
 */
import type { CustomFieldDeclaration, FieldValue } from "../../../core/schema.ts";

/** Pseudo-fields a `showWhen` may reference beside declared field ids. */
export interface FieldScope {
  category?: string;
  severity?: string;
  values: Record<string, FieldValue | undefined>;
}

function asStrings(v: FieldValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

export function isFieldVisible(field: CustomFieldDeclaration, scope: FieldScope, all?: readonly CustomFieldDeclaration[]): boolean {
  const cond = field.showWhen;
  if (!cond) return true;
  let source: FieldValue | undefined;
  if (cond.field === "category") source = scope.category;
  else if (cond.field === "severity") source = scope.severity;
  else {
    // A field that depends on a hidden field is hidden too (chains collapse together).
    const parent = all?.find((f) => f.id === cond.field);
    if (parent && all && !isFieldVisible(parent, scope, all.filter((f) => f !== field))) return false;
    source = scope.values[cond.field];
  }
  const wanted = Array.isArray(cond.equals) ? cond.equals : [cond.equals];
  const have = asStrings(source);
  return have.some((v) => wanted.includes(v));
}

export type FieldError = "required" | "pattern" | "min" | "max" | "option" | "email";

export interface FieldIssue {
  code: FieldError;
  /** The declaration's own message, when it set one. */
  message?: string;
}

function isEmpty(v: FieldValue | undefined): boolean {
  return v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/**
 * Validate one value. `min`/`max` mean: length for text, count for
 * multiselect, value for rating, number of files for file fields.
 */
export function validateField(field: CustomFieldDeclaration, value: FieldValue | undefined): FieldIssue | null {
  const msg = field.validation?.message;
  const fail = (code: FieldError): FieldIssue => (msg ? { code, message: msg } : { code });
  // A rating of 0 is "not rated yet".
  if (isEmpty(value) || (field.type === "rating" && value === 0)) return field.required ? fail("required") : null;
  const v = field.validation;
  switch (field.type) {
    case "text":
    case "textarea": {
      const s = String(value);
      if (v?.pattern) {
        let re: RegExp | null = null;
        try {
          re = new RegExp(`^(?:${v.pattern})$`, "u");
        } catch {
          re = null; // A bad pattern from remote config must not block every submit.
        }
        if (re && !re.test(s)) return fail("pattern");
      }
      if (v?.min !== undefined && s.trim().length < v.min) return fail("min");
      if (v?.max !== undefined && s.length > v.max) return fail("max");
      return null;
    }
    case "select": {
      if (field.options && !field.options.some((o) => o.value === value)) return fail("option");
      return null;
    }
    case "multiselect": {
      const arr = asStrings(value);
      if (field.options && arr.some((x) => !field.options!.some((o) => o.value === x))) return fail("option");
      if (v?.min !== undefined && arr.length < v.min) return fail("min");
      if (v?.max !== undefined && arr.length > v.max) return fail("max");
      return null;
    }
    case "rating": {
      const n = Number(value);
      const max = v?.max ?? 5;
      const min = v?.min ?? 1;
      if (!Number.isFinite(n) || n < min) return fail("min");
      if (n > max) return fail("max");
      return null;
    }
    case "checkbox":
      return null;
    case "file": {
      const n = asStrings(value).length;
      if (v?.max !== undefined && n > v.max) return fail("max");
      return null;
    }
  }
  return null;
}

/** Validate every visible field; hidden fields are skipped. */
export function validateFields(
  fields: readonly CustomFieldDeclaration[],
  scope: FieldScope,
): Record<string, FieldIssue> {
  const out: Record<string, FieldIssue> = {};
  for (const f of fields) {
    if (!isFieldVisible(f, scope, fields)) continue;
    const issue = validateField(f, scope.values[f.id]);
    if (issue) out[f.id] = issue;
  }
  return out;
}

/** The values to send: visible fields only, empty ones as `null` so the ticket's shape is stable. */
export function visibleValues(fields: readonly CustomFieldDeclaration[], scope: FieldScope): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (!isFieldVisible(f, scope, fields)) continue;
    const v = scope.values[f.id];
    out[f.id] = v === undefined ? (f.type === "checkbox" ? false : null) : v;
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}
