/**
 * SMART configuration discovery.
 *
 * `{issuer}/.well-known/smart-configuration` is how a SMART client learns where to send a user
 * for authorization and where to exchange a code or mint a token. It is not OIDC discovery and
 * there is no library worth the dependency here: the document is JSON, and the only two fields
 * this app uses are validated below.
 *
 * Validation is the point. An issuer is trusted enough to be in the registry, but a compromised
 * or misconfigured well-known document could otherwise redirect a clinician's credentials to a
 * plain-HTTP endpoint, so both endpoints must be absolute `https` URLs before anything is
 * built from them.
 *
 * Results are cached in memory, keyed by issuer, for the life of the process. Failures are not
 * cached, so a server that was briefly down is retried on the next launch.
 * @author John Grimes
 */

import { isJsonObject } from "../json";

/** The endpoints a launch and a mint need. */
export interface SmartConfiguration {
  /** The issuer this document was fetched for, as registered. */
  readonly issuer: string;
  /** Where the browser is sent to authorize. */
  readonly authorizationEndpoint: string;
  /** Where codes are exchanged and Backend Services tokens are minted. */
  readonly tokenEndpoint: string;
}

/** Cache of successful discoveries, keyed by issuer with any trailing slash removed. */
const cache = new Map<string, SmartConfiguration>();

/**
 * Read one required, absolute, `https` endpoint out of the document.
 * @param document the parsed well-known document
 * @param field the field name, as it appears on the wire
 * @param issuer the issuer, for attribution
 * @returns the endpoint URL
 * @throws {Error} naming the issuer and the field when the endpoint is missing or unusable
 */
function requireHttpsEndpoint(
  document: Record<string, unknown>,
  field: string,
  issuer: string,
): string {
  const value = document[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`SMART configuration for ${issuer} is missing "${field}"`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `SMART configuration for ${issuer} has a "${field}" that is not an absolute URL`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `SMART configuration for ${issuer} has a "${field}" that is not https`,
    );
  }
  return value;
}

/**
 * Fetch, validate and cache an issuer's SMART configuration.
 * @param issuer the FHIR base URL of the issuer, with or without a trailing slash
 * @returns the authorization and token endpoints
 * @throws {Error} naming the issuer when the document is unreachable, is not JSON, or does not
 *   carry usable `authorization_endpoint` and `token_endpoint` values
 * @example
 * const { tokenEndpoint } = await discoverSmartConfiguration(registration.issuer);
 */
export async function discoverSmartConfiguration(
  issuer: string,
): Promise<SmartConfiguration> {
  const key = issuer.replace(/\/+$/, "");
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const url = `${key}/.well-known/smart-configuration`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `SMART configuration for ${issuer} could not be fetched from ${url}: ${reason}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `SMART configuration for ${issuer} could not be fetched from ${url}: ` +
        `HTTP ${response.status}`,
    );
  }

  let document: unknown;
  try {
    document = await response.json();
  } catch {
    throw new Error(
      `SMART configuration for ${issuer} at ${url} is not valid JSON`,
    );
  }
  if (!isJsonObject(document)) {
    throw new Error(
      `SMART configuration for ${issuer} at ${url} is not a JSON object`,
    );
  }

  const configuration: SmartConfiguration = {
    issuer,
    authorizationEndpoint: requireHttpsEndpoint(
      document,
      "authorization_endpoint",
      issuer,
    ),
    tokenEndpoint: requireHttpsEndpoint(document, "token_endpoint", issuer),
  };
  cache.set(key, configuration);
  return configuration;
}

/**
 * Empty the discovery cache. Used by tests, and available for an operational reload.
 */
export function clearSmartConfigurationCache(): void {
  cache.clear();
}
