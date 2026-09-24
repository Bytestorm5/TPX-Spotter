/**
 * The widget's UI state: one tiny external store shared by the loader
 * (trigger, `useSpotter()`) and the lazily loaded panel, read through
 * `useSyncExternalStore`. Module-level on purpose — there is one widget per
 * page, like the `spotter` singleton it mirrors.
 */
import type { ReportReceipt, ReporterType } from "../../../core/schema.ts";
import type { OpenOptions, SpotterState } from "../../../core/types.ts";

export type FlowMode = NonNullable<OpenOptions["mode"]>;

export interface UiSnapshot {
  state: SpotterState;
  /** The panel (or picker / annotate overlay) is showing. */
  open: boolean;
  mode: FlowMode;
  prefill: OpenOptions["prefill"] | undefined;
  /** Element chosen with the picker or passed by an element trigger. */
  element: Element | null;
  receipt: ReportReceipt | null;
  error: unknown;
  reporter: ReporterType;
  reporterName: string | undefined;
  /** Core loaded and initialised. */
  ready: boolean;
  /** What opened the flow, when it changes the copy (an error boundary asks "what were you doing?"). */
  origin: "boundary" | undefined;
  /** Bumped on every open so the panel resets its draft. */
  session: number;
}

const initial: UiSnapshot = {
  state: "idle",
  open: false,
  mode: "report",
  prefill: undefined,
  element: null,
  receipt: null,
  error: null,
  reporter: "public",
  reporterName: undefined,
  ready: false,
  origin: undefined,
  session: 0,
};

let snapshot: UiSnapshot = initial;
const listeners = new Set<() => void>();

export function getSnapshot(): UiSnapshot {
  return snapshot;
}

export function getServerSnapshot(): UiSnapshot {
  return initial;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function update(patch: Partial<UiSnapshot>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof UiSnapshot)[]) {
    if (snapshot[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  snapshot = { ...snapshot, ...patch };
  for (const fn of [...listeners]) fn();
}

/** Tests only. */
export function resetStore(): void {
  snapshot = initial;
  for (const fn of [...listeners]) fn();
}
