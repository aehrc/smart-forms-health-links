/**
 * Tests for `server/api/fhirProxy.ts`: the only way the SPA reaches the launched server.
 *
 * The proxy is what makes FR-004 and FR-005 hold together - every requester read and write uses
 * the session's authority, and that authority never reaches the browser. So the tests assert
 * both directions of the header handling: the `Authorization` header the browser sent is
 * discarded, and the one the upstream sees is the session's bearer token.
 *
 * The rest is faithfulness (path, query, body, status, content type travel unchanged) and the
 * expiry story (refresh where possible, `session-expired` with the row deleted where not).
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ISSUER,
  LAUNCH_CLIENT_ID,
  LAUNCH_CLIENT_SECRET,
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

/** The session's current access token. */
const ACCESS_TOKEN = "proxy-access-token-must-not-leak";

/** The session's refresh token. */
const REFRESH_TOKEN = "proxy-refresh-token-must-not-leak";

/** The access token a successful refresh returns. */
const REFRESHED_ACCESS_TOKEN = "refreshed-access-token-must-not-leak";

/** Id of the session row the tests drive the proxy with. */
const SESSION_ID = "proxy-session-id";

/** A Bundle the stub upstream answers reads with. */
const SEARCH_BUNDLE = {
  resourceType: "Bundle",
  type: "searchset",
  total: 1,
  entry: [{ resource: { resourceType: "Questionnaire", id: "q-715" } }],
};

describe("the FHIR proxy", () => {
  let harness: TestHarness;
  let fetchMock: Mock<typeof fetch>;
  /** What the stub upstream answers a FHIR request with. */
  let upstream: () => Response;
  /** What the stub token endpoint answers a refresh with. */
  let refresh: () => Response;

  beforeEach(() => {
    harness = createHarness();
    upstream = () =>
      Response.json(SEARCH_BUNDLE, {
        status: 200,
        headers: { "content-type": "application/fhir+json; charset=utf-8" },
      });
    refresh = () =>
      jsonResponse({
        access_token: REFRESHED_ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      });
    fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      if (url === `${ISSUER}/.well-known/smart-configuration`) {
        return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
      }
      if (url === TOKEN_ENDPOINT) {
        return Promise.resolve(refresh());
      }
      if (url.startsWith(ISSUER)) {
        return Promise.resolve(upstream());
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
   * Insert the active session the proxy runs on.
   * @param options the expiry and refresh token to give it
   * @param options.expiresIn seconds until the access token expires; negative for an expired one
   * @param options.refreshToken the refresh token to store, or null for none
   */
  function insertSession(
    options: { expiresIn?: number; refreshToken?: string | null } = {},
  ): void {
    const now = Math.floor(Date.now() / 1000);
    harness.db
      .prepare(
        `INSERT INTO sessions (id, status, issuer, accessToken, accessTokenExpiresAt,
                               refreshToken, patientId, userDisplay, createdAt)
         VALUES (?, 'active', ?, ?, ?, ?, 'pt-1', 'Dr Jane Smith', ?)`,
      )
      .run(
        SESSION_ID,
        ISSUER,
        ACCESS_TOKEN,
        now + (options.expiresIn ?? 3600),
        options.refreshToken === undefined
          ? REFRESH_TOKEN
          : options.refreshToken,
        now,
      );
  }

  /**
   * Find the calls the proxy made to the FHIR server, ignoring discovery and token traffic.
   * @returns the matching call arguments
   */
  function fhirCalls(): Parameters<typeof fetch>[] {
    return fetchMock.mock.calls.filter(([input]) => {
      const url = urlOf(input);
      return (
        url.startsWith(ISSUER) &&
        !url.includes("/.well-known/") &&
        url !== TOKEN_ENDPOINT
      );
    });
  }

  describe("forwarding", () => {
    it("appends the path suffix, preserves the query and attaches the session's bearer token", async () => {
      insertSession();

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire?_count=1&status=active",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(fhirCalls()).toHaveLength(1);
      const [input, init] = fhirCalls()[0];
      expect(urlOf(input)).toBe(
        `${ISSUER}/Questionnaire?_count=1&status=active`,
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
    });

    it("discards an Authorization header the browser supplied", async () => {
      insertSession();

      await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Patient",
        cookies: { shl_session: SESSION_ID },
        headers: { authorization: "Bearer attacker-supplied-token" },
      });

      const headers = new Headers(fhirCalls()[0][1]?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    });

    it("does not forward the session cookie upstream", async () => {
      insertSession();

      await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Patient",
        cookies: { shl_session: SESSION_ID },
      });

      const headers = new Headers(fhirCalls()[0][1]?.headers);
      expect(headers.has("cookie")).toBe(false);
    });

    it("passes the upstream status, body and content type back verbatim", async () => {
      insertSession();

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/fhir+json; charset=utf-8",
      );
      expect(response.json()).toEqual(SEARCH_BUNDLE);
    });

    it("passes an upstream error status and body through without rewriting them", async () => {
      insertSession();
      upstream = () =>
        Response.json(
          { resourceType: "OperationOutcome", issue: [{ severity: "error" }] },
          {
            status: 422,
            headers: { "content-type": "application/fhir+json" },
          },
        );

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json<{ resourceType: string }>().resourceType).toBe(
        "OperationOutcome",
      );
    });

    it("forwards a POST body and its content type, and returns the upstream Location", async () => {
      insertSession();
      upstream = () =>
        Response.json(
          { resourceType: "Task", id: "task-1" },
          {
            status: 201,
            headers: {
              "content-type": "application/fhir+json",
              location: `${ISSUER}/Task/task-1/_history/1`,
            },
          },
        );
      const payload = '{"resourceType":"Task","status":"requested"}';

      const response = await harness.server.inject({
        method: "POST",
        url: "/api/fhir/Task",
        cookies: { shl_session: SESSION_ID },
        headers: { "content-type": "application/fhir+json" },
        payload,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(
        `${ISSUER}/Task/task-1/_history/1`,
      );
      const [input, init] = fhirCalls()[0];
      expect(urlOf(input)).toBe(`${ISSUER}/Task`);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/fhir+json",
      );
      expect(Buffer.from(init?.body as Uint8Array).toString("utf8")).toBe(
        payload,
      );
    });

    it("forwards a nested path such as a resource instance read", async () => {
      insertSession();

      await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Task/task-1/_history",
        cookies: { shl_session: SESSION_ID },
      });

      expect(urlOf(fhirCalls()[0][0])).toBe(`${ISSUER}/Task/task-1/_history`);
    });

    it("makes no discovery or token request on the happy path", async () => {
      insertSession();

      await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("without a session", () => {
    it("answers no-session when there is no cookie", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("answers no-session when the cookie names nothing", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: "not-a-session" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("expiry and refresh", () => {
    it("refreshes an expired token before forwarding, and stores the new one", async () => {
      insertSession({ expiresIn: -60 });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(200);
      const [, init] = fhirCalls()[0];
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${REFRESHED_ACCESS_TOKEN}`,
      );
      expect(findActiveSession(harness.db, SESSION_ID)?.accessToken).toBe(
        REFRESHED_ACCESS_TOKEN,
      );
    });

    it("authenticates the refresh as the confidential client", async () => {
      insertSession({ expiresIn: -60 });

      await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      const call = fetchMock.mock.calls.find(
        ([input]) => urlOf(input) === TOKEN_ENDPOINT,
      );
      expect(call).toBeDefined();
      const expected = Buffer.from(
        `${LAUNCH_CLIENT_ID}:${LAUNCH_CLIENT_SECRET}`,
        "utf8",
      ).toString("base64");
      expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
        `Basic ${expected}`,
      );
      const posted = call?.[1]?.body;
      const body =
        posted instanceof URLSearchParams ? posted : new URLSearchParams();
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
    });

    it("answers session-expired and deletes the row when the refresh is refused", async () => {
      insertSession({ expiresIn: -60 });
      refresh = () => jsonResponse({ error: "invalid_grant" }, 400);

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "session-expired" });
      expect(sessionCount(harness.db)).toBe(0);
      expect(fhirCalls()).toHaveLength(0);
    });

    it("answers session-expired and deletes the row when there is nothing to refresh with", async () => {
      insertSession({ expiresIn: -60, refreshToken: null });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "session-expired" });
      expect(sessionCount(harness.db)).toBe(0);
      expect(fhirCalls()).toHaveLength(0);
    });

    it("retries once through a refresh when the upstream answers 401", async () => {
      insertSession();
      let attempts = 0;
      upstream = () => {
        attempts += 1;
        return attempts === 1
          ? new Response("", { status: 401 })
          : Response.json(SEARCH_BUNDLE, {
              status: 200,
              headers: { "content-type": "application/fhir+json" },
            });
      };

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(fhirCalls()).toHaveLength(2);
      expect(new Headers(fhirCalls()[1][1]?.headers).get("authorization")).toBe(
        `Bearer ${REFRESHED_ACCESS_TOKEN}`,
      );
    });

    it("answers session-expired and deletes the row when the upstream still refuses after a refresh", async () => {
      insertSession();
      upstream = () => new Response("", { status: 401 });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "session-expired" });
      expect(sessionCount(harness.db)).toBe(0);
    });

    it("answers session-expired for an upstream 401 with no refresh token available", async () => {
      insertSession({ refreshToken: null });
      upstream = () => new Response("", { status: 401 });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "session-expired" });
      expect(sessionCount(harness.db)).toBe(0);
      expect(fhirCalls()).toHaveLength(1);
    });

    it("never puts a token in a log line", async () => {
      insertSession({ expiresIn: -60 });

      await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Questionnaire",
        cookies: { shl_session: SESSION_ID },
      });

      const log = harness.logLines.join("\n");
      for (const secret of [
        ACCESS_TOKEN,
        REFRESH_TOKEN,
        REFRESHED_ACCESS_TOKEN,
        LAUNCH_CLIENT_SECRET,
      ]) {
        expect(log).not.toContain(secret);
      }
    });
  });

  describe("path safety", () => {
    // A suffix whose traversal is spelled out, or spelled out once decoded, never reaches the
    // route: Fastify's router refuses the path outright. The property being asserted is that
    // nothing is proxied, whichever layer says no.
    it.each(["/api/fhir/../../admin", "/api/fhir/%2e%2e/%2e%2e/admin"])(
      "refuses %s without contacting the issuer",
      async (url) => {
        insertSession();

        const response = await harness.server.inject({
          method: "GET",
          url,
          cookies: { shl_session: SESSION_ID },
        });

        expect(response.statusCode).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    // These three do reach the route, so they exercise the proxy's own guard.
    it("refuses a suffix whose separators are encoded to hide a traversal", async () => {
      insertSession();

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/Task/..%2F..%2Fadmin",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid-path" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an absolute URL as the suffix", async () => {
      insertSession();

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/https://evil.example.org/steal",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid-path" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a protocol-relative suffix", async () => {
      insertSession();

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir//evil.example.org/steal",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid-path" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a request whose path lost the route prefix", async () => {
      insertSession();

      // The wildcard route matches `/api/fhir/` with an empty suffix; there is no FHIR
      // interaction at the base itself, so it is refused rather than proxied.
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/fhir/",
        cookies: { shl_session: SESSION_ID },
      });

      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
