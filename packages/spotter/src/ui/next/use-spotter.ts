"use client";
/**
 * `useSpotter()` — the widget's state and actions for custom UIs.
 *
 * ```tsx
 * const { state, open, receipt } = useSpotter()
 * <button onClick={() => open({ mode: 'feature' })}>Suggest a feature</button>
 * {state === 'sent' && <p>Thanks — {receipt?.ref}</p>}
 * ```
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ReportReceipt, ReporterType } from "../../core/schema.ts";
import type { OpenOptions, SpotterState } from "../../core/types.ts";
import * as bridge from "./internal/bridge.ts";
import * as flow from "./internal/bridge-flow.ts";
import { closeFlow, ensureClient, startFlow, warm } from "./internal/controller.ts";
import { getServerSnapshot, getSnapshot, subscribe, update, type FlowMode } from "./internal/store.ts";

export interface UseSpotter {
  state: SpotterState;
  isOpen: boolean;
  mode: FlowMode;
  /** Reporter type: `public`, `guest` (invite link) or `team` (signed in to Console). */
  reporter: ReporterType;
  receipt: ReportReceipt | null;
  error: unknown;
  /** Core loaded and initialised. */
  ready: boolean;
  open(options?: OpenOptions): void;
  close(): void;
  /** File a report without the panel (same as `spotter.report`), tracking state here. */
  submit(input: { description: string; title?: string; category?: import("../../core/schema.ts").Category }): Promise<ReportReceipt>;
  /** Back to `idle` after `sent` / `error`. */
  reset(): void;
  /** Warm the panel chunk and core (e.g. on hover of your own trigger). */
  preload(): void;
  /** Team mode: sign in with Console. */
  connectTeam(): Promise<ReporterType | null>;
}

export function useSpotter(): UseSpotter {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const open = useCallback((options?: OpenOptions) => startFlow(options ?? {}), []);
  const close = useCallback(() => closeFlow(), []);
  const submit = useCallback(async (input: { description: string; title?: string; category?: import("../../core/schema.ts").Category }) => {
    await ensureClient();
    update({ state: "submitting", error: null });
    bridge.setState("submitting");
    try {
      const receipt = await flow.submit({
        mode: "text",
        description: input.description,
        title: input.title,
        category: input.category ?? "bug",
        fields: {},
        annotations: [],
        include: {},
      });
      update({ state: "sent", receipt });
      bridge.setState("sent");
      return receipt;
    } catch (error) {
      update({ state: "error", error });
      bridge.setState("error");
      throw error;
    }
  }, []);
  const reset = useCallback(() => {
    update({ state: "idle", receipt: null, error: null });
    bridge.setState("idle");
  }, []);
  const connectTeam = useCallback(async () => {
    const mode = await flow.connectTeam();
    if (mode) update({ reporter: mode.type, reporterName: mode.name });
    return mode?.type ?? null;
  }, []);
  return useMemo(
    () => ({
      state: snap.state,
      isOpen: snap.open,
      mode: snap.mode,
      reporter: snap.reporter,
      receipt: snap.receipt,
      error: snap.error,
      ready: snap.ready,
      open,
      close,
      submit,
      reset,
      preload: warm,
      connectTeam,
    }),
    [snap, open, close, submit, reset, connectTeam],
  );
}
