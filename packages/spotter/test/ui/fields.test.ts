import { describe, expect, it } from "vitest";
import type { CustomFieldDeclaration } from "../../src/core/schema.ts";
import { isFieldVisible, isValidEmail, validateField, validateFields, visibleValues } from "../../src/ui/next/internal/fields.ts";

const order: CustomFieldDeclaration = {
  id: "order",
  label: "Order number",
  type: "text",
  required: true,
  showWhen: { field: "category", equals: "billing" },
  validation: { pattern: "ORD-\\d{4}", message: "Looks like ORD-1234" },
};
const plan: CustomFieldDeclaration = {
  id: "plan",
  label: "Plan",
  type: "select",
  options: [
    { value: "free", label: "Free" },
    { value: "pro", label: "Pro" },
  ],
};
const seats: CustomFieldDeclaration = { id: "seats", label: "Seats", type: "text", showWhen: { field: "plan", equals: ["pro"] } };
const seatNote: CustomFieldDeclaration = { id: "note", label: "Note", type: "textarea", showWhen: { field: "seats", equals: "many" } };

describe("conditional visibility", () => {
  it("shows a field only when the category matches", () => {
    expect(isFieldVisible(order, { category: "bug", values: {} })).toBe(false);
    expect(isFieldVisible(order, { category: "billing", values: {} })).toBe(true);
    expect(isFieldVisible(plan, { values: {} })).toBe(true);
  });

  it("follows other fields, with array equals", () => {
    expect(isFieldVisible(seats, { values: { plan: "free" } })).toBe(false);
    expect(isFieldVisible(seats, { values: { plan: "pro" } })).toBe(true);
    expect(isFieldVisible(seats, { values: { plan: ["free", "pro"] } })).toBe(true);
  });

  it("hides a field whose parent is hidden (chains collapse)", () => {
    const all = [plan, seats, seatNote];
    // seats has a stale value "many" but is hidden because plan is free → note hidden too.
    expect(isFieldVisible(seatNote, { values: { plan: "free", seats: "many" } }, all)).toBe(false);
    expect(isFieldVisible(seatNote, { values: { plan: "pro", seats: "many" } }, all)).toBe(true);
  });
});

describe("validation", () => {
  it("requires required fields, including false checkboxes and empty arrays", () => {
    expect(validateField(order, "")?.code).toBe("required");
    expect(validateField({ id: "c", label: "c", type: "checkbox", required: true }, false)?.code).toBe("required");
    expect(validateField({ id: "m", label: "m", type: "multiselect", required: true }, [])?.code).toBe("required");
    expect(validateField(plan, undefined)).toBeNull();
  });

  it("checks patterns (whole value) and carries the custom message", () => {
    expect(validateField(order, "ORD-12")).toEqual({ code: "pattern", message: "Looks like ORD-1234" });
    expect(validateField(order, "xORD-1234")).not.toBeNull();
    expect(validateField(order, "ORD-1234")).toBeNull();
  });

  it("ignores an invalid pattern instead of blocking every submit", () => {
    expect(validateField({ id: "x", label: "x", type: "text", validation: { pattern: "([" } }, "anything")).toBeNull();
  });

  it("checks lengths, options, counts and ratings", () => {
    const text: CustomFieldDeclaration = { id: "t", label: "t", type: "text", validation: { min: 3, max: 5 } };
    expect(validateField(text, "ab")?.code).toBe("min");
    expect(validateField(text, "abcdef")?.code).toBe("max");
    expect(validateField(text, "abcd")).toBeNull();
    expect(validateField(plan, "enterprise")?.code).toBe("option");
    const multi: CustomFieldDeclaration = { id: "m", label: "m", type: "multiselect", options: plan.options, validation: { max: 1 } };
    expect(validateField(multi, ["free", "pro"])?.code).toBe("max");
    expect(validateField(multi, ["gold"])?.code).toBe("option");
    const rating: CustomFieldDeclaration = { id: "r", label: "r", type: "rating", validation: { max: 5 } };
    expect(validateField(rating, 6)?.code).toBe("max");
    expect(validateField(rating, 0)).toBeNull(); // empty (0 is "not rated") when optional
    expect(validateField(rating, 4)).toBeNull();
  });

  it("skips hidden fields and sends only visible values", () => {
    const fields = [order, plan, seats];
    expect(validateFields(fields, { category: "bug", values: {} })).toEqual({});
    expect(Object.keys(validateFields(fields, { category: "billing", values: {} }))).toEqual(["order"]);
    expect(visibleValues(fields, { category: "bug", values: { order: "ORD-1111", plan: "pro", seats: "4" } })).toEqual({ plan: "pro", seats: "4" });
    expect(visibleValues([{ id: "c", label: "c", type: "checkbox" }], { values: {} })).toEqual({ c: false });
  });

  it("validates emails loosely", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail(" a@b.co ")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("nope")).toBe(false);
  });
});
