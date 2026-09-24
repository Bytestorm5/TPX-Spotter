/**
 * Client-side redaction: every string that leaves the page (console args,
 * network URLs/headers/bodies, breadcrumb labels, error messages, DOM text)
 * passes through here first. Built-in scrubbers catch the common secrets and
 * PII; `setRedactor` adds a custom pass on top. Masking happens in the
 * browser, before upload — unmasked data never reaches an ingest.
 *
 * Header allowlisting (and the never-captured Authorization / Cookie set) is
 * applied at capture time, in `capture/network.ts`.
 *
 * Replacement tokens are `[redacted:<kind>]` so a reader of the ticket can see
 * that something was there and what it was, without seeing it.
 */
import type { Json } from "./schema.ts";
import type { PrivacyConfig, RedactionSite } from "./types.ts";

export type CustomRedactor = (value: string, where: RedactionSite) => string;

export interface Redactor {
  redact(value: string, where: RedactionSite): string;
  redactUrl(url: string): string;
  /** Free text that may embed URLs (breadcrumb messages): strip sensitive `?query` parameters, then redact. */
  redactMessage(text: string, where: RedactionSite): string;
  redactJson(value: Json, where: RedactionSite): Json;
}

/** Query parameter names (or name parts, e.g. `X-Amz-Signature`, `authToken`) that are stripped from URLs. */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  "token",
  "key",
  "secret",
  "password",
  "passwd",
  "pwd",
  "code",
  "auth",
  "session",
  "sig",
  "signature",
  "access_token",
  "refresh_token",
  "api_key",
];

const MARK = (kind: string) => `[redacted:${kind}]`;

// -- built-in scrubbers --------------------------------------------------------------

/** Luhn checksum over a digit string. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Card brand prefixes (IIN ranges) with their valid lengths. Requiring a real
 * prefix as well as a Luhn match keeps epoch-millisecond timestamps and order
 * numbers (a 10% Luhn false-positive rate otherwise) out of the scrubber.
 */
function looksLikeCard(digits: string): boolean {
  const n = digits.length;
  if (n < 13 || n > 19) return false;
  const two = Number(digits.slice(0, 2));
  const three = Number(digits.slice(0, 3));
  const four = Number(digits.slice(0, 4));
  const six = Number(digits.slice(0, 6));
  const brand =
    (digits[0] === "4" && (n === 13 || n === 16 || n === 19)) || // Visa
    (((two >= 51 && two <= 55) || (six >= 222100 && six <= 272099)) && n === 16) || // Mastercard
    ((two === 34 || two === 37) && n === 15) || // Amex
    ((four === 6011 || two === 65 || (three >= 644 && three <= 649)) && n >= 16) || // Discover
    (two === 35 && n >= 16) || // JCB
    (((three >= 300 && three <= 305) || two === 36 || two === 38) && n >= 14) || // Diners
    (two === 62 && n >= 16) || // UnionPay
    ((four === 5018 || four === 5020 || four === 5038 || four === 6304 || two === 67) && n >= 12); // Maestro
  return brand && luhn(digits);
}

type Scrubber = [RegExp, string | ((match: string, ...groups: string[]) => string)];

const SECRET_NAME =
  "(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|private[_-]?key)";

/** Order matters: the most specific formats run before the generic ones. */
const SCRUBBERS: Scrubber[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, MARK("private_key")],
  [/\beyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, MARK("jwt")],
  // API keys by well-known prefix. Publishable keys (pk_…) are public by design and kept.
  [
    /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|sk_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b/g,
    MARK("api_key"),
  ],
  [
    /\b(Bearer|Basic|Token|Digest)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    (_m, scheme: string, value: string) => (value.startsWith("[redacted") ? _m : `${scheme} ${MARK("token")}`),
  ],
  // `password=…`, `"secret": "…"`, `api_key: …` — keep the name, drop the value.
  [
    new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s"'&,;}\\]]+))`, "gi"),
    (m, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      if (!value || value.startsWith("[redacted")) return m;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      return `${prefix}${quote}${MARK("secret")}${quote}`;
    },
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, MARK("email")],
  [
    /\b\d(?:[ -]?\d){12,18}\b/g,
    (m) => {
      const digits = m.replace(/[ -]/g, "");
      return looksLikeCard(digits) ? MARK("card") : m;
    },
  ],
  [/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, MARK("ssn")],
];

/** Run the built-in scrubbers over a string. */
export function scrub(value: string): string {
  if (!value) return value;
  let out = value;
  for (const [re, replacement] of SCRUBBERS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement as (substring: string, ...args: string[]) => string);
  }
  return out;
}

// -- URLs -----------------------------------------------------------------------------

/** Split a parameter name into lowercase parts: `X-Amz-Signature` → x, amz, signature; `authToken` → auth, token. */
function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function makeParamMatcher(extra: string[] = []): (name: string) => boolean {
  const exact = new Set([...SENSITIVE_QUERY_PARAMS, ...extra].map((n) => n.toLowerCase()));
  const parts = new Set([...SENSITIVE_QUERY_PARAMS, ...extra].map((n) => n.toLowerCase()).filter((n) => /^[a-z0-9]+$/.test(n)));
  return (name) => {
    let decoded = name;
    try {
      decoded = decodeURIComponent(name.replace(/\+/g, " "));
    } catch {
      /* keep raw */
    }
    const lower = decoded.toLowerCase();
    if (exact.has(lower)) return true;
    return nameParts(decoded).some((p) => parts.has(p));
  };
}

function stripParams(query: string, isSensitive: (name: string) => boolean): string {
  return query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      if (!name || !isSensitive(name)) return pair;
      return eq === -1 ? pair : `${name}=[redacted]`;
    })
    .join("&");
}

/**
 * Strip sensitive query (and `#fragment` params, as in OAuth implicit flows)
 * and userinfo passwords, then run the scrubbers over what remains. The URL
 * is edited textually, not re-serialized, so it stays recognisable.
 */
export function redactUrlWith(url: string, isSensitive: (name: string) => boolean, text: (s: string) => string): string {
  if (!url) return url;
  let rest = url;
  let hash = "";
  const hashAt = rest.indexOf("#");
  if (hashAt !== -1) {
    hash = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let query: string | null = null;
  const qAt = rest.indexOf("?");
  if (qAt !== -1) {
    query = rest.slice(qAt + 1);
    rest = rest.slice(0, qAt);
  }
  // user:password@host → user:[redacted]@host
  rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@:]*):([^/?#@]*)@/i, (_m, scheme: string, user: string) => `${scheme}${user}:[redacted]@`);
  let out = rest;
  if (query !== null) out += `?${stripParams(query, isSensitive)}`;
  if (hashAt !== -1) {
    // `#access_token=…` (OAuth implicit flow) or a hash router's `#/route?token=…`.
    const hq = hash.indexOf("?");
    if (hq !== -1) hash = `${hash.slice(0, hq)}?${stripParams(hash.slice(hq + 1), isSensitive)}`;
    else if (hash.includes("=")) hash = stripParams(hash, isSensitive);
    out += `#${hash}`;
  }
  return text(out);
}

// -- JSON ---------------------------------------------------------------------------------

const SENSITIVE_KEY_SUBSTRINGS = /(password|passwd|secret|token|authorization|cookie|credential|apikey|privatekey|accesskey|secretkey|sessionid|signature|creditcard|cardnumber)/;
const SENSITIVE_KEY_EXACT = new Set(["pwd", "pin", "ssn", "cvv", "cvc", "cvv2", "auth", "sig"]);

/** Whether an object key names a secret (`password`, `apiKey`, `x-auth-token`, `cvv`, …). */
export function isSensitiveKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_EXACT.has(norm) || SENSITIVE_KEY_SUBSTRINGS.test(norm);
}

// -- the redactor -----------------------------------------------------------------------

/**
 * Build the redactor the runtime exposes. `custom` is read on every call so
 * `setRedactor()` takes effect immediately; a throwing custom redactor falls
 * back to the built-in result instead of leaking or crashing.
 */
export function createRedactor(privacy: PrivacyConfig, custom?: () => CustomRedactor | null): Redactor {
  const isSensitiveParam = makeParamMatcher(privacy.stripQueryParams);

  const redact = (value: string, where: RedactionSite): string => {
    if (typeof value !== "string" || value === "") return value;
    let out: string;
    try {
      out = scrub(value);
    } catch {
      return MARK("unscrubbable");
    }
    const fn = custom?.();
    if (fn) {
      try {
        const next = fn(out, where);
        if (typeof next === "string") out = next;
      } catch {
        /* custom redactor failed: keep the built-in result */
      }
    }
    return out;
  };

  const redactUrl = (url: string): string => {
    try {
      return redactUrlWith(url, isSensitiveParam, (s) => redact(s, "url"));
    } catch {
      return MARK("url");
    }
  };

  const redactJson = (value: Json, where: RedactionSite): Json => {
    const walk = (v: Json, depth: number): Json => {
      if (typeof v === "string") return redact(v, where);
      if (v === null || typeof v !== "object") return v;
      if (depth > 32) return "[…]";
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out: { [k: string]: Json } = {};
      for (const key of Object.keys(v)) {
        const child = v[key] as Json;
        out[key] = isSensitiveKey(key) && child !== null && typeof child !== "object" ? MARK("secret") : walk(child, depth + 1);
      }
      return out;
    };
    try {
      return walk(value, 0);
    } catch {
      return MARK("unscrubbable");
    }
  };

  const redactMessage = (text: string, where: RedactionSite): string => {
    try {
      return redact(text.replace(/\?[^\s#"'<>]*/g, (q) => `?${stripParams(q.slice(1), isSensitiveParam)}`), where);
    } catch {
      return MARK("unscrubbable");
    }
  };

  return { redact, redactUrl, redactMessage, redactJson };
}
