/**
 * Tests for `server/smart/backendServices.ts`.
 *
 * This module holds the only credential capable of writing to a clinic's FHIR server without a
 * human in the loop, so the tests assert three separate things: that the client assertion is a
 * genuine RS384 JWT with the claim set SMART Backend Services requires, that the token request
 * is shaped exactly as the specification says, and that nothing which could be replayed - a
 * token, an assertion, or key material - can escape through an error message (FR-018).
 * @author John Grimes
 */

import {
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  CLIENT_ASSERTION_TYPE,
  mintAccessToken,
  publicJwks,
} from "../../server/smart/backendServices";

import type { IssuerRegistration } from "../../server/config";
import type { JWK, KeyObject } from "jose";
import type { Mock } from "vitest";

const TOKEN_ENDPOINT = "https://ehr.example.org/auth/token";

const BACKEND_SCOPES =
  "system/QuestionnaireResponse.c system/Task.r system/Task.u";

let privateJwk: JWK;
let publicKey: CryptoKey | KeyObject;

/**
 * Build a registration around the generated key pair.
 * @param overrides fields to replace on the backend client
 * @returns a registration usable by the module under test
 */
function registration(
  overrides: Partial<IssuerRegistration["backendClient"]> = {},
): IssuerRegistration {
  return {
    issuer: "https://ehr.example.org/fhir",
    label: "Example EHR",
    launchClient: {
      clientId: "launch-client",
      clientSecret: "launch-secret-never-logged",
      scopes: "openid fhirUser launch",
    },
    backendClient: {
      clientId: "backend-client",
      privateKeyJwk: privateJwk,
      scopes: BACKEND_SCOPES,
      ...overrides,
    },
    grantTtlSeconds: 3600,
  };
}

/**
 * Build a JSON `Response`.
 * @param body the document to serialise
 * @param status the HTTP status, defaulting to 200
 * @returns the response
 */
function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Read the form parameters from the most recent request.
 * @param fetchMock the stubbed fetch
 * @param callIndex which call to inspect, defaulting to the first
 * @returns the decoded form body
 */
function requestBody(
  fetchMock: Mock<typeof fetch>,
  callIndex = 0,
): URLSearchParams {
  const body = fetchMock.mock.calls[callIndex][1]?.body;
  // The module posts a URLSearchParams, which is what makes the request form-encoded.
  if (!(body instanceof URLSearchParams)) {
    throw new TypeError("expected a form-encoded request body");
  }
  return body;
}

describe("SMART Backend Services", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS384", { extractable: true });
    publicKey = pair.publicKey;
    privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: "backend-key-1",
    };
  });

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("mintAccessToken", () => {
    const TOKEN_RESPONSE = {
      access_token: "minted-token-value",
      token_type: "Bearer",
      expires_in: 3600,
      scope: BACKEND_SCOPES,
    };

    it("posts a client_credentials request with exactly the specified parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse(TOKEN_RESPONSE));

      await mintAccessToken({
        registration: registration(),
        tokenEndpoint: TOKEN_ENDPOINT,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(TOKEN_ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );

      const body = requestBody(fetchMock);
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_assertion_type")).toBe(
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      expect(CLIENT_ASSERTION_TYPE).toBe(
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      expect(body.get("scope")).toBe(BACKEND_SCOPES);
      expect(body.get("client_assertion")).toBeTruthy();
      expect([...body.keys()].toSorted()).toEqual([
        "client_assertion",
        "client_assertion_type",
        "grant_type",
        "scope",
      ]);
    });

    it("signs an RS384 assertion whose header names the key", async () => {
      fetchMock.mockResolvedValue(jsonResponse(TOKEN_RESPONSE));

      await mintAccessToken({
        registration: registration(),
        tokenEndpoint: TOKEN_ENDPOINT,
      });

      const header = decodeProtectedHeader(
        requestBody(fetchMock).get("client_assertion") ?? "",
      );
      expect(header.alg).toBe("RS384");
      expect(header.kid).toBe("backend-key-1");
      expect(header.typ).toBe("JWT");
    });

    it("makes the assertion claim set the one Backend Services requires", async () => {
      fetchMock.mockResolvedValue(jsonResponse(TOKEN_RESPONSE));
      const before = Math.floor(Date.now() / 1000);

      await mintAccessToken({
        registration: registration(),
        tokenEndpoint: TOKEN_ENDPOINT,
      });

      const { payload } = await jwtVerify(
        requestBody(fetchMock).get("client_assertion") ?? "",
        publicKey,
        { audience: TOKEN_ENDPOINT },
      );
      // iss and sub are both the client id; aud is the token endpoint.
      expect(payload.iss).toBe("backend-client");
      expect(payload.sub).toBe("backend-client");
      expect(payload.aud).toBe(TOKEN_ENDPOINT);
      expect(typeof payload.jti).toBe("string");
      // Short lived: no more than the five minutes the specification permits.
      expect(payload.exp).toBeDefined();
      expect(payload.exp).toBeGreaterThan(before);
      expect(payload.exp).toBeLessThanOrEqual(before + 300);
    });

    it("uses a fresh jti for every call, so an assertion cannot be replayed", async () => {
      // A fresh Response per call: a body can only be read once.
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse(TOKEN_RESPONSE)),
      );

      await mintAccessToken({
        registration: registration(),
        tokenEndpoint: TOKEN_ENDPOINT,
      });
      await mintAccessToken({
        registration: registration(),
        tokenEndpoint: TOKEN_ENDPOINT,
      });

      const first = await jwtVerify(
        requestBody(fetchMock, 0).get("client_assertion") ?? "",
        publicKey,
      );
      const second = await jwtVerify(
        requestBody(fetchMock, 1).get("client_assertion") ?? "",
        publicKey,
      );
      expect(first.payload.jti).not.toBe(second.payload.jti);
      // The assertions themselves therefore differ, even within the same second.
      expect(requestBody(fetchMock, 0).get("client_assertion")).not.toBe(
        requestBody(fetchMock, 1).get("client_assertion"),
      );
    });

    it("returns the token response as the authorisation server gave it", async () => {
      fetchMock.mockResolvedValue(jsonResponse(TOKEN_RESPONSE));

      const token = await mintAccessToken({
        registration: registration(),
        tokenEndpoint: TOKEN_ENDPOINT,
      });

      expect(token.access_token).toBe("minted-token-value");
      expect(token.token_type).toBe("Bearer");
      expect(token.expires_in).toBe(3600);
      expect(token.scope).toBe(BACKEND_SCOPES);
    });

    it("reports a refusal with its status and error code, and nothing else", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            error: "invalid_client",
            error_description: "assertion rejected: leaky-description-detail",
          },
          400,
        ),
      );

      let message = "";
      try {
        await mintAccessToken({
          registration: registration(),
          tokenEndpoint: TOKEN_ENDPOINT,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("400");
      expect(message).toContain("invalid_client");
      expect(message).toContain(TOKEN_ENDPOINT);
      // Nothing replayable, and nothing the server volunteered beyond the code.
      expect(message).not.toContain("leaky-description-detail");
      expect(message).not.toContain(
        requestBody(fetchMock).get("client_assertion"),
      );
      expect(message).not.toContain(privateJwk.d);
      expect(message).not.toContain("minted-token-value");
    });

    it("reports a refusal that carries no JSON body without inventing one", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response("upstream exploded", {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
        ),
      );

      await expect(
        mintAccessToken({
          registration: registration(),
          tokenEndpoint: TOKEN_ENDPOINT,
        }),
      ).rejects.toThrow(/503/);
      await expect(
        mintAccessToken({
          registration: registration(),
          tokenEndpoint: TOKEN_ENDPOINT,
        }),
      ).rejects.not.toThrow(/upstream exploded/);
    });

    it("rejects a success response with no usable access token", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ token_type: "Bearer", expires_in: 3600 }),
      );

      await expect(
        mintAccessToken({
          registration: registration(),
          tokenEndpoint: TOKEN_ENDPOINT,
        }),
      ).rejects.toThrow(/access_token/);
    });

    it("rejects a success response with no stated lifetime", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          access_token: "minted-token-value",
          token_type: "Bearer",
        }),
      );

      await expect(
        mintAccessToken({
          registration: registration(),
          tokenEndpoint: TOKEN_ENDPOINT,
        }),
      ).rejects.toThrow(/expires_in/);
    });

    it("names the endpoint but no key material when the token endpoint is unreachable", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      let message = "";
      try {
        await mintAccessToken({
          registration: registration(),
          tokenEndpoint: TOKEN_ENDPOINT,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain(TOKEN_ENDPOINT);
      expect(message).toContain("ECONNREFUSED");
      expect(message).not.toContain(privateJwk.d);
    });
  });

  describe("publicJwks", () => {
    it("publishes the public half of each configured key and nothing more", () => {
      const jwks = publicJwks([registration()]);

      expect(jwks.keys).toHaveLength(1);
      const [key] = jwks.keys;
      expect(key.kid).toBe("backend-key-1");
      expect(key.kty).toBe("RSA");
      expect(key.n).toBe(privateJwk.n);
      expect(key.e).toBe("AQAB");
      expect(key.alg).toBe("RS384");
      expect(key.use).toBe("sig");

      for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
        expect(Object.hasOwn(key, member)).toBe(false);
      }
      expect(JSON.stringify(jwks)).not.toContain(privateJwk.d);
    });

    it("publishes one entry per distinct key, not per issuer", () => {
      const shared = publicJwks([
        registration(),
        { ...registration(), issuer: "https://other.example.org/fhir" },
      ]);
      expect(shared.keys).toHaveLength(1);

      const distinct = publicJwks([
        registration(),
        {
          ...registration({
            privateKeyJwk: { ...privateJwk, kid: "backend-key-2" },
          }),
          issuer: "https://other.example.org/fhir",
        },
      ]);
      expect(distinct.keys.map((key) => key.kid)).toEqual([
        "backend-key-1",
        "backend-key-2",
      ]);
    });

    it("returns an empty key set when nothing is registered", () => {
      expect(publicJwks([])).toEqual({ keys: [] });
    });
  });
});
