"use client";
/**
 * The panel chunk's entry: installs the panel CSS, resolves locale and
 * theme (shared with the trigger), and portals the flow — or the element
 * picker — into the widget's shadow root.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { SpotterConfig } from "../../../core/types.ts";
import { beginCapture, closeFlow } from "../internal/controller.ts";
import { hasCss, peekUiRoot, setCss } from "../internal/host.ts";
import { getServerSnapshot, getSnapshot, subscribe } from "../internal/store.ts";
import { loadCanvas } from "../primitives/annotation.tsx";
import { PANEL_CSS } from "../theme/panel-css.ts";
import { ensureRuntime, type TriggerRuntime } from "../theme/trigger-runtime.ts";
import { makePart, PanelContext } from "./context.ts";
import { Flow } from "./flow.tsx";
import { Picker } from "./picker.tsx";

export interface PanelProps {
  config: SpotterConfig;
  nonce?: string;
  teamSignIn: boolean;
}

export function Panel({ config, nonce, teamSignIn }: PanelProps) {
  const [rt, setRt] = useState<TriggerRuntime | null>(null);
  const unstyled = config.appearance?.mode === "unstyled";
  useEffect(() => {
    let alive = true;
    // Warm the canvas chunk while the screenshot is being taken.
    void loadCanvas()?.catch(() => {});
    void ensureRuntime({ appearance: config.appearance, locale: config.locale, localization: config.localization, nonce }).then((r) => {
      if (!unstyled && !hasCss("panel")) setCss("panel", PANEL_CSS, nonce);
      if (alive) setRt(r);
    });
    return () => {
      alive = false;
    };
  }, [config.appearance, config.locale, config.localization, nonce, unstyled]);

  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ctx = useMemo(
    () => (rt ? { t: rt.t, config, part: makePart(config.appearance?.elements), unstyled } : null),
    [rt, config, unstyled],
  );
  const root = peekUiRoot();
  if (!ctx || !root || !snap.open) return null;

  const picking = snap.mode === "picker" && !snap.element && snap.state === "idle";
  return createPortal(
    <PanelContext.Provider value={ctx}>
      {picking ? (
        <Picker onPick={(el) => beginCapture("report", el, snap.prefill)} onCancel={() => closeFlow()} />
      ) : (
        <Flow key={snap.session} snap={snap} teamSignIn={teamSignIn} />
      )}
    </PanelContext.Provider>,
    root.container,
  );
}
