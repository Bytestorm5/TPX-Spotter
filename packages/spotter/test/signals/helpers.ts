import type { Breadcrumb, ErrorEntry, Json, NavigationEntry, ReleaseInfo } from "../../src/core/schema.ts";
import type { SpotterConfig } from "../../src/core/types.ts";
import type { Runtime } from "../../src/core/internal.ts";
import { createRedactor } from "../../src/core/redact.ts";

export interface TestRuntime extends Runtime {
  crumbs: Breadcrumb[];
  errors: ErrorEntry[];
  navs: NavigationEntry[];
  faults: { signal: string; error: unknown }[];
  warnings: string[];
  consentState: { replay?: boolean; analytics?: boolean };
  identityValue: { id?: string; email?: string } | null;
  clock: { t: number };
}

export function testRuntime(config: SpotterConfig = {}, clockStart = Date.UTC(2026, 8, 24, 12, 0, 0)): TestRuntime {
  const redactor = createRedactor(config.privacy ?? {});
  const clock = { t: clockStart };
  const rt: TestRuntime = {
    config,
    sessionId: "sess-123",
    crumbs: [],
    errors: [],
    navs: [],
    faults: [],
    warnings: [],
    consentState: {},
    identityValue: null,
    clock,
    now: () => clock.t,
    redact: (v, w) => redactor.redact(v, w),
    redactUrl: (u) => redactor.redactUrl(u),
    breadcrumb(c) {
      rt.crumbs.push(c);
    },
    error(e) {
      rt.errors.push(e);
    },
    navigated(e) {
      rt.navs.push(e);
    },
    fault(signal, error) {
      rt.faults.push({ signal, error });
    },
    warn(m) {
      rt.warnings.push(m);
    },
    identity: () => rt.identityValue,
    flags: (): Record<string, Json> => ({}),
    release: (): ReleaseInfo => ({ version: "1.2.3" }),
    consent: () => rt.consentState,
    routePattern: () => undefined,
  };
  return rt;
}

/** Point the happy-dom window at a URL (happy-dom's API isn't in the DOM lib types). */
export function setUrl(url: string): void {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
}
