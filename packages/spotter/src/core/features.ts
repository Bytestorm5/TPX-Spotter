/**
 * Compile-time feature flags.
 *
 * `withSpotter()` injects each flag as a constant (`compiler.define` in Next,
 * which both webpack and Turbopack honour). Every feature's code sits behind
 * one of these constants, so the minifier drops a disabled feature's branch —
 * and the dynamic `import()` of its chunk — entirely: a build with
 * `replay: false` contains no replay code (`scripts/check-features.mjs`
 * proves it in CI).
 *
 * Without a bundler define (core used directly in Node, a test, the CDN
 * build) the `typeof` guard falls back to the default: everything compiled
 * in, narrowed at runtime by config.
 *
 * Keep each guard in this exact shape — `typeof X === "boolean" ? X : d` —
 * because that is what bundler defines fold to a literal.
 */

declare const __SPOTTER_WIDGET__: boolean | undefined;
declare const __SPOTTER_SCREENSHOT__: boolean | undefined;
declare const __SPOTTER_ANNOTATE__: boolean | undefined;
declare const __SPOTTER_REPLAY__: boolean | undefined;
declare const __SPOTTER_ANALYTICS__: boolean | undefined;
declare const __SPOTTER_FLAGS__: boolean | undefined;
declare const __SPOTTER_RECORDING__: boolean | undefined;
declare const __SPOTTER_DEV__: boolean | undefined;

/** Report UI and trigger. */
export const FEATURE_WIDGET: boolean = typeof __SPOTTER_WIDGET__ === "boolean" ? __SPOTTER_WIDGET__ : true;
/** DOM screenshot (and the native-capture fallback). */
export const FEATURE_SCREENSHOT: boolean =
  typeof __SPOTTER_SCREENSHOT__ === "boolean" ? __SPOTTER_SCREENSHOT__ : true;
/** The annotation canvas. */
export const FEATURE_ANNOTATE: boolean = typeof __SPOTTER_ANNOTATE__ === "boolean" ? __SPOTTER_ANNOTATE__ : true;
/** DOM session replay (rrweb). */
export const FEATURE_REPLAY: boolean = typeof __SPOTTER_REPLAY__ === "boolean" ? __SPOTTER_REPLAY__ : true;
/** Privacy-first web analytics (`track()`, pageviews, Web Vitals). */
export const FEATURE_ANALYTICS: boolean = typeof __SPOTTER_ANALYTICS__ === "boolean" ? __SPOTTER_ANALYTICS__ : true;
/** `spotter.flag()` and `spotter.assert()`. */
export const FEATURE_FLAGS: boolean = typeof __SPOTTER_FLAGS__ === "boolean" ? __SPOTTER_FLAGS__ : true;
/** Screen recording via `getDisplayMedia`. Off unless asked for. */
export const FEATURE_RECORDING: boolean = typeof __SPOTTER_RECORDING__ === "boolean" ? __SPOTTER_RECORDING__ : false;

/**
 * Development build: dev-mode warnings are compiled in. `withSpotter()` sets
 * it from `NODE_ENV`; otherwise it follows `process.env.NODE_ENV` when there
 * is one.
 */
export const DEV: boolean =
  typeof __SPOTTER_DEV__ === "boolean"
    ? __SPOTTER_DEV__
    : typeof process !== "undefined" && typeof process.env === "object" && process.env.NODE_ENV !== "production";

export type FeatureName = "widget" | "screenshot" | "annotate" | "replay" | "analytics" | "flags" | "recording";

/** The flags as compiled into this build. */
export const COMPILED_FEATURES: Readonly<Record<FeatureName, boolean>> = {
  widget: FEATURE_WIDGET,
  screenshot: FEATURE_SCREENSHOT,
  annotate: FEATURE_ANNOTATE,
  replay: FEATURE_REPLAY,
  analytics: FEATURE_ANALYTICS,
  flags: FEATURE_FLAGS,
  recording: FEATURE_RECORDING,
};

/** The define keys `withSpotter()` sets, by feature. */
export const FEATURE_DEFINES: Readonly<Record<FeatureName, string>> = {
  widget: "__SPOTTER_WIDGET__",
  screenshot: "__SPOTTER_SCREENSHOT__",
  annotate: "__SPOTTER_ANNOTATE__",
  replay: "__SPOTTER_REPLAY__",
  analytics: "__SPOTTER_ANALYTICS__",
  flags: "__SPOTTER_FLAGS__",
  recording: "__SPOTTER_RECORDING__",
};
