/**
 * What a Next app adds to its initial JavaScript: the Provider and the
 * trigger shell (`<Spotter />` = floating button + lazy panel). The size
 * check (`scripts/check-size.mjs`) bundles this entry, minified and gzipped,
 * against the < 6 KB budget.
 *
 * Everything else is a lazy chunk behind a dynamic `import()`: core
 * (idle), the trigger runtime with theme + locale (idle), and the panel with
 * annotation, screenshot and fields (trigger hover / focus / first open).
 */
export { SpotterProvider } from "./provider.tsx";
export { Spotter } from "./spotter.tsx";
