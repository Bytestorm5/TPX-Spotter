/**
 * `@trusplex/spotter/ui/next` — the Next.js integration.
 *
 * - Config: `withSpotter()` (next.config, Node only).
 * - Route handler: `createSpotterHandler()` (app/api/spotter/[[...spotter]]/route.ts).
 * - Components: `<SpotterProvider>`, `<Spotter />`, `<SpotterButton />`,
 *   `<SpotterPanel />`, `<SpotterStatus />`, `<SpotterTrigger asChild>`,
 *   `<SpotterErrorBoundary>`, and `useSpotter()`.
 * - Primitives (unstyled, accessible): `Trigger`, `Panel`, `Screenshot`,
 *   `AnnotationCanvas`, `Field`, `Submit`, `Status`.
 *
 * Plain re-exports only (no code runs here), so bundlers tree-shake whatever
 * an app doesn't use; client components carry their own "use client".
 */
export { withSpotter, resolveSpotterBuild, scanAppRoutes, type WithSpotterOptions } from "./config/with-spotter.ts";
export { generateEnvDts, type SpotterTypesOptions, type FieldTypeSpec } from "./config/env-dts.ts";
export { createSpotterHandler, type SpotterHandlerOptions, type SpotterRouteHandlers } from "./handler.ts";

export { SpotterProvider, useSpotterContext, type SpotterProviderProps } from "./provider.tsx";
export { Spotter, SpotterPanel, type SpotterProps, type SpotterPanelProps } from "./spotter.tsx";
export { SpotterButton, SpotterTrigger, SpotterTrigger as Trigger, type SpotterButtonProps, type SpotterTriggerProps } from "./triggers.tsx";
export { SpotterStatus, type SpotterStatusProps } from "./status.tsx";
export { SpotterErrorBoundary, type SpotterErrorBoundaryProps, type SpotterFallbackProps } from "./error-boundary.tsx";
export { useSpotter, type UseSpotter } from "./use-spotter.ts";

export { Panel, type PanelProps } from "./primitives/dialog.tsx";
export { Screenshot, loadImage, type ScreenshotProps, type LoadedImage } from "./primitives/screenshot.tsx";
export { AnnotationCanvas, loadAnnotationTools, type AnnotationCanvasProps } from "./primitives/annotation.tsx";
export { Field, type FieldProps, type FieldLabels } from "./primitives/field.tsx";
export { Submit, Status, LiveRegion, type SubmitProps, type StatusProps } from "./primitives/misc.tsx";

export type { History, Shape, Tool } from "./annotate/model.ts";
export { isFieldVisible, validateField, validateFields } from "./internal/fields.ts";
export { evaluateTargeting } from "./internal/targeting.ts";
export { parseShortcut, formatShortcut } from "./internal/shortcut.ts";
export { en as messagesEn, type MessageKey, type Messages } from "./locales/en.ts";
export { LOCALES, type Locale } from "./locales/detect.ts";
