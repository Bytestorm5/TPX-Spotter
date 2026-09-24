/**
 * Types generated from config: disabled features, event names, custom fields
 * and contexts. `withSpotter()` writes a declaration file such as
 *
 * ```ts
 * declare module "@trusplex/spotter/core" {
 *   interface SpotterFeatureFlags { analytics: false; flags: true }
 *   interface SpotterRegister {
 *     events: "signup_completed" | "checkout_started";
 *     fields: { order_number: string; plan: "free" | "pro" };
 *     contexts: { cart: { items: number; total: number } };
 *   }
 * }
 * ```
 *
 * and the exported `spotter` picks it up: `spotter.track()` becomes
 * uncallable when analytics is compiled out, `track("typo")` is an error
 * when events are registered, and so on. Without augmentation everything is
 * permissive (`string` names, any field values).
 *
 * Both interfaces are empty on purpose: augmentations add members, and an
 * interface member can't be redeclared with a narrower type.
 */
import type { FeatureName } from "./features.ts";
import type { FieldValue, Json, ReportReceipt } from "./schema.ts";
import type { FlagOptions, OpenOptions, RecordingSession, ReportInput, SpotterClient, SpotterRequestScope, SpotterWidgetApi, ExceptionContext } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SpotterFeatureFlags {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SpotterRegister {}

type Get<T, K extends string, D> = K extends keyof T ? T[K] : D;

/** `true` when the generated flags say the feature is compiled out. */
export type FeatureDisabled<F extends FeatureName> = Get<SpotterFeatureFlags, F, true> extends false ? true : false;

export type RegisteredEvent = Get<SpotterRegister, "events", string> extends infer E extends string ? E : string;
export type RegisteredFields =
  Get<SpotterRegister, "fields", Record<string, FieldValue>> extends infer F extends Record<string, FieldValue> ? F : Record<string, FieldValue>;
export type RegisteredContexts =
  Get<SpotterRegister, "contexts", Record<string, Record<string, Json>>> extends infer C extends Record<string, Record<string, Json>>
    ? C
    : Record<string, Record<string, Json>>;

/** A method of a compiled-out feature: calling it is a type error (and a runtime no-op). */
export type DisabledMethod = (...args: never) => void;

type Props = Record<string, string | number | boolean>;

export type TypedReportInput = Omit<ReportInput, "fields"> & { fields?: Partial<RegisteredFields> };
export type TypedOpenOptions = Omit<OpenOptions, "prefill"> & {
  prefill?: Omit<NonNullable<OpenOptions["prefill"]>, "fields"> & { fields?: Partial<RegisteredFields> };
};

export type TrackMethod = FeatureDisabled<"analytics"> extends true
  ? DisabledMethod
  : (name: RegisteredEvent, props?: Props, revenue?: { value: number; currency: string }) => void;
export type PageviewMethod = FeatureDisabled<"analytics"> extends true ? DisabledMethod : (url?: string, routePattern?: string) => void;
export type FlagMethod = FeatureDisabled<"flags"> extends true ? DisabledMethod : (name: string, options?: FlagOptions) => void;
export type AssertMethod = FeatureDisabled<"flags"> extends true
  ? DisabledMethod
  : (condition: unknown, name: string, data?: Record<string, Json>) => asserts condition;
export type OpenMethod = FeatureDisabled<"widget"> extends true ? DisabledMethod : (options?: TypedOpenOptions) => void;
export type StartRecordingMethod = FeatureDisabled<"recording"> extends true
  ? DisabledMethod
  : (options?: { mic?: boolean; maxMs?: number; onTick?: (ms: number) => void }) => Promise<RecordingSession>;

export interface TypedRequestScope extends Omit<SpotterRequestScope, "report" | "flag"> {
  report(input: TypedReportInput): Promise<ReportReceipt>;
  captureException(error: unknown, context?: ExceptionContext): Promise<ReportReceipt | null>;
  flag: FlagMethod;
}

/** The type of the exported `spotter`: the client with generated types applied. */
export interface TypedSpotter
  extends Omit<
    SpotterClient & SpotterWidgetApi,
    "track" | "pageview" | "flag" | "assert" | "open" | "report" | "setContext" | "startRecording" | "withRequest" | "init"
  > {
  init(config: Parameters<SpotterClient["init"]>[0]): TypedSpotter;
  track: TrackMethod;
  pageview: PageviewMethod;
  flag: FlagMethod;
  assert: AssertMethod;
  open: OpenMethod;
  startRecording: StartRecordingMethod;
  report(input: TypedReportInput): Promise<ReportReceipt>;
  setContext<K extends keyof RegisteredContexts & string>(key: K, value: RegisteredContexts[K] | null): void;
  withRequest(request: Parameters<SpotterWidgetApi["withRequest"]>[0]): TypedRequestScope;
}
