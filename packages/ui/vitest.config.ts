import { defineConfig } from "vitest/config";

// Node by default; DOM tests opt in per file with `// @vitest-environment happy-dom`,
// which keeps "importable in Node without a DOM" honest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/**/browser/**", "node_modules/**"],
    testTimeout: 20_000,
  },
});
