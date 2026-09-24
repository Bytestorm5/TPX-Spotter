"use client";
/**
 * `<SpotterStatus />` — the in-app status badge. Place it anywhere (a nav
 * bar, an account menu). It renders inline in its own shadow root, shows
 * how many of this reporter's recent reports changed status since they last
 * looked, and opens a list with each report's status and, for "needs info",
 * the team's question with an inline reply box.
 *
 * Polls only while the tab is visible, at most every `pollSeconds`, and only
 * for reports filed from this browser (the client keeps their capability
 * tokens). The heavy part is lazy.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { FEATURE_WIDGET } from "../../core/features.ts";
import { useSpotterContext } from "./provider.tsx";

export interface SpotterStatusProps {
  /** Poll interval while visible. Default 60 s. */
  pollSeconds?: number;
  /** How many recent reports to track. Default 5. */
  limit?: number;
}

export interface StatusWidgetProps extends Required<SpotterStatusProps> {
  shadow: ShadowRoot;
  container: HTMLElement;
  config: import("../../core/types.ts").SpotterConfig;
  nonce?: string;
}

declare const __SPOTTER_WIDGET__: boolean | undefined;

/** Inline guard so an unused widget build drops the chunk entirely (see `features.ts`). */
const LazyStatus =
  (typeof __SPOTTER_WIDGET__ === "boolean" ? __SPOTTER_WIDGET__ : true) && FEATURE_WIDGET
    ? lazy(() => import("./panel/status-widget.tsx").then((m) => ({ default: m.StatusWidget as ComponentType<StatusWidgetProps> })))
    : null;

export function SpotterStatus({ pollSeconds = 60, limit = 5 }: SpotterStatusProps) {
  const { config, nonce } = useSpotterContext();
  const hostRef = useRef<HTMLSpanElement>(null);
  const [mount, setMount] = useState<{ shadow: ShadowRoot; container: HTMLElement } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !FEATURE_WIDGET) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    let container = shadow.querySelector<HTMLElement>(".sp-root");
    if (!container) {
      container = document.createElement("span");
      container.className = "sp-root";
      shadow.appendChild(container);
    }
    setMount({ shadow, container });
  }, []);
  if (!LazyStatus) return null;
  return (
    // No style attribute here: it would be server-rendered, and strict CSPs block inline style attributes.
    <span ref={hostRef} data-spotter-ui="" data-spotter-part="statusHost">
      {mount
        ? createPortal(
            <Suspense fallback={null}>
              <LazyStatus
                shadow={mount.shadow}
                container={mount.container}
                pollSeconds={pollSeconds}
                limit={limit}
                config={config}
                nonce={nonce}
              />
            </Suspense>,
            mount.container,
          )
        : null}
    </span>
  );
}
