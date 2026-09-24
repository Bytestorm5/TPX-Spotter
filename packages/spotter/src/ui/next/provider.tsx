"use client";
/**
 * `<SpotterProvider>` — initialises the `spotter` singleton and tracks App
 * Router navigation.
 *
 * Nothing happens at import or render time: core is loaded and initialised
 * after the browser is idle (or at first interaction with a trigger), so the
 * provider adds no main-thread work to hydration and no requests before the
 * user engages. `withSpotter()` inlines the project key, release and
 * environment, so zero props is a complete setup.
 *
 * Route patterns (`/blog/[slug]`) come from two sources: the build-time
 * manifest `withSpotter()` inlines (synchronous — right even for the
 * history-patch pageview that fires before React renders the next route),
 * and, as a fallback, `useParams()` values mapped back onto the pathname
 * (see `internal/route-pattern.ts`).
 */
import { createContext, Suspense, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import type { SpotterConfig } from "../../core/types.ts";
import * as bridge from "./internal/bridge.ts";
import { closeFlow, ensureClient, setConfig, startFlow } from "./internal/controller.ts";
import { whenIdle } from "./internal/host.ts";
import { deriveRoutePattern, matchRoutePattern } from "./internal/route-pattern.ts";
import { update } from "./internal/store.ts";

export interface SpotterProviderProps extends Omit<SpotterConfig, "secretKey" | "transport"> {
  children?: ReactNode;
  /** CSP nonce for the `<style>` fallback where constructable stylesheets aren't supported. */
  nonce?: string;
  /** Test/advanced: a custom transport. */
  transport?: SpotterConfig["transport"];
}

export interface SpotterContextValue {
  config: SpotterConfig;
  nonce?: string;
}

export const SpotterContext = createContext<SpotterContextValue | null>(null);

export function useSpotterContext(): SpotterContextValue {
  return useContext(SpotterContext) ?? { config: {} };
}

/** `process.env.NEXT_PUBLIC_*` must be written literally for Next to inline it. */
function publicEnv() {
  const read = (f: () => string | undefined) => {
    try {
      return f() || undefined;
    } catch {
      return undefined;
    }
  };
  return {
    release: read(() => process.env.NEXT_PUBLIC_SPOTTER_RELEASE),
    commit: read(() => process.env.NEXT_PUBLIC_SPOTTER_COMMIT),
    deployId: read(() => process.env.NEXT_PUBLIC_SPOTTER_DEPLOY_ID),
    environment: read(() => process.env.NEXT_PUBLIC_SPOTTER_ENVIRONMENT),
    routes: read(() => process.env.NEXT_PUBLIC_SPOTTER_ROUTES),
  };
}

let routeManifest: string[] | null = null;
function manifest(): string[] {
  if (routeManifest) return routeManifest;
  try {
    const raw = publicEnv().routes;
    routeManifest = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    routeManifest = [];
  }
  return routeManifest;
}

/** Patterns learnt from `useParams()` for URLs the manifest doesn't cover. */
const learnt = new Map<string, string>();

function resolveRoute(url: string): string | undefined {
  let path = url;
  try {
    path = new URL(url, "http://_").pathname;
  } catch {
    /* already a path */
  }
  return matchRoutePattern(path, manifest()) ?? learnt.get(path);
}

export function SpotterProvider({ children, nonce, ...props }: SpotterProviderProps) {
  const env = publicEnv();
  // Stable across renders unless the caller changes props: re-init is never attempted, but late readers see the latest.
  const config = useMemo<SpotterConfig>(
    () => ({
      ...props,
      environment: props.environment ?? env.environment,
      release: props.release ?? (env.release || env.commit ? { version: env.release, commit: env.commit, deployId: env.deployId } : undefined),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(props, (_, v) => (typeof v === "function" ? String(v) : v))],
  );
  setConfig(config);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    const boot = () =>
      ensureClient()
        .then((c) => {
          if (cancelled) return;
          bridge.setRouteResolver(resolveRoute);
          off = bridge.onOpenClose(
            c,
            (o) => startFlow(o),
            () => closeFlow({ fromClient: true }),
          );
          const mode = bridge.reporterMode();
          update({ ready: true, reporter: mode.type, reporterName: mode.name });
        })
        .catch(() => {
          /* core failed to load (offline, blocked): the trigger retries on interaction */
        });
    const cancelIdle = whenIdle(() => void boot());
    return () => {
      cancelled = true;
      cancelIdle();
      off?.();
    };
  }, []);

  const value = useMemo(() => ({ config, nonce }), [config, nonce]);
  return (
    <SpotterContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        <RouteTracker />
      </Suspense>
    </SpotterContext.Provider>
  );
}

/**
 * Soft navigations → pageview with route pattern. `useSearchParams()` makes
 * this subtree client-rendered on static pages, which is why it sits in its
 * own Suspense boundary: the rest of the page still prerenders.
 */
function RouteTracker() {
  const pathname = usePathname();
  const search = useSearchParams();
  const params = useParams() as Record<string, string | string[]> | null;
  const last = useRef<string | null>(null);
  const query = search?.toString() ?? "";
  useEffect(() => {
    if (!pathname) return;
    const pattern = matchRoutePattern(pathname, manifest()) ?? deriveRoutePattern(pathname, params);
    if (pattern !== pathname) learnt.set(pathname, pattern);
    const key = pathname + "?" + query;
    if (last.current === key) return;
    last.current = key;
    const c = bridge.peekClient();
    if (!c?.initialized) return; // The initial pageview is recorded by core on init, with the resolver above.
    try {
      c.pageview(location.href, pattern);
    } catch {
      /* analytics compiled out: a typed no-op */
    }
  }, [pathname, query, params]);
  return null;
}
