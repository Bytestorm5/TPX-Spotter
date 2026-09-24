/**
 * Safe serialization of arbitrary runtime values (console arguments, error
 * causes, contexts) into JSON that is bounded in size and never throws.
 *
 * Console arguments are live objects from the host app: they can be cyclic,
 * enormous, DOM nodes, proxies whose getters throw, or exotic built-ins. We
 * render every one of them into a small, faithful-enough `Json` and never let
 * a hostile value break the host (or blow the memory budget).
 */
import type { Json } from "./schema.ts";

export interface SerializeOptions {
  /** Strings longer than this are truncated with a marker. Default 8192 (8 KB). */
  maxString?: number;
  /** Nesting depth beyond which objects collapse to a summary. Default 6. */
  maxDepth?: number;
  /** Keys per object / items per array before the rest is summarized. Default 100. */
  maxKeys?: number;
  /** Total nodes visited per call — bounds the work on huge graphs. Default 2000. */
  maxNodes?: number;
}

const DEFAULTS = { maxString: 8192, maxDepth: 6, maxKeys: 100, maxNodes: 2000 };

/** Truncate a string to `max` chars, appending a marker that says how much was cut. */
export function truncate(value: string, max: number = DEFAULTS.maxString): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

/** `<div#id.a.b>` — enough to recognise a node without dumping the DOM. */
export function describeNode(node: unknown): string {
  try {
    const n = node as { nodeType?: number; nodeName?: string; id?: unknown; classList?: ArrayLike<string>; data?: unknown };
    switch (n.nodeType) {
      case 1: {
        let out = `<${String(n.nodeName).toLowerCase()}`;
        if (typeof n.id === "string" && n.id) out += `#${n.id}`;
        const classes = n.classList ? Array.from(n.classList).slice(0, 4) : [];
        for (const c of classes) out += `.${c}`;
        return `${out}>`;
      }
      case 3:
        return `#text ${JSON.stringify(truncate(String(n.data ?? ""), 80))}`;
      case 8:
        return "<!---->";
      case 9:
        return "[Document]";
      case 11:
        return "[DocumentFragment]";
      default:
        return `[${String(n.nodeName ?? "Node")}]`;
    }
  } catch {
    return "[Node]";
  }
}

function isNode(value: object): boolean {
  const v = value as { nodeType?: unknown; nodeName?: unknown };
  return typeof v.nodeType === "number" && typeof v.nodeName === "string";
}

function isWindow(value: object): boolean {
  try {
    const v = value as { window?: unknown; self?: unknown };
    return v.window === value && v.self === value;
  } catch {
    return false;
  }
}

function tag(value: object): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/**
 * Serialize anything into bounded `Json`. Never throws.
 *
 * - circular references → `"[Circular]"`
 * - DOM nodes → `"<div#id.class>"`, window → `"[Window]"`
 * - Errors → `{ name, message, stack, cause? }`
 * - Map / Set → `{ "@type": "Map", entries }` / `{ "@type": "Set", values }`
 * - typed arrays, ArrayBuffer, Blob → a size summary
 * - functions, symbols, bigint, NaN, ±Infinity, undefined → descriptive strings
 * - strings over `maxString` (8 KB) are truncated with a marker
 */
export function safeSerialize(value: unknown, opts?: SerializeOptions): Json {
  const maxString = opts?.maxString ?? DEFAULTS.maxString;
  const maxDepth = opts?.maxDepth ?? DEFAULTS.maxDepth;
  const maxKeys = opts?.maxKeys ?? DEFAULTS.maxKeys;
  let budget = opts?.maxNodes ?? DEFAULTS.maxNodes;
  const path = new Set<object>();

  const walk = (v: unknown, depth: number): Json => {
    try {
      switch (typeof v) {
        case "string":
          return truncate(v, maxString);
        case "number":
          if (Number.isNaN(v)) return "[NaN]";
          if (!Number.isFinite(v)) return v > 0 ? "[Infinity]" : "[-Infinity]";
          return v;
        case "boolean":
          return v;
        case "undefined":
          return "[undefined]";
        case "bigint":
          return `${v.toString()}n`;
        case "symbol":
          return v.toString();
        case "function":
          return v.name ? `[Function: ${v.name}]` : "[Function]";
      }
      if (v === null) return null;
      const obj = v as object;
      if (--budget < 0) return "[…]";
      if (path.has(obj)) return "[Circular]";
      if (isWindow(obj)) return "[Window]";
      if (isNode(obj)) return describeNode(obj);

      const t = tag(obj);
      if (obj instanceof Date || t === "Date") {
        const time = (obj as Date).getTime();
        return Number.isNaN(time) ? "[Invalid Date]" : (obj as Date).toISOString();
      }
      if (obj instanceof RegExp) return String(obj);
      if (ArrayBuffer.isView(obj)) {
        const len = (obj as { length?: number }).length ?? (obj as DataView).byteLength;
        return `[${t}(${len})]`;
      }
      if (t === "ArrayBuffer" || t === "SharedArrayBuffer") return `[${t}(${(obj as ArrayBuffer).byteLength})]`;
      if (t === "Promise" || t === "WeakMap" || t === "WeakSet" || t === "WeakRef") return `[${t}]`;
      if (t === "Blob" || t === "File") {
        const b = obj as { size?: number; type?: string; name?: string };
        return `[${t}${b.name ? ` ${b.name}` : ""} ${b.size ?? 0} bytes${b.type ? ` ${b.type}` : ""}]`;
      }

      if (depth >= maxDepth) {
        if (Array.isArray(obj)) return `[Array(${obj.length})]`;
        if (obj instanceof Error) return `${obj.name}: ${truncate(String(obj.message), 200)}`;
        if (obj instanceof Map) return `[Map(${obj.size})]`;
        if (obj instanceof Set) return `[Set(${obj.size})]`;
        return "[Object]";
      }

      path.add(obj);
      try {
        if (obj instanceof Error) {
          const out: { [k: string]: Json } = {
            name: truncate(String(obj.name), 200),
            message: truncate(String(obj.message), maxString),
          };
          if (typeof obj.stack === "string") out.stack = truncate(obj.stack, maxString);
          const cause = (obj as { cause?: unknown }).cause;
          if (cause !== undefined) out.cause = walk(cause, depth + 1);
          for (const key of Object.keys(obj).slice(0, maxKeys)) {
            if (!(key in out)) out[key] = readKey(obj, key, depth);
          }
          return out;
        }
        if (Array.isArray(obj)) {
          const out: Json[] = [];
          const n = Math.min(obj.length, maxKeys);
          for (let i = 0; i < n; i++) out.push(readKey(obj, i, depth));
          if (obj.length > n) out.push(`[… ${obj.length - n} more items]`);
          return out;
        }
        if (obj instanceof Map) {
          const entries: Json[] = [];
          let i = 0;
          for (const [k, val] of obj) {
            if (i++ >= maxKeys) {
              entries.push(`[… ${obj.size - maxKeys} more entries]`);
              break;
            }
            entries.push([walk(k, depth + 1), walk(val, depth + 1)]);
          }
          return { "@type": "Map", entries };
        }
        if (obj instanceof Set) {
          const values: Json[] = [];
          let i = 0;
          for (const val of obj) {
            if (i++ >= maxKeys) {
              values.push(`[… ${obj.size - maxKeys} more values]`);
              break;
            }
            values.push(walk(val, depth + 1));
          }
          return { "@type": "Set", values };
        }
        const toJSON = (obj as { toJSON?: unknown }).toJSON;
        if (typeof toJSON === "function") {
          const replaced: unknown = toJSON.call(obj);
          if (replaced !== obj) return walk(replaced, depth);
        }
        if (typeof Event !== "undefined" && obj instanceof Event) {
          return { "@type": t, type: obj.type, target: obj.target ? walk(obj.target, depth + 1) : null };
        }
        const out: { [k: string]: Json } = {};
        const keys = Object.keys(obj);
        const n = Math.min(keys.length, maxKeys);
        for (let i = 0; i < n; i++) {
          const key = keys[i] as string;
          out[key] = readKey(obj, key, depth);
        }
        if (keys.length > n) out["…"] = `${keys.length - n} more keys`;
        return out;
      } finally {
        path.delete(obj);
      }
    } catch {
      return "[Unserializable]";
    }
  };

  // Property access can hit throwing getters or revoked proxies.
  const readKey = (obj: object, key: string | number, depth: number): Json => {
    let child: unknown;
    try {
      child = (obj as Record<string | number, unknown>)[key];
    } catch {
      return "[Throws]";
    }
    return walk(child, depth + 1);
  };

  return walk(value, 0);
}

/** Apply `fn` to every string in a Json value (keys untouched). Used to run redaction over serialized args. */
export function mapStrings(value: Json, fn: (s: string) => string): Json {
  if (typeof value === "string") return fn(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  const out: { [k: string]: Json } = {};
  for (const key of Object.keys(value)) out[key] = mapStrings(value[key] as Json, fn);
  return out;
}

/** UTF-8 byte length of a string, without allocating an encoder. */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Approximate UTF-8 bytes of the JSON encoding of `value` — what it costs in a buffer or on the wire. */
export function byteSize(value: Json): number {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : utf8Length(s);
  } catch {
    return 0;
  }
}
