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
    /*
     * `@aehrc/sdc-template-extract` reaches into `fhirpath/fhir-context/r4` as a directory, which
     * Node's ESM loader refuses outright. Inlining the package processes it through Vite, which
     * resolves directory imports the way the bundler does at build time - so the test runs against
     * the same resolution the browser gets rather than a stricter one nothing else applies.
     */
    server: {
      deps: {
        inline: ["@aehrc/sdc-template-extract"],
      },
    },
    exclude: ["e2e/**", "node_modules/**", "dist/**", "dist-server/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      /*
       * The threshold applies to the code unit tests are the right instrument for: the BFF, the
       * operational setup, and the browser-side logic this feature introduced. Two kinds of file
       * are deliberately outside it.
       *
       * React components and routes are covered by the Playwright acceptance suite under `e2e/`,
       * which exercises them the way a user does. Asserting their rendered output twice would
       * buy coverage percentage rather than confidence.
       *
       * The browser modules that predate this feature (`src/link` codecs, most of `src/fhir`, the
       * rest of `src/lib`) have no unit tests yet. Including them would set the threshold to
       * whatever they happen to score, which is not a standard. They are verified today by
       * `npm run check:e2e` and `npm run check:e2e-shl`, and bringing them under test is separate
       * work with its own scope.
       *
       * `src/fhir/newPatient.ts` is named individually for the opposite reason: it is pure, it has
       * no I/O, and it is covered deliberately rather than incidentally. Reading a registration out
       * of a stranger's answers is the kind of thing that fails silently - a dropped definition
       * seeds nothing and looks fine - so it is held to the threshold rather than left to the
       * acceptance suite.
       */
      include: [
        "server/**",
        "ops/**",
        "src/fill/**",
        "src/fhir/newPatient.ts",
        "src/lib/session.ts",
        "src/link/apiAccess.ts",
        "src/link/invitationBundle.ts",
      ],
      exclude: ["**/*.test.{ts,tsx}", "tests/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
