/**
 * Keyboard shortcut strings (`"Shift+Alt+B"`, `"Mod+Shift+K"`) parsed once
 * and matched against `KeyboardEvent`s.
 *
 * Matching uses `event.code` for letters and digits because `event.key`
 * changes with modifiers: Alt+B is "∫" on macOS and Shift+2 is "@" on US
 * layouts, which would make a letter shortcut never fire.
 */

export interface Shortcut {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

const MODIFIER_ALIASES: Record<string, keyof Omit<Shortcut, "key"> | "mod"> = {
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  mod: "mod",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  spacebar: " ",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  slash: "/",
  period: ".",
  comma: ",",
};

/**
 * Parse a shortcut string. Returns `null` for empty, `"off"`, or malformed
 * input (no key, two keys, unknown modifier) so a typo disables the shortcut
 * instead of binding something surprising.
 *
 * `Mod` means Meta on Apple platforms and Ctrl elsewhere.
 */
export function parseShortcut(input: string | null | undefined, isApple = false): Shortcut | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === "off" || trimmed.toLowerCase() === "none") return null;
  // "Shift++" means Shift and the plus key.
  const parts = trimmed.replace(/\+\+$/, "+plus").split("+").map((p) => p.trim().toLowerCase());
  const out: Shortcut = { key: "", shift: false, alt: false, ctrl: false, meta: false };
  for (const part of parts) {
    if (!part) return null;
    const mod = MODIFIER_ALIASES[part];
    if (mod) {
      if (mod === "mod") out[isApple ? "meta" : "ctrl"] = true;
      else out[mod] = true;
      continue;
    }
    if (out.key) return null;
    out.key = part === "plus" ? "+" : (KEY_ALIASES[part] ?? part);
  }
  if (!out.key) return null;
  // A bare printable key with no modifier would fire while typing.
  if (out.key.length === 1 && !out.alt && !out.ctrl && !out.meta) return null;
  return out;
}

/** The physical-key form of a letter or digit, for layout- and modifier-independent matching. */
function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return null;
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  shortcut: Shortcut,
): boolean {
  if (
    event.shiftKey !== shortcut.shift ||
    event.altKey !== shortcut.alt ||
    event.ctrlKey !== shortcut.ctrl ||
    event.metaKey !== shortcut.meta
  ) {
    return false;
  }
  const fromCode = event.code ? keyFromCode(event.code) : null;
  if (fromCode !== null && fromCode === shortcut.key) return true;
  return (event.key ?? "").toLowerCase() === shortcut.key;
}

/** Human form for tooltips and `aria-keyshortcuts` (`Shift+Alt+B`). */
export function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push("Control");
  if (shortcut.meta) parts.push("Meta");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  const key = shortcut.key === " " ? "Space" : shortcut.key.length === 1 ? shortcut.key.toUpperCase() : cap(shortcut.key);
  parts.push(key);
  return parts.join("+");
}

function cap(s: string): string {
  if (s.startsWith("arrow")) return "Arrow" + s.slice(5, 6).toUpperCase() + s.slice(6);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** True when focus is in something the user types into, where shortcuts must not fire unmodified. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
