/**
 * What the acceptance suite checks before it starts a browser.
 *
 * Two failures are worth catching here rather than inside a spec. A missing environment variable
 * should say which one, once, instead of surfacing as a launch that stops at an empty URL in every
 * spec. And an app that is not actually serving should say so, instead of appearing as a
 * navigation timeout that reads like a bug in the app under test.
 *
 * The reachability probe asks for `/api/issuers` rather than `/`: `/` is the SPA's index page,
 * which a bare static file server would answer perfectly well, whereas the issuer list only
 * exists if the BFF is running with a registry configured. It is also the one route that proves,
 * before anything else runs, that the issuer the specs launch against is registered - which is
 * otherwise a confusing 403 in the middle of scenario 1.
 * @author John Grimes
 */

import { readLaunchEnvironment } from "./support/launch";

/**
 * Resolve the environment and prove the app is up and registered for the issuer under test.
 * @returns nothing
 * @throws {Error} naming the missing environment variable, or describing why the app at
 *   `APP_ORIGIN` cannot be used
 * @example
 * // Wired as `globalSetup` in `e2e/playwright.config.ts`.
 */
export default async function globalSetup(): Promise<void> {
  const environment = readLaunchEnvironment();

  const issuersUrl = `${environment.appOrigin}/api/issuers`;
  let response: Response;
  try {
    response = await fetch(issuersUrl, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(
      `nothing answered ${issuersUrl}. Build the SPA and start the app first ` +
        `(npm run build, then op run --env-file .env -- npx tsx server/index.ts), or point ` +
        `APP_ORIGIN at a running deployment.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `${issuersUrl} answered HTTP ${response.status}, so the app at ${environment.appOrigin} ` +
        `is not serving its own API.`,
    );
  }

  const registry: unknown = await response.json();
  const entries: unknown[] = Array.isArray(registry) ? registry : [];
  const registered = entries.flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "issuer" in entry &&
    typeof entry.issuer === "string"
      ? [entry.issuer]
      : [],
  );
  if (!registered.includes(environment.issuer)) {
    throw new Error(
      `${environment.issuer} is not in the app's issuer registry (it holds ` +
        `${registered.length === 0 ? "nothing" : registered.join(", ")}). Set E2E_ISSUER, or ` +
        `register the server in the file ISSUER_REGISTRY_PATH points at.`,
    );
  }
}
