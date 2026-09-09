/**
 * The API access grant: the second file of a manifest, and the whole of the direct-return
 * channel.
 *
 * A grant is a short-lived bearer token plus the four facts a filler needs to use it - where it
 * may be presented (`aud`), how long it is claimed to last (`expires_in`), what it permits
 * (`scope`), and which patient the answers are about (`patient`, when the request named one). Its wire shape is fixed by
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

import { coversScope } from "../auth/scopes";

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
  /**
   * Space-separated scopes the token was minted with.
   *
   * Optional for the same reason `expires_in` is, and read the same way: missing means "no
   * stated scope", which is a consumer that cannot check rather than a token with no
   * authority. A grant that states one can be measured against what a submission needs, and
   * a consumer that finds it too broad may decline to use it.
   */
  readonly scope?: string;
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
  /**
   * The scopes this token carries, or null when there are none to state.
   *
   * Required and nullable rather than optional, mirroring {@link GrantOptions.patientId}: this
   * app always knows what it minted, and an optional parameter is how a caller forgets.
   */
  readonly scope: string | null;
  /** The launched server's FHIR base URL. */
  readonly aud: string;
  /** The destination patient, or null when the request named none. */
  readonly patientId: string | null;
  /** The deployment's configured grant lifetime, which acts as a ceiling. */
  readonly grantTtlSeconds: number;
}

/**
 * Read a scope string, collapsing the whitespace a token response is free to vary.
 *
 * One value, one spelling: `"a  b"` and `"a\nb"` are the same two scopes, and normalising here
 * means neither a comparison nor a frozen fixture has to know that.
 * @param value the candidate, from a token response or straight off the wire
 * @returns the normalised scope string, or undefined when there is nothing to state
 */
function normaliseScope(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const collapsed = value.trim().replaceAll(/\s+/g, " ");
  return collapsed === "" ? undefined : collapsed;
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
 *   scope: SUBMISSION_SCOPES.join(" "),
 *   aud: "https://links.example.org/shl/inv-abc123/fhir",
 *   patientId: "pt-1",
 *   grantTtlSeconds: 3600,
 * });
 */
export function buildGrant(options: GrantOptions): ApiAccessGrant | undefined {
  const {
    accessToken,
    tokenType,
    expiresIn,
    scope,
    aud,
    patientId,
    grantTtlSeconds,
  } = options;

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

  /*
   * The same rule as the lifetime, one member along. A consumer is told to read a missing
   * `scope` as "no stated scope", so emitting one would hand a filler a credential it cannot
   * measure - and the whole reason the member exists is that a consumer should be able to
   * refuse a grant broader than the one action it needs. This app mints its own token and
   * therefore always knows the answer, so having nothing to say means something is wrong.
   */
  const statedScope = normaliseScope(scope);
  if (statedScope === undefined) {
    return undefined;
  }

  return {
    access_token: accessToken,
    token_type: BEARER,
    expires_in: stated,
    scope: statedScope,
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
 * Only the six members the contract defines survive. Anything else in the file is something no
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

  /*
   * Tolerant, exactly like `expires_in` above. A scope that is missing, empty, a number, an
   * array or an object means "no stated scope" - a grant that cannot be measured, which is
   * still a working grant. Reading any of those as absence would close a channel over a
   * member whose whole purpose is to be optional (FR-020).
   */
  const statedScope = normaliseScope(candidate.scope);

  const patient = candidate.patient;

  return {
    access_token: accessToken,
    token_type: BEARER,
    ...(stated === undefined ? {} : { expires_in: stated }),
    ...(statedScope === undefined ? {} : { scope: statedScope }),
    // Kept verbatim rather than as `URL.href`, which would normalise a base URL's trailing slash.
    aud: (aud as string).trim(),
    ...(typeof patient === "string" && patient.trim() !== ""
      ? { patient: patient.trim() }
      : {}),
  };
}

/**
 * The scopes this app's own submission actually exercises.
 *
 * Create a response, create a provenance, read and update a task - the four the transaction in
 * `src/fill/directSend.ts` performs, and nothing else. Kept here rather than read from the
 * deployment's issuer registry because this is a statement about what the *filler* needs, which
 * is a property of the code and not of anybody's configuration.
 */
export const SUBMISSION_SCOPES: readonly string[] = [
  "system/QuestionnaireResponse.c",
  "system/Provenance.c",
  "system/Task.r",
  "system/Task.u",
];

/**
 * The scopes a grant stated, as a list.
 * @param grant the grant
 * @returns the scopes, or an empty list when the grant stated none
 * @example
 * grantScopes(grant); // ["system/Task.r", "system/Task.u"]
 */
export function grantScopes(grant: ApiAccessGrant): string[] {
  return grant.scope === undefined
    ? []
    : grant.scope.split(" ").filter((scope) => scope !== "");
}

/**
 * Whether a grant permits everything a set of actions needs.
 *
 * Three-valued on purpose. `undefined` is "cannot say" - the grant stated no scope - and is
 * emphatically not `false`: a token response is allowed to omit `scope`, and treating silence
 * as refusal would close a working channel on a technicality. Only the destination knows for
 * certain, and it says so by refusing the request.
 * @param grant the grant
 * @param required the scopes the caller intends to exercise
 * @returns true or false when the grant stated a scope, undefined when it stated none
 * @example
 * if (grantCovers(grant, ["system/Task.r"]) === false) { skipTheTaskRead(); }
 */
export function grantCovers(
  grant: ApiAccessGrant,
  required: readonly string[],
): boolean | undefined {
  if (grant.scope === undefined) {
    return undefined;
  }
  const granted = grantScopes(grant);
  return required.every((scope) => coversScope(granted, scope));
}

/**
 * Scopes a grant states beyond the ones it needs to state.
 *
 * What a cautious consumer looks at before deciding whether to use a grant at all. Empty when
 * the grant stated nothing, because a grant that says nothing is not thereby claiming a lot.
 * @param grant the grant
 * @param permitted the scopes the caller considers reasonable
 * @returns the stated scopes that no permitted scope accounts for
 * @example
 * excessScopes(grant, SUBMISSION_SCOPES); // ["system/Patient.rs"]
 */
export function excessScopes(
  grant: ApiAccessGrant,
  permitted: readonly string[] = SUBMISSION_SCOPES,
): string[] {
  return grantScopes(grant).filter((scope) => !coversScope(permitted, scope));
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
