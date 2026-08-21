/**
 * Vitest configuration.
 *
 * Tests live under `tests/`, mirroring the source tree they exercise:
 *
 *   - `tests/server/**`  the BFF, run in Node
 *   - `tests/ops/**`     the Aidbox setup script, run in Node
 *   - `tests/src/**`     the SPA's libraries and components
 *
 * The default environment is `node`. React component tests that need a DOM opt in per file
 * with a docblock at the top of the file:
 *
 *   `// @vitest-environment jsdom`
 *
 * This is preferred over a glob-to-environment mapping because only a minority of the
 * `tests/src/**` files render components, and `environmentMatchGlobs` was removed in
 * Vitest 4.
 *
 * The Playwright suite under `e2e/` is excluded: it is driven by `npm run test:e2e`.
 * @author John Grimes
 */

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**", "dist-server/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**", "server/**", "ops/**"],
      exclude: ["**/*.test.{ts,tsx}", "src/main.tsx"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
