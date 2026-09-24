/**
 * A hand-rolled validator for `ReportSubmission` (no zod in the SDK). It
 * checks what the ingest relies on — types, enums, bounds — and rejects
 * oversized collections so one request can't balloon memory or storage.
 */
import {
  ARTIFACT_KINDS,
  BREADCRUMB_CATEGORIES,
  CATEGORIES,
  CONSOLE_LEVELS,
  REPORT_SCHEMA_ID,
  REPORT_SOURCES,
  REPORTER_TYPES,
  SEVERITIES,
  type FlagBatch,
  type ReportSubmission,
} from "../schema.ts";

export const LIMITS = {
  reportBytes: 2 * 1024 * 1024,
  artifactBytes: 10 * 1024 * 1024,
  replayBytes: 25 * 1024 * 1024,
  maxArtifacts: 20,
  console: 500,
  errors: 100,
  network: 500,
  breadcrumbs: 500,
  navigation: 100,
  timeline: 200,
  titleChars: 500,
  descriptionChars: 20_000,
} as const;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

class Checker {
  errors: string[] = [];
  fail(path: string, msg: string) {
    if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string): v is Obj {
    if (!isObj(v)) {
      this.fail(path, "expected an object");
      return false;
    }
    return true;
  }
  str(v: unknown, path: string, opts: { optional?: boolean; max?: number } = {}): void {
    if (v === undefined && opts.optional) return;
    if (!isStr(v)) return this.fail(path, "expected a string");
    if (opts.max && v.length > opts.max) this.fail(path, `longer than ${opts.max} characters`);
  }
  num(v: unknown, path: string, optional = false): void {
    if (v === undefined && optional) return;
    if (typeof v !== "number" || !Number.isFinite(v)) this.fail(path, "expected a number");
  }
  bool(v: unknown, path: string, optional = false): void {
    if (v === undefined && optional) return;
    if (typeof v !== "boolean") this.fail(path, "expected a boolean");
  }
  oneOf(v: unknown, values: readonly string[], path: string, optional = false): void {
    if (v === undefined && optional) return;
    if (!isStr(v) || !values.includes(v)) this.fail(path, `expected one of ${values.join(", ")}`);
  }
  arr(v: unknown, path: string, max: number, each?: (item: unknown, path: string) => void, optional = false): void {
    if (v === undefined && optional) return;
    if (!Array.isArray(v)) return this.fail(path, "expected an array");
    if (v.length > max) return this.fail(path, `more than ${max} items`);
    if (each) v.forEach((item, i) => each(item, `${path}[${i}]`));
  }
  date(v: unknown, path: string, optional = false): void {
    if (v === undefined && optional) return;
    if (!isStr(v) || !Number.isFinite(Date.parse(v))) this.fail(path, "expected an ISO-8601 timestamp");
  }
  record(v: unknown, path: string, value: (v: unknown, p: string) => void, maxKeys = 200): void {
    if (!this.obj(v, path)) return;
    const keys = Object.keys(v);
    if (keys.length > maxKeys) return this.fail(path, `more than ${maxKeys} keys`);
    for (const k of keys) value(v[k], `${path}.${k}`);
  }
}

export function validateSubmission(input: unknown): ValidationResult<ReportSubmission> {
  const c = new Checker();
  if (!c.obj(input, "$")) return { ok: false, errors: c.errors };
  const r = input;
  if (r.schema !== REPORT_SCHEMA_ID) c.fail("$.schema", `expected "${REPORT_SCHEMA_ID}"`);
  c.str(r.clientId, "$.clientId", { max: 100 });
  c.date(r.createdAt, "$.createdAt");
  c.oneOf(r.source, REPORT_SOURCES, "$.source");
  c.bool(r.test, "$.test");
  c.str(r.fingerprint, "$.fingerprint", { optional: true, max: 200 });

  if (c.obj(r.reporter, "$.reporter")) {
    const p = r.reporter;
    c.str(p.id, "$.reporter.id", { optional: true, max: 256 });
    c.str(p.email, "$.reporter.email", { optional: true, max: 320 });
    c.str(p.name, "$.reporter.name", { optional: true, max: 256 });
    c.obj(p.traits, "$.reporter.traits");
    c.oneOf(p.type, REPORTER_TYPES, "$.reporter.type");
    c.oneOf(p.contact, ["email", "in_app", "none"], "$.reporter.contact");
  }

  if (c.obj(r.content, "$.content")) {
    const ct = r.content;
    c.str(ct.title, "$.content.title", { max: LIMITS.titleChars });
    c.str(ct.description, "$.content.description", { max: LIMITS.descriptionChars });
    c.str(ct.expected, "$.content.expected", { optional: true, max: LIMITS.descriptionChars });
    c.oneOf(ct.category, CATEGORIES, "$.content.category");
    c.oneOf(ct.severity, SEVERITIES, "$.content.severity");
    c.record(ct.fields, "$.content.fields", (v, p) => {
      const ok =
        v === null ||
        ["string", "number", "boolean"].includes(typeof v) ||
        (Array.isArray(v) && v.every(isStr));
      if (!ok) c.fail(p, "expected string | number | boolean | string[] | null");
    });
    c.arr(ct.annotations, "$.content.annotations", 500, (a, p) => {
      if (!c.obj(a, p)) return;
      c.oneOf(a.tool, ["arrow", "rect", "freehand", "text", "pin", "blur"], `${p}.tool`);
      c.arr(a.points, `${p}.points`, 5000, (pt, pp) => {
        if (c.obj(pt, pp)) {
          c.num(pt.x, `${pp}.x`);
          c.num(pt.y, `${pp}.y`);
        }
      });
    });
  }

  if (c.obj(r.page, "$.page")) {
    c.str(r.page.url, "$.page.url", { max: 8192 });
    c.str(r.page.routePattern, "$.page.routePattern", { optional: true, max: 1024 });
    c.str(r.page.selector, "$.page.selector", { optional: true, max: 2048 });
    c.str(r.page.domExcerpt, "$.page.domExcerpt", { optional: true, max: 8192 + 64 });
    c.str(r.page.nearbyText, "$.page.nearbyText", { optional: true, max: 2048 + 64 });
    c.arr(r.page.history, "$.page.history", 50, (h, p) => c.str(h, p, { max: 8192 }));
  }

  if (c.obj(r.environment, "$.environment")) {
    c.oneOf(r.environment.runtime, ["browser", "node", "edge"], "$.environment.runtime");
    c.oneOf(r.environment.device, ["desktop", "mobile", "tablet", "server", "unknown"], "$.environment.device");
  }
  c.obj(r.release, "$.release");

  if (c.obj(r.context, "$.context")) {
    c.record(r.context.tags, "$.context.tags", (v, p) => c.str(v, p, { max: 1000 }));
    c.record(r.context.contexts, "$.context.contexts", (v, p) => c.obj(v, p), 100);
    c.obj(r.context.flags, "$.context.flags");
  }

  if (c.obj(r.signals, "$.signals")) {
    const s = r.signals;
    c.arr(s.console, "$.signals.console", LIMITS.console, (e, p) => {
      if (!c.obj(e, p)) return;
      c.oneOf(e.level, CONSOLE_LEVELS, `${p}.level`);
      c.arr(e.args, `${p}.args`, 100);
    });
    c.arr(s.errors, "$.signals.errors", LIMITS.errors, (e, p) => {
      if (!c.obj(e, p)) return;
      c.str(e.type, `${p}.type`);
      c.str(e.message, `${p}.message`);
      c.arr(e.frames, `${p}.frames`, 200);
    });
    if (c.obj(s.network, "$.signals.network") && c.obj(s.network.log, "$.signals.network.log"))
      c.arr(s.network.log.entries, "$.signals.network.log.entries", LIMITS.network, (e, p) => {
        if (c.obj(e, p) && c.obj(e.request, `${p}.request`)) c.str(e.request.url, `${p}.request.url`);
      });
    c.arr(s.breadcrumbs, "$.signals.breadcrumbs", LIMITS.breadcrumbs, (b, p) => {
      if (!c.obj(b, p)) return;
      c.oneOf(b.category, BREADCRUMB_CATEGORIES, `${p}.category`);
      c.str(b.message, `${p}.message`);
    });
    c.arr(s.navigation, "$.signals.navigation", LIMITS.navigation);
  }

  c.arr(r.artifacts, "$.artifacts", LIMITS.maxArtifacts, (a, p) => {
    if (!c.obj(a, p)) return;
    c.str(a.name, `${p}.name`);
    if (isStr(a.name) && !/^[A-Za-z0-9._-]{1,100}$/.test(a.name)) c.fail(`${p}.name`, "use 1–100 of [A-Za-z0-9._-]");
    c.oneOf(a.kind, ARTIFACT_KINDS, `${p}.kind`);
    c.str(a.contentType, `${p}.contentType`, { max: 200 });
    c.num(a.size, `${p}.size`);
    if (typeof a.size === "number" && a.size > artifactLimit(a.kind as string)) c.fail(`${p}.size`, `exceeds ${artifactLimit(a.kind as string)} bytes`);
  });
  if (Array.isArray(r.artifacts)) {
    const names = r.artifacts.map((a) => (isObj(a) ? a.name : undefined));
    if (new Set(names).size !== names.length) c.fail("$.artifacts", "artifact names must be unique");
  }

  if (c.obj(r.trace, "$.trace")) {
    c.arr(r.trace.traceparents, "$.trace.traceparents", 100, (t, p) => c.str(t, p, { max: 100 }));
    c.arr(r.trace.serverEvents, "$.trace.serverEvents", 100);
  }
  c.arr(r.timeline, "$.timeline", LIMITS.timeline, (t, p) => c.str(t, p, { max: 2000 }));
  if (c.obj(r.sdk, "$.sdk")) {
    c.str(r.sdk.version, "$.sdk.version", { max: 50 });
    c.arr(r.sdk.features, "$.sdk.features", 20);
  }
  c.str(r.teamToken, "$.teamToken", { optional: true, max: 4096 });
  c.str(r.guestToken, "$.guestToken", { optional: true, max: 4096 });
  c.str(r.turnstileToken, "$.turnstileToken", { optional: true, max: 4096 });

  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: input as unknown as ReportSubmission };
}

export function artifactLimit(kind: string): number {
  return kind === "replay" || kind === "recording" ? LIMITS.replayBytes : LIMITS.artifactBytes;
}

export function validateFlagBatch(input: unknown): ValidationResult<FlagBatch> {
  const c = new Checker();
  if (!c.obj(input, "$")) return { ok: false, errors: c.errors };
  c.arr(input.flags, "$.flags", 200, (f, p) => {
    if (!c.obj(f, p)) return;
    c.str(f.name, `${p}.name`, { max: 200 });
    c.oneOf(f.severity, SEVERITIES, `${p}.severity`);
    c.arr(f.fingerprint, `${p}.fingerprint`, 20, (s, pp) => c.str(s, pp, { max: 200 }));
    c.date(f.at, `${p}.at`);
    c.num(f.count, `${p}.count`);
  });
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: input as unknown as FlagBatch };
}
