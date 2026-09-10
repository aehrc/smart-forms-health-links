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
  /**
   * Stated lifetime in seconds.
   *
   * Optional because a *consumer* may legitimately hold a grant that states none: the contract
   * reads a missing or absurd `expires_in` as "no stated expiry", which is a working grant
   * rather than an expired one. {@link buildGrant} always states one.
   */
  readonly expires_in?: number;
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

/**
 * A grant as it arrived, together with the moment it arrived.
 *
 * The pairing is the whole of the expiry rule. `expires_in` is a duration, not an instant, so
 * the only honest window is measured from when the manifest was read on *this* device - never by
 * comparing a local clock with the issuer's (FR-025). Carrying the two together makes it
 * impossible to compute a window without saying which reading it came from.
 */
export interface ReceivedGrant {
  /** The grant, as parsed. */
  readonly grant: ApiAccessGrant;
  /** Epoch milliseconds at which the manifest carrying it was read. */
  readonly receivedAt: number;
}

/**
 * An `https` URL, or nothing.
 *
 * Separate from the parse below because it is the same question asked in two places, and because
 * it is the one guard whose failure has a security consequence rather than a usability one: `aud`
 * is where a bearer token gets presented, so `http` here means handing the token to whoever is on
 * the path.
 * @param value the candidate, straight off the wire
 * @returns the parsed URL when it is a syntactically valid `https` URL, otherwise undefined
 */
function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a grant file's plaintext, applying the contract's tolerance rules.
 *
 * Every rejection below returns undefined rather than throwing, and the difference matters: a
 * filler holding an unusable grant has no direct channel, which is a state it already handles by
 * offering the scan-back return. A filler holding an *exception* has no form (FR-020).
 *
 * The one rule that is easy to invert is `expires_in`. A missing or absurd lifetime means "no
 * stated expiry", not "expired": the grant is kept and offered until the destination refuses it.
 * Reading it the other way round would close a working channel on a technicality.
 *
 * Only the five members the contract defines survive. Anything else in the file is something no
 * filler has agreed to interpret, and carrying it forward would invite exactly that.
 * @param plaintext the decrypted grant file
 * @returns the grant, or undefined when the file is to be treated as carrying none
 * @example
 * const grant = parseGrant(await readManifestFile(file, key));
 */
export function parseGrant(plaintext: string): ApiAccessGrant | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return undefined;
  }

  // Arrays are objects to `typeof`, and an array is not a grant.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;

  const accessToken = candidate.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    return undefined;
  }

  const tokenType = candidate.token_type;
  if (
    typeof tokenType !== "string" ||
    tokenType.trim().toLowerCase() !== BEARER.toLowerCase()
  ) {
    return undefined;
  }

  const aud = candidate.aud;
  if (httpsUrl(aud) === undefined) {
    return undefined;
  }

  const expiresIn = candidate.expires_in;
  const stated =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.floor(expiresIn)
      : undefined;

  const patient = candidate.patient;

  return {
    access_token: accessToken,
    token_type: BEARER,
    ...(stated === undefined ? {} : { expires_in: stated }),
    // Kept verbatim rather than as `URL.href`, which would normalise a base URL's trailing slash.
    aud: (aud as string).trim(),
    ...(typeof patient === "string" && patient.trim() !== ""
      ? { patient: patient.trim() }
      : {}),
  };
}

/**
 * The host a grant's answers will be sent to.
 *
 * The host rather than the whole URL, because this is what a disclosure has to name (FR-020) and
 * `https://sczsqtqcgi.aidbox.app/fhir` is not something a person can read as a destination.
 * @param grant the grant
 * @returns the destination's host, e.g. `ehr.example.org`
 * @example
 * `Answers will be sent to ${destinationHost(grant)}.`;
 */
export function destinationHost(grant: ApiAccessGrant): string {
  return httpsUrl(grant.aud)?.host ?? grant.aud;
}

/**
 * When a grant's stated window closes.
 * @param received the grant and the moment it was received
 * @returns epoch milliseconds, or undefined when the grant stated no expiry
 * @example
 * const closesAt = grantExpiresAt(received);
 */
export function grantExpiresAt(received: ReceivedGrant): number | undefined {
  const { expires_in: expiresIn } = received.grant;
  return expiresIn === undefined
    ? undefined
    : received.receivedAt + expiresIn * 1000;
}

/**
 * Whether a grant's stated window has closed.
 *
 * False for a grant that stated no window. That is not optimism: there is nothing to have
 * expired, and the only authority on whether such a token still works is the destination, which
 * says so by refusing it.
 * @param received the grant and the moment it was received
 * @param now epoch milliseconds to judge against; defaults to the current time
 * @returns true only when the grant stated a window and that window has passed
 * @example
 * if (isGrantExpired(received)) { … }
 */
export function isGrantExpired(
  received: ReceivedGrant,
  now = Date.now(),
): boolean {
  const closesAt = grantExpiresAt(received);
  return closesAt !== undefined && now > closesAt;
}
