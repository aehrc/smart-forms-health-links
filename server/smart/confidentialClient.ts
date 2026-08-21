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
 * a client to skip signature validation in exactly that situation. The only thing taken from
 * the claims is a display string for `Task.requester.display` - nothing is authorised on the
 * basis of them - so an unverified decode is the appropriate amount of work here.
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
  /** A display name for the signed-in user, when one can be derived. */
  readonly userDisplay: string | null;
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
 * Derive the display name to record for `Task.requester.display`.
 *
 * The candidates are tried in decreasing order of how much like a person's name they are: the
 * ID token's `name`, then `preferred_username`, then the `fhirUser` reference from either the
 * claims or the token response body.
 * @param payload the parsed token response
 * @returns the display name, or null when the launch disclosed nothing usable
 */
function readUserDisplay(payload: Record<string, unknown>): string | null {
  const claims = decodeIdTokenClaims(payload.id_token) ?? {};
  const candidates = [
    claims.name,
    claims.preferred_username,
    claims.fhirUser,
    payload.fhirUser,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
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
    patientId:
      typeof payload.patient === "string" && payload.patient.length > 0
        ? payload.patient
        : null,
    userDisplay: readUserDisplay(payload),
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
