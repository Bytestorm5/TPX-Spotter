/**
 * Where the widget's UI root lives once created. Separate from `host.ts` so
 * loader code can look it up without carrying the stylesheet machinery.
 */
export interface UiRoot {
  host: HTMLElement;
  shadow: ShadowRoot | null;
  /** Where React portals render. */
  container: HTMLElement;
}

let root: UiRoot | null = null;

export function peekUiRoot(): UiRoot | null {
  return root && root.host.isConnected ? root : null;
}

export function setUiRoot(next: UiRoot): void {
  root = next;
}
