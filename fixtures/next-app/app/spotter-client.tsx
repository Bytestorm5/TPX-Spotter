"use client";
/**
 * The app's Spotter setup. A client component because `beforeSend` is a
 * function; everything else could be passed from the server layout.
 */
import { useEffect, type ReactNode } from "react";
import { spotter } from "@trusplex/spotter/core";
import { Spotter, SpotterProvider } from "@trusplex/spotter/ui/next";
import type { Appearance, CustomFieldDeclaration } from "@trusplex/spotter/core";

export interface Variant {
  locale?: string;
  theme?: "light" | "dark";
  mode?: "unstyled";
  preset?: Appearance["preset"];
  review?: boolean;
  identify?: boolean;
  fields?: boolean;
  shortcut?: boolean;
}

const FIELDS: CustomFieldDeclaration[] = [
  {
    id: "order_number",
    label: "Order number",
    type: "text",
    placeholder: "ORD-1234",
    required: true,
    showWhen: { field: "category", equals: "bug" },
    validation: { pattern: "ORD-\\d{4}", message: "Use the format ORD-1234" },
  },
  {
    id: "plan",
    label: "Your plan",
    type: "select",
    options: [
      { value: "free", label: "Free" },
      { value: "pro", label: "Pro" },
    ],
  },
  { id: "rating", label: "How bad is it?", type: "rating", validation: { max: 5 } },
];

function Identify() {
  useEffect(() => {
    spotter.identify({ id: "user_42", email: "ada@example.com", name: "Ada Lovelace", plan: "pro" });
  }, []);
  return null;
}

export function SpotterSetup({ variant, children }: { variant: Variant; children: ReactNode }) {
  return (
    <SpotterProvider
      environment="development"
      locale={variant.locale}
      replay={{ mode: "buffer", windowSeconds: 60 }}
      privacy={{ maskText: "inputs", reviewBeforeSend: variant.review }}
      trigger={{ shortcut: variant.shortcut ? "Shift+Alt+B" : undefined }}
      fields={variant.fields ? FIELDS : undefined}
      appearance={{
        mode: variant.mode,
        preset: variant.preset,
        // Auto by default: follows the site's own `class="dark"`.
        theme: "auto",
      }}
      beforeSend={(report) => {
        report.context.tags.fixture = "next-app";
        return report;
      }}
    >
      {variant.identify ? <Identify /> : null}
      {children}
      <Spotter />
    </SpotterProvider>
  );
}
