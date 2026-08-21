/**
 * Playwright configuration for the two-window acceptance suite.
 *
 * Everything environment-specific arrives through the environment, so the suite can be
 * pointed at a local `overmind` stack or a deployed one without editing this file. Run it
 * with the secret references resolved:
 *
 *   op run --env-file .env.e2e -- npm run test:e2e
 *
 * Environment variables:
 *
 *   E2E_BASE_URL                   origin of the running app under test, e.g.
 *                                  `http://localhost:5273`. Required; there is no default
 *                                  and no `webServer` block, because the app is brought up
 *                                  separately (`overmind start`, Docker, or Kubernetes).
 *   AIDBOX_BASE_URL                Aidbox FHIR base URL, which is also the SMART issuer,
 *                                  e.g. `https://kuzfdswqmz.edge.aidbox.app/fhir`.
 *   AIDBOX_OPERATOR_CLIENT_ID      Basic-auth API client used by the specs to assert the
 *   AIDBOX_OPERATOR_CLIENT_SECRET  server-side end state and to call the
 *                                  `aidbox.smart/get-launch-uri` RPC for the EHR-launch
 *                                  scenario.
 *   E2E_USER_USERNAME              Aidbox `User` the specs sign in as during the launch
 *   E2E_USER_PASSWORD              flow. Registered by `ops/aidboxSetup.ts`.
 * @author John Grimes
 */

import { defineConfig, devices } from "@playwright/test";

/**
 * Environment inputs for the acceptance suite, resolved once here so specs share one view
 * of them and a missing value fails with a named variable rather than an empty string.
 *
 * Reading is deliberately lazy in the sense that nothing is validated at config load time:
 * `playwright test --list` must work without credentials.
 */
export const e2eEnvironment = {
  baseUrl: process.env.E2E_BASE_URL,
  aidbox: {
    baseUrl: process.env.AIDBOX_BASE_URL,
    operatorClientId: process.env.AIDBOX_OPERATOR_CLIENT_ID,
    operatorClientSecret: process.env.AIDBOX_OPERATOR_CLIENT_SECRET,
  },
  user: {
    username: process.env.E2E_USER_USERNAME,
    password: process.env.E2E_USER_PASSWORD,
  },
} as const;

export default defineConfig({
  testDir: ".",
  // The suite drives one Aidbox instance and asserts its end state, so specs must not race
  // each other over shared server-side resources.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: e2eEnvironment.baseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
