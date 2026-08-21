/**
 * Playwright configuration for the two-window acceptance suite.
 *
 * Everything environment-specific arrives through the environment, so the suite can be
 * pointed at a local `overmind` stack or a deployed one without editing this file. The
 * variables are the ones `.env` already carries for the app and for `ops/aidboxSetup.ts`, so
 * one resolution drives all three:
 *
 *   op run --env-file .env -- npm run test:e2e
 *
 * Environment variables:
 *
 *   APP_ORIGIN                origin of the running app under test, e.g.
 *                             `http://localhost:3000`. Required; there is no default and no
 *                             `webServer` block, because the app is brought up separately
 *                             (`overmind start`, Docker, or Kubernetes). It is also the origin
 *                             the launch client's `redirect_uri` is registered against, which
 *                             is why the suite cannot simply be aimed elsewhere.
 *   AIDBOX_BASE_URL           Aidbox root, e.g. `https://kuzfdswqmz.edge.aidbox.app`, which is
 *                             where `/rpc` and the authorisation endpoints live.
 *   E2E_ISSUER                the registered SMART issuer. Optional; defaults to
 *                             `${AIDBOX_BASE_URL}/fhir`, which is what setup registers.
 *   AIDBOX_CLIENT_ID          Basic-auth API client used by the specs to assert the
 *   AIDBOX_CLIENT_SECRET      server-side end state and to call the
 *                             `aidbox.smart/get-launch-uri` RPC for the EHR-launch scenario.
 *   AIDBOX_E2E_USER_ID        Aidbox `User` the specs sign in as during the launch flow, and
 *   AIDBOX_E2E_USER_EMAIL     the credentials to do it with. All three are registered by
 *   AIDBOX_E2E_USER_PASSWORD  `ops/aidboxSetup.ts`.
 *
 * `e2e/support/launch.ts` reads the same variables through `readLaunchEnvironment`, which is
 * how a spec obtains a signed-in session without driving the login pages in a browser.
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
  baseUrl: process.env.APP_ORIGIN,
  aidbox: {
    baseUrl: process.env.AIDBOX_BASE_URL,
    issuer: process.env.E2E_ISSUER,
    operatorClientId: process.env.AIDBOX_CLIENT_ID,
    operatorClientSecret: process.env.AIDBOX_CLIENT_SECRET,
  },
  user: {
    id: process.env.AIDBOX_E2E_USER_ID,
    username: process.env.AIDBOX_E2E_USER_EMAIL,
    password: process.env.AIDBOX_E2E_USER_PASSWORD,
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
