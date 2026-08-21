/**
 * The API access grant: the second file of a manifest, and the whole of the direct-return
 * channel.
 *
 * A grant is a short-lived bearer token plus the three facts a filler needs to use it - where it
 * may be presented (`aud`), how long it is claimed to last (`expires_in`), and which patient the
 * answers are about (`patient`, when the request named one). Its wire shape is fixed by
 * `contracts/shl-wire.md`, mirroring the Platypus contract, so this module holds both halves of
 * that shape rather than letting the producer and the consumer drift apart.
 *
 * ## Tolerance is a two-sided rule
 *
 * The contract tells a consumer to treat a grant as *absent* - not as an error - when it is not
 * a JSON object, when `access_token` is missing or empty, when `aud` is missing or is not
 * `https`, or when `token_type` is not Bearer. A malformed grant must never block the form.
 *
 * {@link buildGrant} is the same rule read from the other side: rather than emit something a
 * conformant filler would be obliged to throw away, it declines, and the manifest degrades to a
 * one-file response the filler already knows how to handle. The alternative - emitting
 * `token_type: "Bearer"` for a token that is not one, or an `http` destination for a bearer
 * token - is not tolerance, it is a lie that a filler would act on.
 * @author John Grimes
 */

/** Content type of the grant file, as the filler contract names it. */
export const GRANT_CONTENT_TYPE = "application/smart-api-access";

/** The token type this app is able to state a grant for. */
const BEARER = "Bearer";

/**
 * The grant file's plaintext.
 *
 * Deliberately snake_case: these are OAuth token response members, and a filler written against
 * the Platypus contract reads them by those names.
 */
export interface ApiAccessGrant {
  /** The minted access token. Never logged, never stored. */
  readonly access_token: string;
  /** Always `Bearer`; a token this app cannot present that way is not stated as a grant. */
  readonly token_type: "Bearer";
  /** Stated lifetime in seconds. */
  readonly expires_in: number;
  /** The launched server's FHIR base URL: where, and only where, the token may be presented. */
  readonly aud: string;
  /** The destination patient, present only when the request named one. */
  readonly patient?: string;
}

/** What a grant is built out of. */
export interface GrantOptions {
  /** The access token, as the authorisation server issued it. */
  readonly accessToken: string;
  /** The token type the authorisation server reported. */
  readonly tokenType: string;
  /** The lifetime the authorisation server reported, in seconds. */
  readonly expiresIn: number;
  /** The launched server's FHIR base URL. */
  readonly aud: string;
  /** The destination patient, or null when the request named none. */
  readonly patientId: string | null;
  /** The deployment's configured grant lifetime, which acts as a ceiling. */
  readonly grantTtlSeconds: number;
}

/**
 * State a token response as a grant, or decline to.
 * @param options the token, destination, patient and configured lifetime
 * @returns the grant, or undefined when it could not be stated honestly - in which case the
 *   manifest carries the invitation alone
 * @example
 * const grant = buildGrant({
 *   accessToken: token.access_token,
 *   tokenType: token.token_type,
 *   expiresIn: token.expires_in,
 *   aud: "https://ehr.example.org/fhir",
 *   patientId: "pt-1",
 *   grantTtlSeconds: 3600,
 * });
 */
export function buildGrant(options: GrantOptions): ApiAccessGrant | undefined {
  const { accessToken, tokenType, expiresIn, aud, patientId, grantTtlSeconds } =
    options;

  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    return undefined;
  }
  if (
    typeof tokenType !== "string" ||
    tokenType.trim().toLowerCase() !== BEARER.toLowerCase()
  ) {
    return undefined;
  }
  // `aud` is where a bearer token will be presented; http would present it in the clear.
  if (typeof aud !== "string" || !/^https:\/\/\S+$/i.test(aud)) {
    return undefined;
  }

  /*
   * The configured lifetime is a ceiling, not a claim. Stating longer than the authorisation
   * server granted would send a filler to a destination that will refuse it; stating longer than
   * the deployment configured would ignore FR-016. An unusable lifetime - absent, negative,
   * infinite - is a grant with nothing honest to say about its own window, so it is declined
   * rather than emitted as "no stated expiry".
   */
  if (!Number.isFinite(expiresIn) || !Number.isFinite(grantTtlSeconds)) {
    return undefined;
  }
  const stated = Math.floor(Math.min(expiresIn, grantTtlSeconds));
  if (stated <= 0) {
    return undefined;
  }

  return {
    access_token: accessToken,
    token_type: BEARER,
    expires_in: stated,
    aud,
    ...(patientId === null ? {} : { patient: patientId }),
  };
}
