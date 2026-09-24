"use client";
/**
 * Triggers: the floating button, `<SpotterTrigger asChild>` for the host's
 * own links and menu items, and the global ones (keyboard shortcut, selector
 * binding, shake / long-press) that `<SpotterPanel>` installs at idle.
 *
 * The floating button mounts after idle into the Shadow DOM host and is
 * `position: fixed`, so it can never shift layout (zero CLS). Hovering or
 * focusing any trigger warms the panel chunk and core, so the click itself
 * only has to render.
 *
 * Kept deliberately small — this file is most of the loader. Targeting,
 * shortcut parsing and gestures live in chunks loaded at idle.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { FEATURE_WIDGET } from "../../core/features.ts";
import type { OpenOptions } from "../../core/types.ts";
import * as bridge from "./internal/bridge.ts";
import { startFlow, warm } from "./internal/controller.ts";
import { whenIdle } from "./internal/idle.ts";
import { peekUiRoot, type UiRoot } from "./internal/root-ref.ts";
import { getServerSnapshot, getSnapshot, subscribe } from "./internal/store.ts";
import { TriggerIcon } from "./internal/trigger-icon.tsx";
import { useSpotterContext } from "./provider.tsx";
import type { TriggerRuntime } from "./theme/trigger-runtime.ts";

export type ElementTarget = string | Element | null | (() => Element | null);

function resolveElement(target: ElementTarget | undefined): Element | null {
  if (!target) return null;
  if (typeof target === "string") return document.querySelector(target);
  if (typeof target === "function") return target();
  return target;
}

/** Open the widget from any trigger; element reports skip the picker. */
export function openFrom(opener: Element | null, options: OpenOptions = {}, element?: ElementTarget): void {
  startFlow(options, opener, resolveElement(element));
  // Mirror to the client so `on('open')` listeners see widget opens too; the flow is already open, so our own listener no-ops.
  try {
    const c = bridge.peekClient();
    if (c?.initialized) c.open(options);
  } catch {
    /* mirror only */
  }
}

// -- <SpotterTrigger asChild> ------------------------------------------------------------------

export interface SpotterTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Merge behaviour into the single child (a link, menu item, your own button) instead of rendering a `<button>`. */
  asChild?: boolean;
  mode?: OpenOptions["mode"];
  prefill?: OpenOptions["prefill"];
  /** Report about a specific element (selector, node, or getter): its selector and nearby DOM go with the report. */
  element?: ElementTarget;
  children?: ReactNode;
}

type Handler = ((e: never) => void) | undefined;

/** Call every handler in order; stop before ours if one called `preventDefault()`. */
function chain(...fns: Handler[]): (e: never) => void {
  return (e) => {
    for (const fn of fns) fn?.(e);
  };
}

export function SpotterTrigger({ asChild, mode, prefill, element, children, onClick, onPointerEnter, onFocus, ...rest }: SpotterTriggerProps) {
  if (!FEATURE_WIDGET) return asChild && isValidElement(children) ? children : null;
  const child = asChild ? (Children.only(children) as ReactElement<Record<string, unknown>>) : null;
  const own = child?.props ?? {};
  const open = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    e.preventDefault(); // An `<a href>` child must not navigate.
    openFrom(e.currentTarget, { mode, prefill }, element);
  };
  const merged = {
    "aria-haspopup": "dialog" as const,
    onClick: chain(own.onClick as Handler, onClick as Handler, open as Handler),
    onPointerEnter: chain(own.onPointerEnter as Handler, onPointerEnter as Handler, warm),
    onFocus: chain(own.onFocus as Handler, onFocus as Handler, warm),
  };
  if (child) return cloneElement(child, { ...rest, ...merged });
  return (
    <button type="button" {...rest} {...merged}>
      {children}
    </button>
  );
}

// -- shared idle runtime ----------------------------------------------------------------------------

/** The idle-time runtime (theme, trigger CSS, locale, targeting), shared page-wide. */
export function useTriggerRuntime(): { rt: TriggerRuntime | null; root: UiRoot | null } {
  const { config, nonce } = useSpotterContext();
  const [state, setState] = useState<{ rt: TriggerRuntime | null; root: UiRoot | null }>({ rt: null, root: null });
  useEffect(() => {
    let alive = true;
    const cancel = whenIdle(() => {
      void import("./theme/trigger-runtime.ts")
        .then((m) => m.ensureRuntime({ appearance: config.appearance, locale: config.locale, localization: config.localization, nonce }))
        .then((rt) => {
          if (alive) setState({ rt, root: peekUiRoot() });
        });
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [config.appearance, config.locale, config.localization, nonce]);
  return state;
}

/** Re-render when remote config arrives (it may hide the trigger or add a shortcut). */
function useRemoteVersion(): number {
  const [v, setV] = useState(0);
  const ready = useSyncExternalStore(subscribe, () => getSnapshot().ready, () => false);
  useEffect(() => {
    const c = bridge.peekClient();
    if (!ready || !c) return;
    setV((n) => n + 1);
    return c.on("config", () => setV((n) => n + 1));
  }, [ready]);
  return v;
}

// -- floating button ---------------------------------------------------------------------------

export interface SpotterButtonProps {
  /** Visible text beside the icon. Default: icon only (`appearance.layout.label`). */
  label?: string;
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Distance from the corner, px. Default 20. */
  offset?: number;
  mode?: OpenOptions["mode"];
}

export function SpotterButton({ label, position, offset, mode }: SpotterButtonProps) {
  const { config } = useSpotterContext();
  const { rt, root } = useTriggerRuntime();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const pathname = usePathname() ?? "/";
  useRemoteVersion();
  if (!FEATURE_WIDGET || !rt || !root) return null;

  const remote = bridge.remoteConfig();
  if ((config.trigger?.type ?? remote?.trigger?.type ?? "floating") !== "floating") return null;
  const c = bridge.peekClient();
  if (c && !c.enabled("widget")) return null;
  const visible = rt.visible([config.trigger?.targeting, remote?.trigger?.targeting], {
    path: pathname,
    environment: config.environment,
    release: config.release?.version,
    reporter: { identified: !!bridge.identity(), type: snap.reporter },
  });
  if (!visible) return null;

  const layout = config.appearance?.layout;
  const text = label ?? layout?.label;
  const off = offset ?? layout?.offset;
  const keys = rt.shortcut(config.trigger?.shortcut ?? remote?.trigger?.shortcut);
  const name = text ?? rt.t("trigger.label");
  const el = config.appearance?.elements?.trigger;
  return createPortal(
    <button
      type="button"
      className={typeof el === "string" ? `sp-trigger ${el}` : "sp-trigger"}
      style={{ ...(typeof el === "object" ? el : null), ...(off !== undefined ? ({ "--sp-offset": `${off}px` } as object) : null) }}
      data-spotter-part="trigger"
      data-position={position ?? layout?.position ?? "bottom-right"}
      data-labelled={text ? "" : undefined}
      aria-label={text ? undefined : name}
      aria-haspopup="dialog"
      aria-expanded={snap.open}
      aria-keyshortcuts={keys?.aria}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={(e) => openFrom(e.currentTarget, { mode })}
    >
      <TriggerIcon />
      {text ? (
        <span className="sp-trigger-label">{text}</span>
      ) : (
        <span className="sp-tip" aria-hidden="true">
          {name}
          {keys ? <kbd>{keys.label}</kbd> : null}
        </span>
      )}
    </button>,
    root.container,
  );
}

// -- global triggers -------------------------------------------------------------------------------

/** Keyboard shortcut, selector binding and gestures, installed at idle by `<SpotterPanel>`. */
export function useGlobalTriggers(): void {
  const { config } = useSpotterContext();
  const remoteV = useRemoteVersion();
  const trigger = config.trigger;
  useEffect(() => {
    if (!FEATURE_WIDGET) return;
    const remote = bridge.remoteConfig()?.trigger;
    const custom = trigger?.type && trigger.type !== "floating" && trigger.type !== "none";
    if (!(trigger?.shortcut || remote?.shortcut || trigger?.shake || trigger?.longPress || remote?.shakeToReport || custom)) return;
    let dispose: (() => void) | undefined;
    let alive = true;
    const cancel = whenIdle(() => {
      void import("./internal/global-triggers.ts").then((m) => {
        if (alive) dispose = m.installGlobalTriggers({ trigger, remote, warm, open: (opener, el) => openFrom(opener, {}, el) });
      });
    });
    return () => {
      alive = false;
      cancel();
      dispose?.();
    };
  }, [trigger?.shortcut, trigger?.type, trigger?.shake, trigger?.longPress, remoteV]);
}
