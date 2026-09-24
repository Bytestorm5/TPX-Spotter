/**
 * `whenIdle()` — defer work until the page has loaded and the main thread is
 * idle. Tiny and dependency-free: the loader uses it to boot core and the
 * trigger without touching hydration.
 */
/** Run after the browser is idle (and never before load), falling back to a timeout. */
export function whenIdle(fn: () => void, timeout = 2000): () => void {
  if (typeof window === "undefined") return () => {};
  let cancelled = false;
  let handle: number | undefined;
  const run = () => {
    if (cancelled) return;
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) handle = ric(() => !cancelled && fn(), { timeout });
    else handle = window.setTimeout(() => !cancelled && fn(), 200);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
  return () => {
    cancelled = true;
    const cic = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    if (handle !== undefined) (cic ?? clearTimeout)(handle);
    window.removeEventListener("load", run);
  };
}
