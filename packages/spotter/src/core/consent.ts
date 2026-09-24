/**
 * Consent: what each capture mode may do given `setConsent()`, Global Privacy
 * Control and Do Not Track.
 *
 * Spotter doesn't decide the legal basis for the customer; it applies the
 * rules below and documents them (docs/privacy.md):
 *
 * - Buffer / on-error replay keeps data in memory and sends nothing unless a
 *   report or flag is filed, which is designed to fit legitimate interest in
 *   most setups. It runs unless `setConsent({ replay: false })`.
 * - Sampled full-session replay uploads whole sessions. It runs unless consent
 *   is refused. Where the law requires opt-in, call `setConsent({ replay:
 *   false })` before `init` and `setConsent({ replay: true })` once your CMP
 *   says yes (or use `connectConsentManager`).
 * - Cookieless analytics stores nothing on the device and sends no personal
 *   data. It runs unless refused, GPC is on (`honorGpc`, default true) or DNT
 *   is on (`honorDnt`, default false). Cookie mode and `analytics.identify`
 *   require explicit `analytics: true` consent.
 */
import type { AnalyticsConfig, ConsentState, ReplayMode } from "./types.ts";

interface NavigatorPrivacy {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
}

export function gpcEnabled(): boolean {
  try {
    return (globalThis.navigator as NavigatorPrivacy | undefined)?.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

export function dntEnabled(): boolean {
  try {
    const nav = globalThis.navigator as NavigatorPrivacy | undefined;
    const win = globalThis as { doNotTrack?: string };
    return nav?.doNotTrack === "1" || nav?.doNotTrack === "yes" || win.doNotTrack === "1";
  } catch {
    return false;
  }
}

export function replayAllowed(mode: ReplayMode, consent: ConsentState): boolean {
  if (mode === "off") return false;
  return consent.replay !== false;
}

export function analyticsAllowed(config: AnalyticsConfig | undefined, consent: ConsentState): boolean {
  if (consent.analytics === false) return false;
  if ((config?.honorGpc ?? true) && gpcEnabled()) return false;
  if (config?.honorDnt && dntEnabled()) return false;
  if ((config?.mode === "cookie" || config?.identify) && consent.analytics !== true) return false;
  return true;
}

/**
 * Wire common consent-management platforms to `setConsent`. Supports the IAB
 * TCF v2 API (`__tcfapi`), Cookiebot and OneTrust; returns an unsubscribe.
 * Mapping: analytics ⇐ statistics / measurement purposes (TCF purposes 7–9,
 * Cookiebot `statistics`, OneTrust `C0002`); replay ⇐ the same, since
 * sampled replay is measurement. Buffer replay is unaffected unless refused.
 */
export function connectConsentManager(setConsent: (consent: ConsentState) => void): () => void {
  const g = globalThis as Record<string, unknown> & {
    addEventListener?: (t: string, fn: () => void) => void;
    removeEventListener?: (t: string, fn: () => void) => void;
  };
  const cleanups: (() => void)[] = [];

  const tcf = g.__tcfapi as ((cmd: string, v: number, cb: (data: unknown, ok: boolean) => void, arg?: unknown) => void) | undefined;
  if (typeof tcf === "function") {
    let listenerId: number | undefined;
    tcf("addEventListener", 2, (data, ok) => {
      if (!ok || !data) return;
      const d = data as { listenerId?: number; eventStatus?: string; purpose?: { consents?: Record<string, boolean> } };
      listenerId = d.listenerId;
      if (d.eventStatus !== "tcloaded" && d.eventStatus !== "useractioncomplete") return;
      const p = d.purpose?.consents ?? {};
      const measurement = !!(p["7"] || p["8"] || p["9"]);
      setConsent({ analytics: measurement, replay: measurement });
    });
    cleanups.push(() => listenerId !== undefined && tcf("removeEventListener", 2, () => {}, listenerId));
  }

  const cookiebot = () => {
    const cb = g.Cookiebot as { consent?: { statistics?: boolean } } | undefined;
    if (cb?.consent) setConsent({ analytics: !!cb.consent.statistics, replay: !!cb.consent.statistics });
  };
  if (g.Cookiebot) cookiebot();
  for (const ev of ["CookiebotOnAccept", "CookiebotOnDecline"]) {
    g.addEventListener?.(ev, cookiebot);
    cleanups.push(() => g.removeEventListener?.(ev, cookiebot));
  }

  const onetrust = () => {
    const groups = g.OnetrustActiveGroups ?? g.OptanonActiveGroups;
    if (typeof groups === "string") {
      const ok = groups.split(",").includes("C0002");
      setConsent({ analytics: ok, replay: ok });
    }
  };
  if (g.OnetrustActiveGroups || g.OptanonActiveGroups) onetrust();
  g.addEventListener?.("OneTrustGroupsUpdated", onetrust);
  cleanups.push(() => g.removeEventListener?.("OneTrustGroupsUpdated", onetrust));

  return () => cleanups.forEach((c) => c());
}
