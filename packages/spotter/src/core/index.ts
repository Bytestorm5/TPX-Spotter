/**
 * `@trusplex/spotter/core` — framework-agnostic: the reporting API, capture,
 * transport, hooks and the ingest handler. Runs in the browser, Node and
 * edge runtimes; nothing here does work at import time.
 */
import { createSpotter } from "./client.ts";
import type { TypedSpotter } from "./typed.ts";

/**
 * The client singleton. Import it anywhere — client components, server
 * components, route handlers, server actions, middleware.
 */
export const spotter: TypedSpotter = /* @__PURE__ */ createSpotter() as unknown as TypedSpotter;

export { createSpotter } from "./client.ts";
export type { SpotterInstance } from "./client.ts";
export { SpotterDroppedError } from "./errors.ts";

// generated types (augmented by withSpotter())
export type {
  SpotterFeatureFlags,
  SpotterRegister,
  TypedSpotter,
  TypedReportInput,
  TypedOpenOptions,
  TypedRequestScope,
  FeatureDisabled,
  RegisteredEvent,
  RegisteredFields,
  RegisteredContexts,
  DisabledMethod,
} from "./typed.ts";

// public API types
export type * from "./types.ts";
export type * from "./schema.ts";
export {
  REPORT_SCHEMA_ID,
  PROTOCOL_VERSION,
  REPORT_SOURCES,
  SEVERITIES,
  CATEGORIES,
  PUBLIC_STATUSES,
  REPORTER_TYPES,
  ARTIFACT_KINDS,
  CONSOLE_LEVELS,
  BREADCRUMB_CATEGORIES,
  CUSTOM_FIELD_TYPES,
  ANALYTICS_EVENT_TYPES,
} from "./schema.ts";
export { COMPILED_FEATURES, FEATURE_DEFINES } from "./features.ts";
export type { FeatureName } from "./features.ts";
export { SDK_VERSION } from "./ids.ts";
export { HOSTED_ENDPOINT, CONSOLE_ORIGIN, DEFAULT_BROWSER_ENDPOINT, applyRemoteConfig, resolveConfig, matchRoute, targetingMatches } from "./config.ts";
export type { ResolvedConfig, TargetingContext } from "./config.ts";

// consent
export { connectConsentManager, gpcEnabled, dntEnabled } from "./consent.ts";

// timeline & grouping
export { buildTimeline, reproSteps } from "./timeline.ts";
export type { TimelineSignals } from "./timeline.ts";
export { deriveFingerprint, hash as fingerprintHash } from "./fingerprint.ts";

// transport
export { createHttpTransport } from "./transport/http.ts";
export type { HttpTransport, HttpTransportOptions } from "./transport/http.ts";
export { createQueue, memoryQueue } from "./transport/queue.ts";
export type { OfflineQueue, QueueItem } from "./transport/queue.ts";
export { HttpError } from "./transport/retry.ts";

// testing
export { createTestTransport } from "./testing.ts";
export type { TestTransport, RecordedUpload } from "./testing.ts";

// hooks (server-side only)
export {
  defineHook,
  dispatcher,
  github,
  githubWebhookHandler,
  githubEventToUpdates,
  runHooks,
  runStatusHooks,
  memoryDeliveryStore,
  issueMarkdown,
} from "./hooks/index.ts";
export type {
  Delivery,
  DeliveryStore,
  DispatcherOptions,
  GitHubHookOptions,
  GitHubWebhookOptions,
  GitHubStatusUpdate,
  RunHooksOptions,
} from "./hooks/index.ts";

// ingest handler (server-side)
export { createIngestHandler, memoryStorage, fileSystemStorage, uploadRelease, validateSubmission } from "./server/index.ts";
export type { IngestHandler, IngestHandlerOptions, IngestEvents, ArtifactStorage, FlagGroup, UploadReleaseOptions } from "./server/index.ts";
