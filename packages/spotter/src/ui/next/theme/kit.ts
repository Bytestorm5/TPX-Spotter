/**
 * The widget's controls are `@trusplex/ui` components, styled by the kit's
 * own stylesheet inside the shadow root. This bridge defines every `--tui-*`
 * token in terms of the widget's `--sp-*` theme (tokens.ts: scheme, preset,
 * inherited host font and accent, `appearance.variables`), so one theme
 * drives both the panel's own parts and the kit's.
 *
 * It sits on `:host`, so a host page that uses the kit with its own
 * `--tui-*` values can't leak them into the widget through inheritance.
 */
import { KIT_CSS } from "@trusplex/ui/css";

const BRIDGE: Record<string, string> = {
  canvas: "var(--sp-bg)",
  bg: "var(--sp-bg)",
  surface: "var(--sp-surface)",
  "surface-hover": "var(--sp-surface-hover)",
  border: "var(--sp-border)",
  "border-strong": "var(--sp-border-strong)",
  text: "var(--sp-text)",
  "text-muted": "var(--sp-text-muted)",
  primary: "var(--sp-primary)",
  "primary-hover": "var(--sp-primary-hover)",
  "primary-text": "var(--sp-primary-text)",
  "primary-soft": "var(--sp-surface-hover)",
  "primary-soft-text": "var(--sp-text)",
  danger: "var(--sp-danger)",
  "danger-surface": "var(--sp-danger-surface)",
  success: "var(--sp-success)",
  "success-surface": "var(--sp-success-surface)",
  warning: "var(--sp-warning)",
  "warning-surface": "color-mix(in srgb, var(--sp-warning) 12%, var(--sp-bg))",
  info: "var(--sp-ring)",
  "info-surface": "color-mix(in srgb, var(--sp-ring) 10%, var(--sp-bg))",
  overlay: "var(--sp-overlay)",
  ring: "var(--sp-ring)",
  radius: "var(--sp-radius)",
  "radius-button": "var(--sp-radius)",
  "radius-chip": "var(--sp-radius-chip)",
  "radius-card": "calc(var(--sp-radius) + 2px)",
  "radius-panel": "var(--sp-radius-panel)",
  "shadow-control": "0 1px 2px rgba(0,0,0,.03)",
  "shadow-card": "none",
  "shadow-panel": "var(--sp-shadow-panel)",
  "border-width": "var(--sp-border-width)",
  font: "var(--sp-font)",
  "font-display": "var(--sp-font)",
  "font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "font-size": "14px",
  "font-size-sm": "13px",
  "font-size-xs": "12px",
  "weight-medium": "500",
  "weight-strong": "600",
  "control-height": "38px",
  "control-height-sm": "30px",
  "control-height-lg": "46px",
};

export const KIT_BRIDGE_CSS = `:host{${Object.entries(BRIDGE)
  .map(([k, v]) => `--tui-${k}:${v}`)
  .join(";")}}`;

/** The kit's stylesheet plus the bridge: install before the panel's own CSS so the panel's rules win. */
export const WIDGET_KIT_CSS = `${KIT_CSS}${KIT_BRIDGE_CSS}`;
