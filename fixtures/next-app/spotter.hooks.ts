/**
 * The fixture's hooks. `testRecorder` keeps every issue the route handler
 * finalises (in memory and in .spotter-test/issues.json) so the e2e suite can
 * assert on the exact spotter.report.v1 payload a real hook would receive.
 */
import { defineHook } from "@trusplex/spotter/core";
import type { Issue } from "@trusplex/spotter/core";

type Store = { issues: Issue[] };
const g = globalThis as typeof globalThis & { __spotterFixture?: Store };
export const store: Store = (g.__spotterFixture ??= { issues: [] });

export const testRecorder = defineHook({
  name: "test-recorder",
  dedupe: "none",
  async send(issue) {
    store.issues.push(issue);
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(".spotter-test", { recursive: true });
      await fs.writeFile(".spotter-test/issues.json", JSON.stringify(store.issues, null, 2));
    } catch {
      /* read-only FS: memory is enough for the tests */
    }
    return { externalId: issue.id, url: `http://localhost:3100/api/test/issues?id=${issue.id}` };
  },
});

export const spotterHooks = [testRecorder];
