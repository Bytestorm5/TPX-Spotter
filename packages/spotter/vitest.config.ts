import { defineConfig } from "vitest/config";

// Node by default; DOM tests opt in per file with `// @vitest-environment happy-dom`,
// which keeps "importable in Node without a DOM" honest.
//
// The "source" condition resolves workspace packages (@trusplex/ui) to their
// TypeScript source, so tests don't need them built first. The rest are
// Vite's defaults, which setting `conditions` would otherwise replace.
export default defineConfig({
  resolve: { conditions: ["source", "module", "browser", "development|production"] },
  ssr: { resolve: { conditions: ["source", "module", "node", "development|production"] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/**/browser/**", "node_modules/**"],
    testTimeout: 20_000,
  },
});
