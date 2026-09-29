/** Join class names, skipping falsy ones. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** `true` → `""` (a bare data attribute), `false`/`undefined` → absent. */
export const flag = (on: boolean | undefined): "" | undefined => (on ? "" : undefined);
