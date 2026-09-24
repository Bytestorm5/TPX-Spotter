/**
 * Type-level tests for the generated-types seam (`typed.ts`): compile small
 * fixtures that augment `SpotterFeatureFlags` / `SpotterRegister` the way
 * `withSpotter()`'s generated d.ts does, and assert that `@ts-expect-error`
 * lines really are errors (tsc reports unused ones) and nothing else is.
 *
 * Each scenario is its own program, since an augmentation is global to one.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("../..", import.meta.url));
const dir = join(pkg, "test/types", `.fixtures-${process.pid}`);
const core = join(pkg, "src/core/index.ts").replace(/\\/g, "/");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function compile(name: string, source: string): string[] {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source.replaceAll("CORE", core));
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: ["node"],
    typeRoots: [join(pkg, "node_modules/@types")],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file)
    .map((d) => `${d.start !== undefined ? d.file!.getLineAndCharacterOfPosition(d.start).line + 1 : "?"}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("generated types", () => {
  it("is permissive without augmentation", () => {
    const errors = compile(
      "default",
      `import { spotter } from "CORE";
spotter.track("anything", { plan: "pro" });
spotter.flag("x", { severity: "warning" });
spotter.setContext("cart", { items: 2 });
void spotter.report({ title: "t", fields: { anything: 1 } });
const v: unknown = 1;
spotter.assert(typeof v === "number", "must.be.number");
const n: number = v; // narrowed by the assertion signature
void n;
`,
    );
    expect(errors).toEqual([]);
  });

  it("makes compiled-out feature APIs uncallable", () => {
    const errors = compile(
      "off",
      `import { spotter } from "CORE";
declare module "CORE" {
  interface SpotterFeatureFlags { analytics: false; flags: false; recording: false; widget: true }
}
// @ts-expect-error analytics is compiled out
spotter.track("signup");
// @ts-expect-error analytics is compiled out
spotter.pageview();
// @ts-expect-error flags are compiled out
spotter.flag("x");
// @ts-expect-error recording is compiled out
void spotter.startRecording();
spotter.open({ prefill: { title: "still fine" } });
void spotter.report({ title: "reports always work" });
`,
    );
    expect(errors).toEqual([]);
  });

  it("types event names, custom fields and contexts from the register", () => {
    const errors = compile(
      "register",
      `import { spotter } from "CORE";
declare module "CORE" {
  interface SpotterRegister {
    events: "signup_completed" | "checkout_started";
    fields: { order_number: string; plan: "free" | "pro" };
    contexts: { cart: { items: number; total: number } };
  }
}
spotter.track("signup_completed", { plan: "pro" });
// @ts-expect-error not a registered event
spotter.track("signup_complete");
void spotter.report({ title: "t", fields: { plan: "pro", order_number: "A-1" } });
// @ts-expect-error wrong field value
void spotter.report({ title: "t", fields: { plan: "enterprise" } });
spotter.setContext("cart", { items: 1, total: 9 });
// @ts-expect-error unknown context
spotter.setContext("wishlist", { items: 1 });
// @ts-expect-error wrong context shape
spotter.setContext("cart", { items: "1", total: 9 });
spotter.open({ prefill: { fields: { order_number: "A-2" } } });
`,
    );
    expect(errors).toEqual([]);
  });

  it("reports an unused @ts-expect-error (the harness itself works)", () => {
    const errors = compile(
      "sanity",
      `import { spotter } from "CORE";
// @ts-expect-error this line is fine, so tsc must complain
spotter.track("ok");
`,
    );
    expect(errors.join("\n")).toMatch(/Unused '@ts-expect-error'/);
  });
});
