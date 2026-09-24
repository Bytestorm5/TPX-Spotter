"use client";
/**
 * Triggers: the floating button, `<SpotterTrigger asChild>` for the host's
 * own links and menu items, and the global ones (keyboard shortcut, selector
 * binding, shake / long-press) that `<SpotterPanel>` installs.
 *
 * The floating button mounts after idle into the Shadow DOM host and is
 * `position: fixed`, so it can never shift layout (zero CLS). Hovering or
 * focusing any trigger warms the panel chunk and core, so the click itself
 * only has to render.
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
import { getUiRoot, whenIdle, type UiRoot } from "./internal/host.ts";
import { TriggerIcon } from "./internal/icons.tsx";
import { formatShortcut, isTypingTarget, matchesShortcut, parseShortcut } from "./internal/shortcut.ts";
import { getServerSnapshot, getSnapshot, subscribe } from "./internal/store.ts";
import { evaluateTargeting } from "./internal/targeting.ts";
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
  const el = resolveElement(element);
  if (el) return startFlow(options, opener, el);
  // Programmatic path first, so `on('open')` listeners see widget opens too.
  const c = bridge.peekClient();
  if (c?.initialized) {
    try {
      startFlow(options, opener);
      c.open(options);
      return;
    } catch {
      /* fall through */
    }
  }
  startFlow(options, opener);
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

type AnyProps = Record<string, unknown>;

export function SpotterTrigger({ asChild, mode, prefill, element, children, onClick, onPointerEnter, onFocus, ...rest }: SpotterTriggerProps) {
  if (!FEATURE_WIDGET) return asChild && isValidElement(children) ? children : null;
  const behaviour = {
    "aria-haspopup": "dialog" as const,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      (onClick as ((e: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(e);
      if (e.defaultPrevented) return;
      e.preventDefault(); // An `<a href>` child must not navigate.
      openFrom(e.currentTarget, { mode, prefill }, element);
    },
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      (onPointerEnter as ((e: React.PointerEvent<HTMLElement>) => void) | undefined)?.(e);
      warm();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      (onFocus as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
      warm();
    },
  };
  if (asChild) {
    const child = Children.only(children) as ReactElement<AnyProps>;
    const own = child.props;
    const merged: AnyProps = { ...rest, ...own, "aria-haspopup": "dialog" };
    for (const ev of ["onClick", "onPointerEnter", "onFocus"] as const) {
      const theirs = own[ev] as ((e: unknown) => void) | undefined;
      const ours = behaviour[ev] as (e: unknown) => void;
      merged[ev] = (e: unknown) => {
        theirs?.(e);
        ours(e);
      };
    }
    return cloneElement(child, merged);
  }
  return (
    <button type="button" {...rest} {...behaviour}>
      {children}
    </button>
  );
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

/** Load the idle-time runtime (theme, trigger CSS, locale) once per page. */
let runtimePromise: Promise<TriggerRuntime> | null = null;
export function useTriggerRuntime(): { rt: TriggerRuntime | null; root: UiRoot | null; scheme: "light" | "dark" } {
  const { config, nonce } = useSpotterContext();
  const [state, setState] = useState<{ rt: TriggerRuntime | null; root: UiRoot | null; scheme: "light" | "dark" }>({
    rt: null,
    root: null,
    scheme: "light",
  });
  useEffect(() => {
    let alive = true;
    const cancel = whenIdle(() => {
      const unstyled = config.appearance?.mode === "unstyled";
      const root = getUiRoot({ unstyled, nonce });
      runtimePromise ??= import("./theme/trigger-runtime.ts").then((m) =>
        m.loadTriggerRuntime({
          appearance: config.appearance,
          locale: config.locale,
          localization: config.localization,
          nonce,
          onScheme: (s) => root.container.setAttribute("data-scheme", s),
        }),
      );
      void runtimePromise.then((rt) => {
        if (!alive) return;
        const c = root.container;
        c.setAttribute("dir", rt.dir);
        c.setAttribute("lang", rt.locale);
        c.setAttribute("data-scheme", rt.scheme);
        setState({ rt, root, scheme: rt.scheme });
      });
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [config.appearance, config.locale, config.localization, nonce]);
  return state;
}

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

export function SpotterButton({ label, position, offset, mode }: SpotterButtonProps) {
  const { config } = useSpotterContext();
  const { rt, root } = useTriggerRuntime();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const pathname = usePathname() ?? "/";
  useRemoteVersion();
  if (!FEATURE_WIDGET || !rt || !root) return null;

  const remote = bridge.remoteConfig();
  const type = config.trigger?.type ?? remote?.trigger?.type ?? "floating";
  if (type !== "floating") return null;
  const c = bridge.peekClient();
  if (c && !c.enabled("widget")) return null;
  const ctx = {
    path: pathname,
    environment: config.environment,
    release: config.release?.version,
    reporter: { identified: !!bridge.identity(), type: snap.reporter },
  };
  if (!evaluateTargeting(config.trigger?.targeting, ctx) || !evaluateTargeting(remote?.trigger?.targeting, ctx)) return null;

  const layout = config.appearance?.layout;
  const text = label ?? layout?.label;
  const pos = position ?? layout?.position ?? "bottom-right";
  const off = offset ?? layout?.offset;
  const shortcut = parseShortcut(config.trigger?.shortcut ?? remote?.trigger?.shortcut ?? null, isApple());
  const name = text ?? rt.t("trigger.label");
  const el = config.appearance?.elements?.trigger;
  return createPortal(
    <button
      type="button"
      className={["sp-trigger", typeof el === "string" ? el : ""].filter(Boolean).join(" ")}
      style={{ ...(typeof el === "object" ? el : null), ...(off !== undefined ? ({ "--sp-offset": `${off}px` } as object) : null) }}
      data-spotter-part="trigger"
      data-position={pos}
      data-labelled={text ? "" : undefined}
      aria-label={text ? undefined : name}
      aria-haspopup="dialog"
      aria-expanded={snap.open}
      aria-keyshortcuts={shortcut ? formatShortcut(shortcut) : undefined}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={(e) => openFrom(e.currentTarget, { mode })}
    >
      <TriggerIcon />
      {text ? <span className="sp-trigger-label">{text}</span> : null}
      {!text ? (
        <span className="sp-tip" aria-hidden="true">
          {name}
          {shortcut ? <kbd>{formatShortcut(shortcut).replace(/\+/g, " ")}</kbd> : null}
        </span>
      ) : null}
    </button>,
    root.container,
  );
}

function isApple(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

// -- global triggers ---------------------------------------------------------------------------

/**
 * Keyboard shortcut, selector binding (`trigger: { type: '#report-link' }`),
 * and opt-in shake / two-finger long-press on touch devices. Installed once
 * by `<SpotterPanel>`.
 */
export function useGlobalTriggers(): void {
  const { config } = useSpotterContext();
  const remoteV = useRemoteVersion();
  const trigger = config.trigger;
  useEffect(() => {
    if (!FEATURE_WIDGET || typeof window === "undefined") return;
    const cleanups: (() => void)[] = [];
    const remote = bridge.remoteConfig()?.trigger;

    const shortcut = parseShortcut(trigger?.shortcut ?? remote?.shortcut ?? null, isApple());
    if (shortcut) {
      const onKey = (e: KeyboardEvent) => {
        if (!matchesShortcut(e, shortcut)) return;
        // Unmodified-by-Ctrl/Meta shortcuts must not fire while typing.
        if (isTypingTarget(e.composedPath()[0] ?? e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
        e.preventDefault();
        openFrom(document.activeElement);
      };
      window.addEventListener("keydown", onKey, true);
      cleanups.push(() => window.removeEventListener("keydown", onKey, true));
    }

    const type = trigger?.type;
    if (type && type !== "floating" && type !== "none") {
      const onClick = (e: MouseEvent) => {
        const hit = (e.target as Element | null)?.closest?.(type);
        if (!hit) return;
        e.preventDefault();
        openFrom(hit);
      };
      const onOver = (e: Event) => {
        if ((e.target as Element | null)?.closest?.(type)) warm();
      };
      document.addEventListener("click", onClick, true);
      document.addEventListener("pointerover", onOver, { passive: true });
      document.addEventListener("focusin", onOver);
      // Announce the bound element as a dialog opener.
      for (const el of document.querySelectorAll(type)) el.setAttribute("aria-haspopup", "dialog");
      cleanups.push(() => {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("pointerover", onOver);
        document.removeEventListener("focusin", onOver);
      });
    }

    if (trigger?.shake || remote?.shakeToReport) cleanups.push(installShake(() => openFrom(null)));
    if (trigger?.longPress) cleanups.push(installLongPress((el) => openFrom(el, {}, el)));
    return () => cleanups.forEach((f) => f());
  }, [trigger?.shortcut, trigger?.type, trigger?.shake, trigger?.longPress, remoteV]);
}

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * Shake to report. iOS gates motion events behind a permission prompt that
 * may only be requested inside a user gesture, so it is asked on the first
 * tap (once) rather than at load.
 */
function installShake(onShake: () => void): () => void {
  const DME = (window as unknown as { DeviceMotionEvent?: MotionPermission }).DeviceMotionEvent;
  if (!DME) return () => {};
  let hits: number[] = [];
  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity ?? e.acceleration;
    if (!a) return;
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    const now = Date.now();
    if (mag > 24) {
      hits = [...hits.filter((t) => now - t < 1000), now];
      if (hits.length >= 3) {
        hits = [];
        onShake();
      }
    }
  };
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    window.addEventListener("devicemotion", onMotion);
  };
  let asked = false;
  const onGesture = () => {
    if (asked) return;
    asked = true;
    document.removeEventListener("touchend", onGesture, true);
    DME.requestPermission?.().then((s) => s === "granted" && listen(), () => {});
  };
  if (typeof DME.requestPermission === "function") document.addEventListener("touchend", onGesture, true);
  else listen();
  return () => {
    document.removeEventListener("touchend", onGesture, true);
    window.removeEventListener("devicemotion", onMotion);
  };
}

/**
 * Two-finger long-press (700 ms) reports the element under the fingers.
 * Two fingers, because a one-finger long-press is the platform's text
 * selection / context-menu gesture and must stay the host's.
 */
function installLongPress(onPress: (el: Element | null) => void): () => void {
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
    start = null;
  };
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return cancel();
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    const target = document.elementFromPoint(t.clientX, t.clientY);
    timer = window.setTimeout(() => {
      cancel();
      onPress(target);
    }, 700);
  };
  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 12) cancel();
  };
  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    cancel();
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", cancel);
    document.removeEventListener("touchcancel", cancel);
  };
}
