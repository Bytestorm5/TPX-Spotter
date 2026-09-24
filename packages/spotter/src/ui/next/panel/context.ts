/**
 * Panel-wide context: translator, config and the `part()` helper that
 * applies `appearance.elements` — per-part class names (Tailwind, CSS
 * modules) or style objects — on top of the default classes. Every part also
 * carries `data-spotter-part="<name>"`, a stable hook for custom CSS.
 */
import { createContext, useContext, type CSSProperties } from "react";
import type { Appearance } from "../../../core/schema.ts";
import type { SpotterConfig } from "../../../core/types.ts";
import type { Translate } from "../locales/index.ts";

export interface PartProps {
  className?: string;
  style?: CSSProperties;
  "data-spotter-part": string;
}

export type PartFn = (name: string, base?: string) => PartProps;

export function makePart(elements: Appearance["elements"] | undefined): PartFn {
  return (name, base = "") => {
    const e = elements?.[name];
    // Unstyled mode keeps the sp-* classes too: without CSS they cost nothing and give custom styles a hook.
    const cls = [base, typeof e === "string" ? e : ""].filter(Boolean).join(" ");
    const out: PartProps = { "data-spotter-part": name };
    if (cls) out.className = cls;
    if (e && typeof e === "object") out.style = e as CSSProperties;
    return out;
  };
}

export interface PanelContextValue {
  t: Translate;
  config: SpotterConfig;
  part: PartFn;
  unstyled: boolean;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const v = useContext(PanelContext);
  if (!v) throw new Error("Spotter panel parts must render inside the panel");
  return v;
}
