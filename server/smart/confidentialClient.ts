/**
 * Token endpoint requests made as the confidential launch client.
 *
 * Two grants are issued from here: the authorization code exchange that completes a launch, and
 * the refresh that keeps a long-running session working. Both authenticate with
 * `client_secret_basic`, both are made server to server, and neither ever returns its raw
 * payload to a caller - what comes back is the small set of fields the session row holds.
 *
 * Three details are worth stating.
 *
 * **The Basic credentials are form-urlencoded first.** RFC 6749 section 2.3.1 requires the
 * client id and secret to be `application/x-www-form-urlencoded`-encoded before they are
 * concatenated and base64-encoded, precisely so that a secret containing a colon cannot forge a
 * different client id. {@link formUrlEncode} implements that encoding.
 *
 * **Errors name the endpoint and the status, never the body.** A refused token request is
 * reported as an HTTP status against a URL. The authorisation server's own error text is not
 * repeated, because it is not guaranteed to be free of the code or credentials it was handling,
 * and because a hostile server could otherwise write whatever it liked into our logs.
 *
 * **The ID token is decoded, not verified.** The token response arrives in the body of a
 * TLS-protected request that this process made directly to the issuer's own token endpoint, and
 * whose client authentication proves who is asking; OpenID Connect Core section 3.1.3.7 allows
 * a client to skip signature validation in exactly that situation. The only things taken from
 * the claims are a display string for `Task.requester.display` and the `fhirUser` reference a
 * name can be resolved from - nothing is authorised on the basis of them - so an unverified
 * decode is the appropriate amount of work here.
 * @author John Grimes
 */

import { isJsonObject } from "../json";

import type { LaunchClientRegistration } from "../config";

/** Assumed access token lifetime when a token response states none, per RFC 6749 section 5.1. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/** The fields a session row is built from. */
export interface LaunchTokenResponse {
  /** The launch access token. Never leaves the server. */
  readonly accessToken: string;
  /** Stated lifetime in seconds. */
  readonly expiresIn: number;
  /** The refresh token, when one was granted. */
  readonly refreshToken: string | null;
  /** The launch context patient, when the grant carried one. */
  readonly patientId: string | null;
  /**
   * A display name for the signed-in user taken from the ID token's claims, when it carried
   * one. Only a fallback: {@link module:server/smart/requesterDisplay} prefers the name on the
   * resource {@link LaunchTokenResponse.fhirUser} points at.
   */
  readonly userDisplay: string | null;
  /**
   * The `fhirUser` (or deprecated `profile`) reference the launch disclosed, verbatim. Never
   * requested as given - see `resolveRequesterDisplay`.
   */
  readonly fhirUser: string | null;
  /**
   * Scopes the authorisation server says it granted, verbatim from the token response.
   *
   * Worth carrying because it may be *narrower* than what was asked for, and a scope that was
   * asked for and refused is the difference between a capability the UI should offer and one it
   * should explain the absence of. Null when the response omitted `scope`, which is legal and
   * means "you got what you asked for".
   */
  readonly grantedScopes: string | null;
}

/** Arguments for a code exchange. */
export interface ExchangeOptions {
  /** The issuer's token endpoint, from SMART discovery. */
  readonly tokenEndpoint: string;
  /** The confidential launch client to authenticate as. */
  readonly client: LaunchClientRegistration;
  /** The authorization code from the callback. */
  readonly code: string;
  /** The redirect URI the code was issued against. */
  readonly redirectUri: string;
  /** The PKCE code verifier the pending session held. */
  readonly verifier: string;
}

/** Arguments for a refresh. */
export interface RefreshOptions {
  /** The issuer's token endpoint, from SMART discovery. */
  readonly tokenEndpoint: string;
  /** The confidential launch client to authenticate as. */
  readonly client: LaunchClientRegistration;
  /** The refresh token held by the session. */
  readonly refreshToken: string;
}

/**
 * `application/x-www-form-urlencoded`-encode one value, as RFC 6749 section 2.3.1 requires
 * before Basic-encoding a client id or secret.
 *
 * `encodeURIComponent` is percent-encoding for URI components, which differs from form encoding
 * in two ways: a space becomes `%20` rather than `+`, and `!'()*` are left alone. Both are
 * corrected here.
 * @param value the raw credential value
 * @returns the form-encoded value
 * @example
 * formUrlEncode("sec:ret pass&word"); // "sec%3Aret+pass%26word"
 */
function formUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replaceAll(
      /[!'()*]/g,
      (character) =>
        `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
    )
    .replaceAll("%20", "+");
}

/**
 * Build the `Authorization` header value for `client_secret_basic`.
 * @param client the confidential launch client registration
 * @returns the complete header value, including the `Basic ` scheme
 * @example
 * headers.authorization = basicAuthorizationHeader(registration.launchClient);
 */
export function basicAuthorizationHeader(
  client: LaunchClientRegistration,
): string {
  const credentials = `${formUrlEncode(client.clientId)}:${formUrlEncode(client.clientSecret)}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

/**
 * Decode an ID token's claims without verifying its signature.
 *
 * See the module comment for why that is acceptable here.
 * @param value the compact JWS from the token response, if there was one
 * @returns the claims, or undefined when there is no decodable payload
 */
function decodeIdTokenClaims(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return isJsonObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The first of the candidates that is a non-empty string.
 * @param candidates values in decreasing order of preference
 * @returns the first usable string, or null when there is none
 */
function firstString(candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read the launch context patient, but only when the launch actually granted patient context.
 *
 * The `patient` field of a token response means nothing on its own: it is `launch/patient`
 * (SMART App Launch section "Scopes for requesting context data") that asks for the context,
 * and this app only ever requests that scope for an EHR launch - a standalone launch has no
 * EHR context to be given and lets the requester choose the patient instead.
 *
 * Measured against Aidbox 2026-08-22: a standalone launch, whose granted scope is
 * `openid fhirUser launch online_access user/*.cruds`, nonetheless answers
 * `"patient": "prac-demo"` - the id of the signed-in user's own `fhirUser`, a `Practitioner`.
 * Taking that at face value would put a practitioner in `Task.for`. The granted scope is
 * therefore checked first, and a response that states no scope at all is not treated as having
 * granted context: SMART requires `scope` in an access token response.
 * @param payload the parsed token response
 * @returns the patient id, or null when no patient context was granted
 */
function readPatientContext(payload: Record<string, unknown>): string | null {
  const granted =
    typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  if (!granted.includes("launch/patient")) {
    return null;
  }
  return typeof payload.patient === "string" && payload.patient.length > 0
    ? payload.patient
    : null;
}

/**
 * Derive a display name for the signed-in user from the launch's own claims.
 *
 * `name` is a person's name and `preferred_username` usually is, so both are usable as
 * `Task.requester.display` (FR-009). A `fhirUser` reference is not: it is a URL, which is why
 * it is read separately by {@link readFhirUser} and resolved to a name instead.
 * @param payload the parsed token response
 * @returns the display name, or null when the claims disclosed none
 */
function readClaimDisplay(payload: Record<string, unknown>): string | null {
  const claims = decodeIdTokenClaims(payload.id_token) ?? {};
  return firstString([claims.name, claims.preferred_username]);
}

/**
 * Read the reference to the FHIR resource that represents the signed-in user.
 *
 * SMART App Launch puts it in the ID token's `fhirUser` claim and names `profile` as its
 * deprecated synonym; some servers also repeat it in the token response body. All three are
 * accepted, and none is dereferenced here.
 * @param payload the parsed token response
 * @returns the reference as given, or null when the launch disclosed none
 */
function readFhirUser(payload: Record<string, unknown>): string | null {
  const claims = decodeIdTokenClaims(payload.id_token) ?? {};
  return firstString([claims.fhirUser, claims.profile, payload.fhirUser]);
}

/**
 * Post a grant to the token endpoint as the confidential client and read the result.
 * @param tokenEndpoint the issuer's token endpoint
 * @param client the confidential launch client registration
 * @param form the grant parameters, without any client credentials
 * @returns the fields a session row is built from
 * @throws {Error} naming the endpoint, and the HTTP status for a refusal, when the request
 *   fails or the response is not a usable token response. The message never contains the grant,
 *   a credential or a token.
 */
async function postGrant(
  tokenEndpoint: string,
  client: LaunchClientRegistration,
  form: URLSearchParams,
): Promise<LaunchTokenResponse> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        authorization: basicAuthorizationHeader(client),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Token request to ${tokenEndpoint} failed: ${reason}`);
  }

  if (!response.ok) {
    throw new Error(
      `Token request to ${tokenEndpoint} was refused: HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Token response from ${tokenEndpoint} is not valid JSON`);
  }
  if (!isJsonObject(payload)) {
    throw new Error(
      `Token response from ${tokenEndpoint} is not a JSON object`,
    );
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(
      `Token response from ${tokenEndpoint} carries no "access_token"`,
    );
  }
  const expiresIn = payload.expires_in;

  return {
    accessToken,
    expiresIn:
      typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? expiresIn
        : DEFAULT_EXPIRES_IN_SECONDS,
    refreshToken:
      typeof payload.refresh_token === "string" &&
      payload.refresh_token.length > 0
        ? payload.refresh_token
        : null,
    patientId: readPatientContext(payload),
    userDisplay: readClaimDisplay(payload),
    fhirUser: readFhirUser(payload),
    grantedScopes: typeof payload.scope === "string" ? payload.scope : null,
  };
}

/**
 * Exchange an authorization code for a launch token.
 *
 * The client id is not repeated in the body: RFC 6749 section 4.1.3 requires it only when the
 * client is not authenticating, and this client authenticates with Basic credentials.
 * @param options the endpoint, client, code, redirect URI and PKCE verifier
 * @returns the fields a session row is built from
 * @throws {Error} naming the endpoint when the exchange fails or the response is unusable
 * @example
 * const token = await exchangeAuthorizationCode({
 *   tokenEndpoint, client: registration.launchClient, code, redirectUri, verifier,
 * });
 */
export async function exchangeAuthorizationCode(
  options: ExchangeOptions,
): Promise<LaunchTokenResponse> {
  return postGrant(
    options.tokenEndpoint,
    options.client,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.verifier,
    }),
  );
}

/**
 * Exchange a refresh token for a fresh launch token.
 * @param options the endpoint, client and refresh token
 * @returns the fields a session row is built from; `refreshToken` is null when the server did
 *   not rotate it, in which case the caller keeps the one it has
 * @throws {Error} naming the endpoint when the refresh fails or the response is unusable
 * @example
 * const token = await refreshLaunchToken({ tokenEndpoint, client, refreshToken });
 */
export async function refreshLaunchToken(
  options: RefreshOptions,
): Promise<LaunchTokenResponse> {
  return postGrant(
    options.tokenEndpoint,
    options.client,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
    }),
  );
}
