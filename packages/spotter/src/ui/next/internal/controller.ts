/**
 * The loader half of the widget flow: open/close, and starting the capture.
 *
 * Speed and correctness both hinge on ordering here. On trigger, the capture
 * starts *first* (the Spotter host is excluded, so the panel can never be in
 * the screenshot), and the panel chunk loads in parallel, so the panel is
 * visible well inside the 300 ms budget while the screenshot finishes.
 */
import type { WidgetCapture } from "../../../core/types.ts";
import type { OpenOptions, SpotterConfig } from "../../../core/types.ts";
import { FEATURE_SCREENSHOT, FEATURE_WIDGET } from "../../../core/features.ts";
import * as bridge from "./bridge.ts";
import { peekUiRoot } from "./root-ref.ts";
import { getSnapshot, update, type FlowMode } from "./store.ts";

declare const __SPOTTER_WIDGET__: boolean | undefined;

let config: SpotterConfig = {};
let pendingCapture: Promise<WidgetCapture> | null = null;
let panelChunk: Promise<unknown> | null = null;
let returnFocus: HTMLElement | null = null;

export function setConfig(next: SpotterConfig): void {
  config = next;
}

export function getConfig(): SpotterConfig {
  return config;
}

/** Load and initialise core with the Provider's config (idempotent). */
export function ensureClient(): Promise<bridge.Client> {
  return bridge.initClient(config).then((c) => {
    if (!getSnapshot().ready) update({ ready: true, reporter: bridge.reporterMode().type, reporterName: bridge.reporterMode().name });
    return c;
  });
}

/** The panel chunk (React components + CSS). Imported by `<SpotterPanel>` through `React.lazy` too. */
export function loadPanelChunk(): Promise<unknown> {
  if (panelChunk) return panelChunk;
  // The guard is inline (not just FEATURE_WIDGET) so bundlers drop the import() — and the whole chunk — when the widget is compiled out.
  if ((typeof __SPOTTER_WIDGET__ === "boolean" ? __SPOTTER_WIDGET__ : true) && FEATURE_WIDGET) {
    panelChunk = import("../panel/index.tsx");
    panelChunk.catch(() => {
      panelChunk = null;
    });
    return panelChunk;
  }
  return Promise.reject(new Error("Spotter: the widget is not compiled into this build."));
}

/** Warm everything the first report needs (trigger hover / focus). */
export function warm(): void {
  if (!FEATURE_WIDGET) return;
  void loadPanelChunk();
  void ensureClient()
    .then(() => {
      if (FEATURE_SCREENSHOT) void bridge.preload("screenshot");
      void bridge.preload("annotate");
    })
    .catch(() => {});
}

function screenshotFor(mode: FlowMode): boolean {
  if (!FEATURE_SCREENSHOT || mode !== "report") return false;
  const c = bridge.peekClient();
  return c ? c.enabled("screenshot") : true;
}

/**
 * Open the widget. Called by triggers directly and by the client's `open`
 * event (programmatic `spotter.open()`), so it must be idempotent.
 */
export function startFlow(
  options: OpenOptions = {},
  opener?: Element | null,
  element?: Element | null,
  origin?: "boundary",
): void {
  if (!FEATURE_WIDGET || typeof window === "undefined") return;
  const snap = getSnapshot();
  if (snap.open && snap.state !== "sent" && snap.state !== "error") return;
  const active = (opener ?? document.activeElement) as HTMLElement | null;
  returnFocus = active && active !== document.body ? active : null;
  const mode: FlowMode = options.mode ?? "report";
  void loadPanelChunk();
  update({ origin });
  if (element) {
    beginCapture(mode === "text" || mode === "feature" ? mode : "report", element, options.prefill);
    return;
  }
  if (mode === "picker") {
    pendingCapture = null;
    update({ open: true, mode, prefill: options.prefill, element: null, state: "idle", receipt: null, error: null, session: snap.session + 1 });
    return;
  }
  beginCapture(mode, null, options.prefill);
}

/** Start capturing now, then show the panel. The picker calls this with the chosen element. */
export function beginCapture(mode: FlowMode, element: Element | null, prefill?: OpenOptions["prefill"]): void {
  const host = peekUiRoot()?.host;
  pendingCapture = ensureClient().then(() =>
    bridge.capture({ screenshot: screenshotFor(mode), element, exclude: host ? [host] : [] }),
  );
  pendingCapture.catch(() => {});
  const snap = getSnapshot();
  update({
    open: true,
    mode,
    prefill: prefill ?? snap.prefill,
    element,
    state: "capturing",
    receipt: null,
    error: null,
    session: snap.session + 1,
  });
  bridge.setState("capturing");
}

export function takeCapture(): Promise<WidgetCapture> | null {
  return pendingCapture;
}

/** Close, restoring focus to whatever opened the widget. */
export function closeFlow(options: { fromClient?: boolean } = {}): void {
  const snap = getSnapshot();
  if (!snap.open) return;
  update({ open: false, state: "idle", element: null, prefill: undefined });
  bridge.setState("idle");
  pendingCapture = null;
  if (!options.fromClient) {
    try {
      bridge.peekClient()?.close();
    } catch {
      /* mirror only */
    }
  }
  const target = returnFocus;
  returnFocus = null;
  if (target && target.isConnected) {
    // After React commits the close, so focus isn't stolen back by the unmounting trap.
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
}
