/**
 * Tests for `GET /auth/callback` in `server/smart/launch.ts`.
 *
 * The callback is where the confidential client actually behaves like one: the code is
 * exchanged server to server with HTTP Basic credentials, and the only thing the browser is
 * given back is an opaque cookie (FR-005). The tests therefore assert the exact `Authorization`
 * header value - including the RFC 6749 section 2.3.1 form-urlencoding of a client id and
 * secret that contain reserved characters - and assert that the code, the secret and the access
 * token appear in neither the response body nor the log.
 *
 * The failure paths matter as much: an unknown, replayed or expired `state` must not complete,
 * and a refused exchange must leave the database exactly as it was, with a page that tells the
 * user what to do next rather than a stack trace.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AWKWARD_CLIENT_ID,
  AWKWARD_CLIENT_SECRET,
  AWKWARD_ISSUER,
  AWKWARD_SMART_CONFIGURATION,
  AWKWARD_TOKEN_ENDPOINT,
  ISSUER,
  LAUNCH_CLIENT_ID,
  LAUNCH_CLIENT_SECRET,
  REDIRECT_URI,
  SMART_CONFIGURATION,
  TOKEN_ENDPOINT,
  closeHarness,
  createHarness,
  jsonResponse,
  sessionCount,
  urlOf,
} from "./support/testHarness";
import { findActiveSession } from "../../server/sessions";

import type { TestHarness } from "./support/testHarness";
import type { Mock } from "vitest";

/** The `state` the pending session under test was opened with. */
const STATE = "state-value-for-the-callback";

/** The PKCE verifier the pending session kept. */
const VERIFIER = "verifier-0123456789012345678901234567890123456789";

/** The authorization code the callback carries. Must never be echoed or logged. */
const CODE = "authorization-code-must-not-leak";

/** The access token the exchange returns. Must never be echoed or logged. */
const ACCESS_TOKEN = "launch-access-token-must-not-leak";

/** The refresh token the exchange returns. Must never be echoed or logged. */
const REFRESH_TOKEN = "launch-refresh-token-must-not-leak";

/**
 * The `fhirUser` reference the ID token carries, in the absolute form Aidbox uses: the server's
 * own origin rather than its FHIR base.
 */
const FHIR_USER_CLAIM = "https://ehr.example.org/Practitioner/prac-1";

/**
 * Where the BFF must look that reference up: the registered FHIR base, not the origin the
 * claim named. Proven necessary against the target instance 2026-08-22, where the claim's own
 * URL is outside the launch client's access policy and answers 403.
 */
const FHIR_USER_URL = `${ISSUER}/Practitioner/prac-1`;

/** An active row as the tests read it back. */
interface StoredActive {
  id: string;
  status: string;
  issuer: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string | null;
  patientId: string | null;
  userDisplay: string | null;
}

/**
 * Build an unsigned-looking ID token carrying the given claims.
 *
 * The route decodes ID token claims without verifying the signature, so a real signature is
 * beside the point; the shape is what matters.
 * @param claims the payload claims
 * @returns a three-part compact JWS with a fake signature
 */
function idToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${header}.${payload}.not-a-real-signature`;
}

/**
 * A complete, well-formed token response.
 * @param overrides fields to add or replace
 * @returns the response body
 */
function tokenResponseBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: REFRESH_TOKEN,
    scope: "openid fhirUser launch/patient user/*.cruds",
    patient: "pt-1",
    id_token: idToken({
      sub: "practitioner-1",
      name: "Dr Jane Smith",
      fhirUser: FHIR_USER_CLAIM,
    }),
    ...overrides,
  };
}

/**
 * A `Practitioner` as the issuer's FHIR API would return it.
 * @param overrides fields to add or replace
 * @returns the resource body
 */
function practitionerResource(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    resourceType: "Practitioner",
    id: "prac-1",
    name: [
      {
        text: "Dr Alex Fielding",
        family: "Fielding",
        given: ["Alex"],
        prefix: ["Dr"],
      },
    ],
    ...overrides,
  };
}

/**
 * Read the form body a `fetch` call posted.
 * @param init the second argument `fetch` was called with
 * @returns the body as parsed parameters
 */
function formBody(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) {
    return body;
  }
  return new URLSearchParams(typeof body === "string" ? body : "");
}

describe("GET /auth/callback", () => {
  let harness: TestHarness;
  let fetchMock: Mock<typeof fetch>;
  let tokenResponse: Record<string, unknown>;
  let tokenStatus: number;
  let fhirUserResponse: Record<string, unknown>;
  let fhirUserStatus: number;

  beforeEach(() => {
    harness = createHarness();
    tokenResponse = tokenResponseBody();
    tokenStatus = 200;
    fhirUserResponse = practitionerResource();
    fhirUserStatus = 200;
    fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      if (url === `${ISSUER}/.well-known/smart-configuration`) {
        return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
      }
      if (url === `${AWKWARD_ISSUER}/.well-known/smart-configuration`) {
        return Promise.resolve(jsonResponse(AWKWARD_SMART_CONFIGURATION));
      }
      if (url === TOKEN_ENDPOINT || url === AWKWARD_TOKEN_ENDPOINT) {
        return Promise.resolve(jsonResponse(tokenResponse, tokenStatus));
      }
      if (url === FHIR_USER_URL) {
        return Promise.resolve(jsonResponse(fhirUserResponse, fhirUserStatus));
      }
      throw new Error(`unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeHarness(harness);
  });

  /**
   * Open a pending session the way `/launch` would have.
   * @param issuer the issuer to open it against
   * @param createdAt when the pending session was opened, in epoch seconds
   * @returns the id of the pending row
   */
  function openPending(issuer = ISSUER, createdAt?: number): string {
    const now = createdAt ?? Math.floor(Date.now() / 1000);
    const id = "pending-session-id";
    harness.db
      .prepare(
        `INSERT INTO sessions (id, status, issuer, state, verifier, createdAt)
         VALUES (?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, issuer, STATE, VERIFIER, now);
    return id;
  }

  /**
   * Read every row in the sessions table.
   * @returns the rows
   */
  function storedSessions(): StoredActive[] {
    return harness.db.prepare<[], StoredActive>("SELECT * FROM sessions").all();
  }

  /**
   * Find the call that went to a token endpoint.
   * @returns the arguments of that call
   */
  function tokenRequest(): Parameters<typeof fetch> {
    const call = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).endsWith("/auth/token"),
    );
    expect(call).toBeDefined();
    return call as Parameters<typeof fetch>;
  }

  describe("a successful exchange", () => {
    it("redirects to the app root", async () => {
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/");
    });

    it("sets an HttpOnly, Secure, SameSite=Lax session cookie for the whole origin", async () => {
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const setCookie = response.headers["set-cookie"] as string;
      expect(setCookie).toContain("shl_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      // The cookie value is the session id, and the id is not the access token.
      expect(setCookie).not.toContain(ACCESS_TOKEN);
      expect(setCookie).not.toContain(REFRESH_TOKEN);
    });

    it("promotes the pending row to active, keeping the tokens server-side", async () => {
      const id = openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const rows = storedSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].status).toBe("active");
      expect(rows[0].issuer).toBe(ISSUER);
      expect(rows[0].accessToken).toBe(ACCESS_TOKEN);
      expect(rows[0].refreshToken).toBe(REFRESH_TOKEN);
      // Derived from expires_in, so it must be roughly an hour away.
      const now = Math.floor(Date.now() / 1000);
      expect(rows[0].accessTokenExpiresAt).toBeGreaterThan(now + 3500);
      expect(rows[0].accessTokenExpiresAt).toBeLessThanOrEqual(now + 3600);
    });

    // FR-009. The display is what `Task.requester.display` will carry, so a human name is
    // worth one extra request: the `fhirUser` the launch discloses is resolved against the
    // registered FHIR base and its `name` is preferred over any claim.
    it("captures the launch context patient and the fhirUser's human name", async () => {
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const rows = storedSessions();
      expect(rows[0].patientId).toBe("pt-1");
      expect(rows[0].userDisplay).toBe("Dr Alex Fielding");
    });

    // The claim names the authorisation server's own origin, which on the target instance is
    // outside the launch client's access policy. The reference is therefore reduced to
    // `ResourceType/id` and resolved against the issuer we already trust, with the launch's
    // own access token - never fetched as the absolute URL the claim supplied.
    it("resolves the fhirUser against the registered FHIR base with the launch token", async () => {
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const call = fetchMock.mock.calls.find(([input]) =>
        urlOf(input).endsWith("/Practitioner/prac-1"),
      );
      expect(call).toBeDefined();
      expect(urlOf((call as Parameters<typeof fetch>)[0])).toBe(FHIR_USER_URL);
      const init = (call as Parameters<typeof fetch>)[1];
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      // The claim's own absolute URL is never requested.
      expect(
        fetchMock.mock.calls.some(
          ([input]) => urlOf(input) === FHIR_USER_CLAIM,
        ),
      ).toBe(false);
    });

    // `name.text` is the server's own rendering of the name and is preferred, but plenty of
    // servers only populate the parts.
    it("composes given and family names when the resource carries no name text", async () => {
      fhirUserResponse = practitionerResource({
        name: [{ family: "Fielding", given: ["Alex", "Jo"] }],
      });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(storedSessions()[0].userDisplay).toBe("Alex Jo Fielding");
    });

    // SMART App Launch names `profile` as the deprecated synonym of `fhirUser`, so a server
    // that only sends the older claim still gets a resolved name.
    it("accepts the deprecated profile claim as the fhirUser reference", async () => {
      tokenResponse = tokenResponseBody({
        id_token: idToken({ sub: "practitioner-1", profile: FHIR_USER_CLAIM }),
      });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(storedSessions()[0].userDisplay).toBe("Dr Alex Fielding");
    });

    it("falls back to the ID token name claim when the fhirUser cannot be read", async () => {
      fhirUserStatus = 403;
      fhirUserResponse = { resourceType: "OperationOutcome" };
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      // The launch still completes: a missing display is a degraded session, not a failed one.
      expect(response.statusCode).toBe(302);
      const rows = storedSessions();
      expect(rows[0].status).toBe("active");
      expect(rows[0].userDisplay).toBe("Dr Jane Smith");
    });

    it("completes the launch when the fhirUser request itself fails", async () => {
      fetchMock.mockImplementation((input) => {
        const url = urlOf(input);
        if (url === `${ISSUER}/.well-known/smart-configuration`) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        if (url === TOKEN_ENDPOINT) {
          return Promise.resolve(jsonResponse(tokenResponse, tokenStatus));
        }
        return Promise.reject(new Error("connect ECONNREFUSED"));
      });
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/");
      const rows = storedSessions();
      expect(rows[0].status).toBe("active");
      expect(rows[0].userDisplay).toBe("Dr Jane Smith");
      // Nothing about the failed lookup may carry the token that was used for it.
      expect(harness.logLines.join("\n")).not.toContain(ACCESS_TOKEN);
    });

    it("falls back to the ID token name when the resource has no name at all", async () => {
      fhirUserResponse = practitionerResource({ name: undefined });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(storedSessions()[0].userDisplay).toBe("Dr Jane Smith");
    });

    it("uses preferred_username when there is no name and no fhirUser", async () => {
      tokenResponse = tokenResponseBody({
        id_token: idToken({
          sub: "practitioner-1",
          preferred_username: "a.fielding",
        }),
      });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(storedSessions()[0].userDisplay).toBe("a.fielding");
      // With nothing to resolve, no lookup is attempted.
      expect(
        fetchMock.mock.calls.some(([input]) =>
          urlOf(input).includes("/Practitioner/"),
        ),
      ).toBe(false);
    });

    // A reference that is not `ResourceType/id` shaped is not a FHIR reference, and following
    // it would let an issuer point the BFF at a URL of its choosing.
    it("ignores a fhirUser reference that does not name a resource", async () => {
      tokenResponse = tokenResponseBody({
        id_token: idToken({
          sub: "practitioner-1",
          fhirUser: "https://attacker.example/internal/metadata",
        }),
      });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(storedSessions()[0].userDisplay).toBeNull();
      expect(
        fetchMock.mock.calls.some(([input]) =>
          urlOf(input).startsWith("https://attacker.example"),
        ),
      ).toBe(false);
    });

    it("stores no patient and no display when the launch carried neither", async () => {
      tokenResponse = {
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      };
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const rows = storedSessions();
      expect(rows[0].patientId).toBeNull();
      expect(rows[0].userDisplay).toBeNull();
      expect(rows[0].refreshToken).toBeNull();
    });

    // A standalone launch omits `launch/patient`, because there is no EHR context to be
    // granted - the requester picks the patient in the app. Aidbox nonetheless reports a
    // `patient` in that case, set to the id of the signed-in user's own `fhirUser`
    // (measured 2026-08-22: a standalone launch as `e2e-demo` reports
    // `"patient": "prac-demo"`, which is a Practitioner). Storing that would put a
    // practitioner in `Task.for`, so the context is only taken when the scope that asks for
    // it was actually granted.
    it("ignores a reported patient when launch/patient was not granted", async () => {
      tokenResponse = tokenResponseBody({
        scope: "openid fhirUser launch online_access user/*.cruds",
        patient: "prac-1",
      });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const rows = storedSessions();
      expect(rows[0].patientId).toBeNull();
      // The rest of the launch is unaffected.
      expect(rows[0].status).toBe("active");
      expect(rows[0].userDisplay).toBe("Dr Alex Fielding");
    });

    // SMART App Launch requires `scope` in the access token response, so a response without
    // one has not stated that patient context was granted.
    it("ignores a reported patient when the response states no scope", async () => {
      tokenResponse = tokenResponseBody({ scope: undefined, patient: "pt-1" });
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(storedSessions()[0].patientId).toBeNull();
    });

    it("authenticates with client_secret_basic and keeps the secret out of the body", async () => {
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const [, init] = tokenRequest();
      const expected = Buffer.from(
        `${LAUNCH_CLIENT_ID}:${LAUNCH_CLIENT_SECRET}`,
        "utf8",
      ).toString("base64");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${expected}`,
      );
      expect(formBody(init).has("client_secret")).toBe(false);
    });

    it("form-urlencodes reserved characters in the credentials before Basic-encoding them", async () => {
      openPending(AWKWARD_ISSUER);

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      const [, init] = tokenRequest();
      // RFC 6749 section 2.3.1: the client id and secret are
      // application/x-www-form-urlencoded-encoded, then Basic-encoded.
      const expected = Buffer.from(
        "launch+client:sec%3Aret+pass%26word",
        "utf8",
      ).toString("base64");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${expected}`,
      );
      // Sanity check that the fixture really does contain the awkward characters.
      expect(AWKWARD_CLIENT_ID).toContain(" ");
      expect(AWKWARD_CLIENT_SECRET).toContain(":");
    });

    it("posts the authorization code grant with the PKCE verifier and redirect URI", async () => {
      openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}`,
      });

      const [input, init] = tokenRequest();
      expect(urlOf(input)).toBe(TOKEN_ENDPOINT);
      expect(init?.method).toBe("POST");
      const body = formBody(init);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe(CODE);
      expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(body.get("code_verifier")).toBe(VERIFIER);
    });

    it("discloses neither the code, the secret nor the tokens in the response or the log", async () => {
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}`,
      });

      const log = harness.logLines.join("\n");
      for (const secret of [
        CODE,
        ACCESS_TOKEN,
        REFRESH_TOKEN,
        LAUNCH_CLIENT_SECRET,
        VERIFIER,
      ]) {
        expect(response.body).not.toContain(secret);
        expect(response.headers["set-cookie"] as string).not.toContain(secret);
        expect(log).not.toContain(secret);
      }
    });
  });

  describe("state validation", () => {
    it("refuses an unknown state without contacting the token endpoint", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=who-knows`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a replayed state and leaves the session it already created alone", async () => {
      openPending();
      const first = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });
      expect(first.statusCode).toBe(302);

      const second = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(second.statusCode).toBeGreaterThanOrEqual(400);
      expect(second.headers["set-cookie"]).toBeUndefined();
      const rows = storedSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("active");
    });

    it("refuses an expired state and clears the abandoned pending row", async () => {
      openPending(ISSUER, Math.floor(Date.now() / 1000) - 700);

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a callback with no state at all", async () => {
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("failure", () => {
    it("renders a retry link, deletes the pending row and stores nothing when the exchange is refused", async () => {
      tokenStatus = 400;
      tokenResponse = { error: "invalid_grant" };
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain(`/launch?iss=`);
      expect(sessionCount(harness.db)).toBe(0);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain(CODE);
      expect(harness.logLines.join("\n")).not.toContain(CODE);
      expect(harness.logLines.join("\n")).not.toContain(LAUNCH_CLIENT_SECRET);
    });

    it("stores nothing when the token response carries no access token", async () => {
      tokenResponse = { token_type: "Bearer", expires_in: 3600 };
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(sessionCount(harness.db)).toBe(0);
    });

    it("stores nothing when the authorisation server reports an error instead of a code", async () => {
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?error=access_denied&state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stores nothing when the callback carries no code", async () => {
      openPending();

      const response = await harness.server.inject({
        method: "GET",
        url: `/auth/callback?state=${encodeURIComponent(STATE)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves no readable session behind after a failed exchange", async () => {
      tokenStatus = 502;
      tokenResponse = {};
      const id = openPending();

      await harness.server.inject({
        method: "GET",
        url: `/auth/callback?code=${CODE}&state=${encodeURIComponent(STATE)}`,
      });

      expect(findActiveSession(harness.db, id)).toBeUndefined();
    });
  });
});
