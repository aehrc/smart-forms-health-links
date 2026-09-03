/**
 * Tests for `GET /launch` in `server/smart/launch.ts`.
 *
 * The route has two jobs and both are security-relevant. The first is to build an authorize
 * redirect that the authorisation server will accept and that a code-injection attack cannot
 * survive: the PKCE challenge has to be the real SHA-256 of the verifier the pending session
 * kept, not merely a plausible-looking string, so that is asserted by recomputing it from the
 * stored row.
 *
 * The second is to refuse an unregistered issuer (FR-003, US1 acceptance scenario 3). A refusal
 * has to name the issuer so the user can tell their administrator what happened, escape it so
 * the name cannot become markup, store nothing, and send nothing anywhere - the last of those
 * is asserted by checking that `fetch` was never called, because the first outbound request a
 * launch makes is the well-known document of the server being launched from.
 * @author John Grimes
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTHORIZATION_ENDPOINT,
  ISSUER,
  LAUNCH_CLIENT_ID,
  LAUNCH_SCOPES,
  REDIRECT_URI,
  SMART_CONFIGURATION,
  closeHarness,
  createHarness,
  jsonResponse,
  sessionCount,
  urlOf,
} from "./support/testHarness";

import type { TestHarness } from "./support/testHarness";
import type { Mock } from "vitest";

/** The pending row shape the tests read back. */
interface StoredPending {
  id: string;
  state: string;
  verifier: string;
  issuer: string;
  status: string;
}

describe("GET /launch", () => {
  let harness: TestHarness;
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    harness = createHarness();
    fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.endsWith("/.well-known/smart-configuration")) {
        return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
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
   * Read the single pending session the database holds.
   * @returns the pending row
   */
  function onlyPendingSession(): StoredPending {
    const rows = harness.db
      .prepare<[], StoredPending>(
        "SELECT id, state, verifier, issuer, status FROM sessions",
      )
      .all();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  describe("EHR launch", () => {
    it("redirects to the issuer's authorization endpoint with the SMART parameters", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}&launch=launch-token-xyz`,
      });

      expect(response.statusCode).toBe(302);
      const location = new URL(response.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("client_id")).toBe(LAUNCH_CLIENT_ID);
      expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(location.searchParams.get("aud")).toBe(ISSUER);
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("launch")).toBe("launch-token-xyz");
    });

    it("asks for the registry's scopes unchanged, including launch/patient", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}&launch=launch-token-xyz`,
      });

      const location = new URL(response.headers.location as string);
      expect(location.searchParams.get("scope")).toBe(LAUNCH_SCOPES);
    });

    it("keeps the state it sent in a pending session against the launched issuer", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}&launch=launch-token-xyz`,
      });

      const location = new URL(response.headers.location as string);
      const pending = onlyPendingSession();
      expect(pending.status).toBe("pending");
      expect(pending.issuer).toBe(ISSUER);
      expect(pending.state).toBe(location.searchParams.get("state"));
      // 128 bits of base64url is 22 characters; anything much shorter is guessable.
      expect(pending.state.length).toBeGreaterThanOrEqual(22);
    });

    it("sends the genuine base64url SHA-256 of the verifier it stored", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}&launch=launch-token-xyz`,
      });

      const location = new URL(response.headers.location as string);
      const pending = onlyPendingSession();
      const expected = createHash("sha256")
        .update(pending.verifier, "ascii")
        .digest("base64url");
      expect(location.searchParams.get("code_challenge")).toBe(expected);
      // The verifier itself must never appear in the redirect.
      expect(response.headers.location).not.toContain(pending.verifier);
      // RFC 7636 requires between 43 and 128 characters.
      expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
      expect(pending.verifier.length).toBeLessThanOrEqual(128);
    });

    it("does not put the launch token in a log line", async () => {
      await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}&launch=launch-token-xyz`,
      });

      expect(harness.logLines.join("\n")).not.toContain("launch-token-xyz");
    });

    it("tolerates a trailing slash on the issuer it was launched from", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(`${ISSUER}/`)}&launch=t`,
      });

      expect(response.statusCode).toBe(302);
      expect(onlyPendingSession().issuer).toBe(ISSUER);
    });
  });

  describe("standalone launch", () => {
    it("omits the launch parameter and the launch/patient scope", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}`,
      });

      expect(response.statusCode).toBe(302);
      const location = new URL(response.headers.location as string);
      expect(location.searchParams.has("launch")).toBe(false);
      expect(location.searchParams.get("scope")).toBe(
        "openid fhirUser launch online_access user/*.cruds",
      );
    });

    it("is otherwise identical to an EHR launch", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}`,
      });

      const location = new URL(response.headers.location as string);
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("client_id")).toBe(LAUNCH_CLIENT_ID);
      expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(location.searchParams.get("aud")).toBe(ISSUER);
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      const pending = onlyPendingSession();
      expect(location.searchParams.get("code_challenge")).toBe(
        createHash("sha256")
          .update(pending.verifier, "ascii")
          .digest("base64url"),
      );
    });
  });

  describe("refusal", () => {
    it("names an unregistered issuer, stores nothing and contacts nobody", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/launch?iss=https%3A%2F%2Funregistered.example.org%2Ffhir",
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("https://unregistered.example.org/fhir");
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("escapes the issuer it names, so the name cannot become markup", async () => {
      const hostile = "https://evil.example.org/fhir?<script>alert(1)</script>";

      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(hostile)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("<script>");
      expect(response.body).toContain("&lt;script&gt;");
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a launch with no issuer at all", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/launch",
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an issuer that is not https, naming it", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/launch?iss=http%3A%2F%2Fehr.example.org%2Ffhir",
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.body).toContain("http://ehr.example.org/fhir");
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an issuer that is not a URL", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/launch?iss=not-a-url",
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.body).toContain("not-a-url");
      expect(sessionCount(harness.db)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a registered issuer whose authorisation server is unreachable, storing nothing", async () => {
      fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

      const response = await harness.server.inject({
        method: "GET",
        url: `/launch?iss=${encodeURIComponent(ISSUER)}`,
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain(ISSUER);
      expect(sessionCount(harness.db)).toBe(0);
    });
  });
});
