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
 * That is the whole command. `npm run test:e2e` builds the SPA first and this file's
 * {@link https://playwright.dev/docs/test-webserver `webServer`} starts the BFF, so the suite
 * brings up what it needs. An app already listening on `APP_ORIGIN` is reused rather than
 * fought over - which is the common case in development, where `overmind start` is already
 * running. Reuse means the *server process* is whatever was already started: if you have
 * changed anything under `server/`, restart it before trusting a pass.
 *
 * Environment variables:
 *
 *   APP_ORIGIN                origin of the app under test, e.g. `http://localhost:3000`.
 *                             Required; there is no default, because this is also the origin
 *                             the launch client's `redirect_uri` is registered against, so the
 *                             suite cannot simply be aimed elsewhere.
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
 *   SQLITE_PATH               the app's database, which `e2e/refusal.spec.ts` reads to prove a
 *                             refused launch created no session row.
 *   PORT                      passed through to the server this file starts.
 *
 * Nothing is validated at config load time, so `playwright test --list` works without
 * credentials. `e2e/globalSetup.ts` resolves the environment once the run starts and fails
 * naming the first variable that is missing.
 * @author John Grimes
 */

import { defineConfig, devices } from "@playwright/test";

/** The app origin, which both `baseURL` and the `webServer` readiness probe need. */
const appOrigin = process.env.APP_ORIGIN;

export default defineConfig({
  testDir: ".",
  // The suite drives one Aidbox instance and asserts its end state, so specs must not race
  // each other over shared server-side resources.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  /*
   * Every spec talks to a hosted Aidbox instance over the internet: a launch, an RPC, a mint
   * that publishes a Task, a manifest fetch that mints a grant, and a FHIR transaction. The
   * per-spec budget is set in each file; this is the ceiling for the slowest of them.
   */
  timeout: 240_000,
  expect: { timeout: 30_000 },
  globalSetup: "./globalSetup.ts",
  use: {
    baseURL: appOrigin,
    trace: "on-first-retry",
  },
  /*
   * Only when there is an origin to serve on. With `APP_ORIGIN` unset there is nothing to
   * point a readiness probe at, and `globalSetup` is the right place for that failure: it
   * names the variable.
   */
  webServer:
    appOrigin === undefined
      ? undefined
      : {
          command: "npx tsx server/index.ts",
          cwd: "..",
          url: appOrigin,
          reuseExistingServer: !process.env.CI,
          // A cold `tsx` start, and the registry and signing key to read.
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
