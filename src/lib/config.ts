/**
 * Runtime configuration, fetched from `/config.json` at boot.
 *
 * This mirrors the approach used by `apps/smart-forms-app`
 * (`src/features/configChecker/utils/config.ts`) in the smart-forms monorepo: config is fetched
 * at runtime rather than baked in at build time, so the same built artifact can be deployed
 * against different terminology servers.
 *
 * What is *not* here is the point. This file used to name three FHIR servers - a forms
 * catalogue, a response server and a blob host - because the app had no launch context and had
 * to be told where everything was. It now has one: the requester signs in to a clinical system
 * and reads and writes that system through the BFF proxy at `/api/fhir` (FR-004). There is
 * nothing left to configure about which server holds the data, because the answer is always
 * "the one you launched from", and the permitted servers are the deployment's issuer registry on
 * the server side rather than a URL the browser could be pointed at.
 *
 * So four settings remain, and none of them names a data server: a terminology server the
 * renderer expands ValueSets against, the origin links are built on, who requests appear to come
 * from, and how long a link stays openable.
 * @author John Grimes
 */

export interface AppConfig {
  /** FHIR terminology server for ValueSet expansion, passed through to the renderer. */
  terminologyServerUrl: string;

  /**
   * Origin used when building links, e.g. `https://links.example.org`.
   * When null, `window.location.origin` is used, which is what you want in dev.
   */
  linkBaseUrl: string | null;

  /**
   * Who requests appear to come from, e.g. `"Parkview Medical Centre"`.
   *
   * A fallback rather than the source of truth: a launched session knows who is signed in, and
   * that name is the one written to `Task.requester.display`. This covers the case where the
   * launch disclosed no user, which is legal - an invitation that cannot say who sent it is one
   * a patient has every reason to decline.
   */
  senderName: string | null;

  /**
   * How long a request stays openable, in days. `null` means no expiry.
   *
   * Sets the SHL payload's `exp`. Matches the 30-day default Platypus uses for its own
   * invitations.
   */
  linkLifetimeDays: number | null;
}

export const FALLBACK_CONFIG: AppConfig = {
  terminologyServerUrl: "https://r4.ontoserver.csiro.au/fhir",
  linkBaseUrl: null,
  senderName: null,
  linkLifetimeDays: 30,
};

/**
 * Whether a value is an absolute `http` or `https` URL.
 * @param value the candidate
 * @returns true when it parses as one
 */
function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\/.+/.test(value.trim())) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absent is fine and takes the fallback; present but the wrong shape is not.
 * @param value the candidate
 * @param valid the predicate to apply when the value is present
 * @returns true when the value is absent, or present and valid
 */
function isAbsentOr(
  value: unknown,
  valid: (candidate: unknown) => boolean,
): boolean {
  return value === undefined || valid(value);
}

/**
 * Exported so tests can assert the shipped `public/config.json` actually validates.
 *
 * Fields added after the first release are optional: a config written before they existed is not
 * malformed, it just does not mention them, and {@link loadConfig} fills them from
 * {@link FALLBACK_CONFIG}. Rejecting it outright would discard the settings it *does* specify and
 * silently point a deployment somewhere else. Keys this app no longer honours are ignored for the
 * same reason: a config file left over from the anonymous-mode release is not a broken one.
 * @param value the parsed `config.json`
 * @returns true when every field it does declare is usable
 */
export function isAppConfig(value: unknown): value is Partial<AppConfig> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isValidUrl(candidate.terminologyServerUrl) &&
    (candidate.linkBaseUrl === null || isValidUrl(candidate.linkBaseUrl)) &&
    isAbsentOr(
      candidate.senderName,
      (name) =>
        name === null || (typeof name === "string" && name.trim() !== ""),
    ) &&
    isAbsentOr(
      candidate.linkLifetimeDays,
      (days) =>
        days === null ||
        (typeof days === "number" && Number.isFinite(days) && days > 0),
    )
  );
}

/**
 * Load `/config.json`, falling back to {@link FALLBACK_CONFIG} if it is missing or malformed.
 *
 * A missing config is not fatal: nothing here decides where data is read from or written to, so
 * defaulting the terminology server and the link lifetime is a safe and useful behaviour.
 * @returns the loaded configuration, merged over the fallback
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch("/config.json", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return FALLBACK_CONFIG;
    }

    const parsed: unknown = await response.json();
    if (!isAppConfig(parsed)) {
      console.warn("config.json is malformed, falling back to defaults");
      return FALLBACK_CONFIG;
    }

    // Merged rather than returned as-is, so a config predating a field gets that field's default
    // instead of `undefined`.
    return { ...FALLBACK_CONFIG, ...parsed };
  } catch {
    console.warn("config.json could not be loaded, falling back to defaults");
    return FALLBACK_CONFIG;
  }
}

/**
 * Origin that generated links point at.
 * @param config the loaded configuration
 * @returns the configured origin, or the browser's own
 */
export function resolveLinkBaseUrl(config: AppConfig): string {
  return config.linkBaseUrl ?? globalThis.location.origin;
}

/**
 * Epoch seconds at which a request minted now should stop being openable.
 * @param config the loaded configuration
 * @param now the current time in milliseconds, injectable for tests
 * @returns the expiry, or undefined when links do not expire
 */
export function resolveExpiry(
  config: AppConfig,
  now = Date.now(),
): number | undefined {
  if (config.linkLifetimeDays === null) {
    return undefined;
  }

  return Math.floor(now / 1000) + Math.round(config.linkLifetimeDays * 86_400);
}
