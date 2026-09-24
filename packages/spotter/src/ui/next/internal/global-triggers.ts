/**
 * Global triggers, loaded at idle (never in the initial bundle): keyboard
 * shortcut, selector binding (`trigger: { type: '#report-link' }`), and the
 * opt-in touch gestures — shake and two-finger long-press.
 */
import type { RemoteConfig } from "../../../core/schema.ts";
import type { TriggerConfig } from "../../../core/types.ts";
import { isTypingTarget, matchesShortcut, parseShortcut } from "./shortcut.ts";

export interface GlobalTriggerOptions {
  trigger: TriggerConfig | undefined;
  remote: RemoteConfig["trigger"] | undefined;
  /** Open the widget; `element` makes it an element report. */
  open: (opener: Element | null, element?: Element | null) => void;
  warm: () => void;
}

export function isApple(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function installGlobalTriggers({ trigger, remote, open, warm }: GlobalTriggerOptions): () => void {
  const cleanups: (() => void)[] = [];

  const shortcut = parseShortcut(trigger?.shortcut ?? remote?.shortcut ?? null, isApple());
  if (shortcut) {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, shortcut)) return;
      // A shortcut without Ctrl / Meta / Alt must not fire while the user types.
      if (isTypingTarget(e.composedPath()[0] ?? e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      e.preventDefault();
      open(document.activeElement);
    };
    window.addEventListener("keydown", onKey, true);
    cleanups.push(() => window.removeEventListener("keydown", onKey, true));
  }

  const type = trigger?.type;
  if (type && type !== "floating" && type !== "none") {
    const onClick = (e: MouseEvent) => {
      const hit = (e.target as Element | null)?.closest?.(type);
      if (!hit) return;
      e.preventDefault();
      open(hit);
    };
    const onOver = (e: Event) => {
      if ((e.target as Element | null)?.closest?.(type)) warm();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerover", onOver, { passive: true });
    document.addEventListener("focusin", onOver);
    // Announce the bound element as a dialog opener.
    for (const el of document.querySelectorAll(type)) el.setAttribute("aria-haspopup", "dialog");
    cleanups.push(() => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onOver);
    });
  }

  if (trigger?.shake || remote?.shakeToReport) cleanups.push(installShake(() => open(null)));
  if (trigger?.longPress) cleanups.push(installLongPress((el) => open(el, el)));
  return () => cleanups.forEach((f) => f());
}

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * Shake to report. iOS gates motion events behind a permission prompt that
 * may only be requested inside a user gesture, so it is asked on the first
 * tap (once) rather than at load.
 */
function installShake(onShake: () => void): () => void {
  const DME = (window as unknown as { DeviceMotionEvent?: MotionPermission }).DeviceMotionEvent;
  if (!DME) return () => {};
  let hits: number[] = [];
  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity ?? e.acceleration;
    if (!a) return;
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    const now = Date.now();
    if (mag > 24) {
      hits = [...hits.filter((t) => now - t < 1000), now];
      if (hits.length >= 3) {
        hits = [];
        onShake();
      }
    }
  };
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    window.addEventListener("devicemotion", onMotion);
  };
  let asked = false;
  const onGesture = () => {
    if (asked) return;
    asked = true;
    document.removeEventListener("touchend", onGesture, true);
    DME.requestPermission?.().then((s) => s === "granted" && listen(), () => {});
  };
  if (typeof DME.requestPermission === "function") document.addEventListener("touchend", onGesture, true);
  else listen();
  return () => {
    document.removeEventListener("touchend", onGesture, true);
    window.removeEventListener("devicemotion", onMotion);
  };
}

/**
 * Two-finger long-press (700 ms) reports the element under the fingers.
 * Two fingers, because a one-finger long-press is the platform's text
 * selection / context-menu gesture and must stay the host's.
 */
function installLongPress(onPress: (el: Element | null) => void): () => void {
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
    start = null;
  };
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return cancel();
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    const target = document.elementFromPoint(t.clientX, t.clientY);
    timer = window.setTimeout(() => {
      cancel();
      onPress(target);
    }, 700);
  };
  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 12) cancel();
  };
  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    cancel();
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", cancel);
    document.removeEventListener("touchcancel", cancel);
  };
}
