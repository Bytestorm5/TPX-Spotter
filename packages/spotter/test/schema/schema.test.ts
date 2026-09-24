/**
 * The published JSON Schema must describe exactly `SpotterReportV1`:
 * - a realistic report validates (and broken ones don't), with a small
 *   hand-rolled draft 2020-12 subset validator (no ajv dependency);
 * - a drift check walks the TypeScript types with the compiler API and
 *   compares every object's properties, required-ness and enums with the
 *   schema, so a field added to one and not the other fails CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { exampleReport } from "./example-report.ts";
import { buildIssue } from "../../src/core/server/report.ts";

type Schema = Record<string, unknown>;
const root = JSON.parse(readFileSync(new URL("../../schema/spotter.report.v1.json", import.meta.url), "utf8")) as Schema;

function deref(s: Schema): Schema {
  const ref = s.$ref as string | undefined;
  if (!ref) return s;
  const name = ref.replace("#/$defs/", "");
  return deref((root.$defs as Record<string, Schema>)[name]!);
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Draft 2020-12 subset: $ref, type, const, enum, anyOf, properties, required, additionalProperties, items, maxItems, maxProperties, format date-time. */
function validate(value: unknown, schema: Schema, path = "$", errors: string[] = []): string[] {
  const s = deref(schema);
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  if (s.enum && !(s.enum as unknown[]).includes(value)) errors.push(`${path}: not in enum`);
  if (s.anyOf) {
    const ok = (s.anyOf as Schema[]).some((alt) => validate(value, alt, path, []).length === 0);
    if (!ok) errors.push(`${path}: matches no anyOf branch`);
  }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${t}`);
      return errors;
    }
  }
  if (s.format === "date-time" && typeof value === "string" && !DATE_TIME.test(value)) errors.push(`${path}: not a date-time`);
  if (Array.isArray(value)) {
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${path}: too many items`);
    if (s.items) value.forEach((v, i) => validate(v, s.items as Schema, `${path}[${i}]`, errors));
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) if (!(r in obj)) errors.push(`${path}: missing ${r}`);
    if (typeof s.maxProperties === "number" && Object.keys(obj).length > s.maxProperties) errors.push(`${path}: too many properties`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) validate(v, props[k]!, `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected property ${k}`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") validate(v, s.additionalProperties as Schema, `${path}.${k}`, errors);
    }
  }
  return errors;
}

describe("spotter.report.v1.json", () => {
  it("is a draft 2020-12 schema with the right id", () => {
    expect(root.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(root.title).toBe("spotter.report.v1");
  });

  it("validates a realistic report", () => {
    expect(validate(exampleReport(), root)).toEqual([]);
  });

  it("validates what the ingest builds (minimal server-side report)", async () => {
    const r = exampleReport();
    const issue = await buildIssue(
      {
        id: "rep_1",
        ref: "SPT-1",
        token: "t",
        clientId: "c",
        receivedAt: r.createdAt,
        submission: {
          ...r,
          clientId: "c",
          source: "server",
          environment: { runtime: "node", device: "server" },
          page: { url: "", history: [] },
          signals: { console: [], errors: [], network: { log: { version: "1.2", creator: { name: "x", version: "1" }, entries: [] } }, breadcrumbs: [], navigation: [] },
          artifacts: [],
          timeline: [],
        },
        artifacts: [],
        completed: true,
        status: { public: "received", history: [{ status: "received", at: r.createdAt }] },
        messages: [],
        plusOnes: 0,
        links: [],
        baseUrl: "https://x",
      },
      async () => undefined,
    );
    expect(validate(issue, root)).toEqual([]);
  });

  it("rejects broken reports", () => {
    const r = exampleReport() as unknown as Record<string, unknown>;
    expect(validate({ ...r, schema: "spotter.report.v2" }, root)).toContain('$.schema: expected const "spotter.report.v1"');
    expect(validate({ ...r, source: "email" }, root)).toContain("$.source: not in enum");
    expect(validate({ ...r, surprise: 1 }, root)).toContain("$: unexpected property surprise");
    const { reporter: _r, ...noReporter } = r;
    expect(validate(noReporter, root)).toContain("$: missing reporter");
    expect(validate({ ...r, createdAt: "yesterday" }, root)).toContain("$.createdAt: not a date-time");
  });
});

// -- drift check against the TypeScript types -------------------------------------------------

describe("schema ↔ TypeScript drift", () => {
  const file = fileURLToPath(new URL("../../src/core/schema.ts", import.meta.url));
  const program = ts.createProgram([file], { strict: true, target: ts.ScriptTarget.ES2022, allowImportingTsExtensions: true, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file)!;
  const decl = source.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === "SpotterReportV1")!;
  const reportType = checker.getTypeAtLocation(decl);
  const problems: string[] = [];

  const literals = (t: ts.Type): (string | number)[] | null => {
    const parts = t.isUnion() ? t.types : [t];
    if (!parts.every((p) => p.isStringLiteral() || p.isNumberLiteral())) return null;
    return parts.map((p) => (p as ts.LiteralType).value as string | number).sort();
  };

  function compare(type: ts.Type, schemaIn: Schema, path: string, depth = 0): void {
    if (depth > 12) return;
    const schema = deref(schemaIn);
    const t = checker.getNonNullableType(type);
    const name = checker.typeToString(t);
    // `Json` / `FieldValue`: open-ended in both (the schema's `json` def accepts any JSON value)
    if (name === "Json" || name === "FieldValue" || schema.anyOf) return;
    if (!schema.type && !schema.enum && !("const" in schema)) return;
    const lits = literals(t);
    if (lits) {
      const expected = ("const" in schema ? [schema.const] : ((schema.enum as unknown[]) ?? [])).map((v) => v as string | number).sort();
      if (JSON.stringify(lits) !== JSON.stringify(expected)) problems.push(`${path}: TS ${JSON.stringify(lits)} ≠ schema ${JSON.stringify(expected)}`);
      return;
    }
    if (t.flags & ts.TypeFlags.String) return void (schema.type !== "string" && problems.push(`${path}: expected string`));
    if (t.flags & ts.TypeFlags.Number) return void (schema.type !== "number" && problems.push(`${path}: expected number`));
    if (t.flags & ts.TypeFlags.BooleanLike || name === "boolean") return void (schema.type !== "boolean" && problems.push(`${path}: expected boolean`));
    if (checker.isTupleType(t)) return;
    if (checker.isArrayType(t)) {
      if (schema.type !== "array") return void problems.push(`${path}: expected array`);
      const el = checker.getTypeArguments(t as ts.TypeReference)[0]!;
      if (schema.items) compare(el, schema.items as Schema, `${path}[]`, depth + 1);
      return;
    }
    const index = checker.getIndexInfoOfType(t, ts.IndexKind.String);
    const props = checker.getPropertiesOfType(t);
    if (index && props.length === 0) {
      if (index.type.flags & ts.TypeFlags.Never) return; // Record<string, never>
      if (typeof schema.additionalProperties !== "object") return void problems.push(`${path}: expected a map (additionalProperties schema)`);
      compare(index.type, schema.additionalProperties as Schema, `${path}{}`, depth + 1);
      return;
    }
    if (schema.type !== "object") return void problems.push(`${path}: expected object (${name})`);
    const sProps = (schema.properties ?? {}) as Record<string, Schema>;
    const tsNames = props.map((p) => p.name).sort();
    const sNames = Object.keys(sProps).sort();
    if (JSON.stringify(tsNames) !== JSON.stringify(sNames)) problems.push(`${path}: properties TS [${tsNames}] ≠ schema [${sNames}]`);
    const tsRequired = props.filter((p) => !(p.flags & ts.SymbolFlags.Optional)).map((p) => p.name).sort();
    const sRequired = [...((schema.required as string[]) ?? [])].sort();
    if (JSON.stringify(tsRequired) !== JSON.stringify(sRequired)) problems.push(`${path}: required TS [${tsRequired}] ≠ schema [${sRequired}]`);
    for (const p of props) {
      if (!sProps[p.name]) continue;
      compare(checker.getTypeOfSymbolAtLocation(p, decl), sProps[p.name]!, `${path}.${p.name}`, depth + 1);
    }
  }

  it("has no drift", () => {
    compare(reportType, root, "$");
    expect(problems).toEqual([]);
  });
});
