"use client";
/**
 * `<Spotter />` — the drop-in widget: the floating trigger plus the panel.
 * `<SpotterPanel />` — the panel alone (open it with `spotter.open()`,
 * `<SpotterTrigger>`, a shortcut or a bound selector).
 *
 * Both are shells: the panel's code (flow, annotation canvas, fields, CSS,
 * locales) is one lazy chunk, requested on trigger hover / focus or at the
 * first open, and never part of the initial bundle.
 */
import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { FEATURE_WIDGET } from "../../core/features.ts";
import { loadPanelChunk } from "./internal/controller.ts";
import { getServerSnapshot, getSnapshot, subscribe } from "./internal/store.ts";
import { useSpotterContext } from "./provider.tsx";
import { SpotterButton, useGlobalTriggers, type SpotterButtonProps } from "./triggers.tsx";
import type { PanelProps } from "./panel/index.tsx";

const LazyPanel = lazy(() =>
  loadPanelChunk().then((m) => ({ default: (m as { Panel: ComponentType<PanelProps> }).Panel })),
);

export interface SpotterPanelProps {
  /** Show a "Sign in as team" link in the footer. Default true. */
  teamSignIn?: boolean;
}

export function SpotterPanel(props: SpotterPanelProps) {
  const { config, nonce } = useSpotterContext();
  useGlobalTriggers();
  const open = useSyncExternalStore(subscribe, () => getSnapshot().open, () => getServerSnapshot().open);
  // Stay mounted after the first open: the close animation and a fast re-open reuse it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (!FEATURE_WIDGET || !mounted) return null;
  return (
    <Suspense fallback={null}>
      <LazyPanel config={config} nonce={nonce} teamSignIn={props.teamSignIn ?? true} />
    </Suspense>
  );
}

export interface SpotterProps extends SpotterButtonProps, SpotterPanelProps {}

export function Spotter(props: SpotterProps) {
  if (!FEATURE_WIDGET) return null;
  return (
    <>
      <SpotterButton label={props.label} position={props.position} offset={props.offset} mode={props.mode} />
      <SpotterPanel teamSignIn={props.teamSignIn} />
    </>
  );
}
