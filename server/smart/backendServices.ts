/**
 * SMART Backend Services: minting the short-lived access token that travels inside a grant
 * file, and publishing the public half of the signing key.
 *
 * Aidbox - and strict SMART Backend Services generally - accepts only asymmetric client
 * authentication, so every mint is a `client_credentials` request authenticated by an RS384
 * JWT the app signs with its registered private key (research.md, "Aidbox: Backend Services
 * client"). The authorisation server fetches the matching public key from the JWKS route
 * served out of {@link publicJwks}.
 *
 * Two rules hold throughout this module:
 *
 *  - Nothing replayable is ever put into an error, a return value the caller did not ask for,
 *    or a log line: not the minted token, not the assertion, not the key (FR-018). Failures
 *    report the endpoint, the HTTP status and the authorisation server's OAuth error code -
 *    which is a fixed vocabulary, not server-chosen prose.
 *  - Every call signs a new assertion with a new `jti`, so an intercepted assertion buys an
 *    attacker one already-used token request.
 * @author John Grimes
 */

import { SignJWT, importJWK } from "jose";
import { randomUUID } from "node:crypto";

import { isJsonObject } from "../json";

import type { IssuerRegistration } from "../config";
import type { JWK } from "jose";

/** The client assertion type SMART Backend Services requires. */
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Assertion lifetime. The specification caps this at five minutes; four leaves room for a
 * little clock skew without widening the replay window meaningfully.
 */
const CLIENT_ASSERTION_TTL_SECONDS = 240;

/** JWK members that carry private key material and must never be published. */
const PRIVATE_JWK_MEMBERS = new Set(["d", "p", "q", "dp", "dq", "qi", "k"]);

/**
 * OAuth error codes are a restricted vocabulary. Anything that does not look like one is
 * discarded rather than repeated, so a hostile or broken server cannot use the field to smuggle
 * text into our logs.
 */
const OAUTH_ERROR_CODE_PATTERN = /^[\w.:-]{1,64}$/;

/** A token response, in the wire shape the grant file also uses. */
export interface BackendTokenResponse {
  /** The minted access token. Never logged, never persisted. */
  readonly access_token: string;
  /** Token type, always `Bearer` in practice. */
  readonly token_type: string;
  /** Stated lifetime in seconds, as the authorisation server reported it. */
  readonly expires_in: number;
  /** Granted scope, when the server echoed one. */
  readonly scope?: string;
}

/** Arguments for a mint. */
export interface MintOptions {
  /** The issuer registration whose backend client is being used. */
  readonly registration: IssuerRegistration;
  /** The token endpoint from that issuer's SMART configuration. */
  readonly tokenEndpoint: string;
}

/**
 * Sign a client assertion for one token request.
 * @param registration the issuer registration holding the backend client and its key
 * @param tokenEndpoint the audience of the assertion
 * @returns the compact JWS
 * @throws {Error} when the configured key cannot be imported
 */
async function createClientAssertion(
  registration: IssuerRegistration,
  tokenEndpoint: string,
): Promise<string> {
  const { clientId, privateKeyJwk } = registration.backendClient;
  const key = await importJWK(privateKeyJwk, "RS384");
  return new SignJWT()
    .setProtectedHeader({ alg: "RS384", kid: privateKeyJwk.kid, typ: "JWT" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(tokenEndpoint)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(
      Math.floor(Date.now() / 1000) + CLIENT_ASSERTION_TTL_SECONDS,
    )
    .sign(key);
}

/**
 * Extract the OAuth error code from a refusal, if there is a recognisable one.
 * @param response the refusing response
 * @returns the error code, or undefined when the body is unusable
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isJsonObject(body) || typeof body.error !== "string") {
    return undefined;
  }
  return OAUTH_ERROR_CODE_PATTERN.test(body.error) ? body.error : undefined;
}

/**
 * Mint an access token for the invitation's issuer.
 * @param options the issuer registration and its token endpoint
 * @returns the parsed token response
 * @throws {Error} naming the endpoint - and, for a refusal, the status and OAuth error code -
 *   when the request fails or the response is not a usable token response. The message never
 *   contains a token, an assertion or key material.
 * @example
 * const { tokenEndpoint } = await discoverSmartConfiguration(registration.issuer);
 * const grant = await mintAccessToken({ registration, tokenEndpoint });
 */
export async function mintAccessToken(
  options: MintOptions,
): Promise<BackendTokenResponse> {
  const { registration, tokenEndpoint } = options;
  const assertion = await createClientAssertion(registration, tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: assertion,
    scope: registration.backendClient.scopes,
  });

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Backend Services token request to ${tokenEndpoint} failed: ${reason}`,
    );
  }

  if (!response.ok) {
    const code = await readErrorCode(response);
    throw new Error(
      `Backend Services token request to ${tokenEndpoint} was refused: ` +
        `HTTP ${response.status}` +
        (code === undefined ? "" : ` (${code})`),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `Backend Services token response from ${tokenEndpoint} is not valid JSON`,
    );
  }
  if (!isJsonObject(payload)) {
    throw new Error(
      `Backend Services token response from ${tokenEndpoint} is not a JSON object`,
    );
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(
      `Backend Services token response from ${tokenEndpoint} carries no "access_token"`,
    );
  }
  const tokenType = payload.token_type;
  if (typeof tokenType !== "string" || tokenType.length === 0) {
    throw new Error(
      `Backend Services token response from ${tokenEndpoint} carries no "token_type"`,
    );
  }
  const expiresIn = payload.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new TypeError(
      `Backend Services token response from ${tokenEndpoint} carries no "expires_in"`,
    );
  }

  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: expiresIn,
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
}

/**
 * Derive the public JWKS served at `/.well-known/jwks.json` from the configured private keys.
 *
 * Every private member ({@link PRIVATE_JWK_MEMBERS}) is dropped, so what is published is the
 * verification key and nothing else. Keys are deduplicated by `kid`, because several issuers
 * may legitimately be registered against the same backend key.
 * @param registrations the loaded issuer registry
 * @returns the JWKS document
 * @example
 * fastify.get("/.well-known/jwks.json", () => publicJwks(config.issuers));
 */
export function publicJwks(registrations: readonly IssuerRegistration[]): {
  keys: JWK[];
} {
  const keys: JWK[] = [];
  const published = new Set<string>();

  for (const registration of registrations) {
    const jwk = registration.backendClient.privateKeyJwk;
    const kid = jwk.kid;
    if (kid === undefined || published.has(kid)) {
      continue;
    }
    published.add(kid);
    const publicMembers = Object.fromEntries(
      Object.entries(jwk).filter(
        ([member]) => !PRIVATE_JWK_MEMBERS.has(member),
      ),
    );
    keys.push({
      ...publicMembers,
      alg: typeof jwk.alg === "string" ? jwk.alg : "RS384",
      use: typeof jwk.use === "string" ? jwk.use : "sig",
    });
  }

  return { keys };
}
