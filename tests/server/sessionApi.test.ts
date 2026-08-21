/**
 * Tests for `server/api/session.ts`: the three routes the SPA needs to know who it is.
 *
 * The property under test throughout is FR-005: the browser gets an opaque session reference
 * and a few display fields, and nothing else. `/api/session` is the route most likely to grow a
 * convenient extra field over time, so its response is asserted key by key rather than field by
 * field, and the serialised body is searched for every kind of secret the process holds.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AWKWARD_CLIENT_ID,
  AWKWARD_CLIENT_SECRET,
  AWKWARD_ISSUER,
  AWKWARD_ISSUER_LABEL,
  FAKE_PRIVATE_EXPONENT,
  ISSUER,
  ISSUER_LABEL,
  LAUNCH_CLIENT_ID,
  LAUNCH_CLIENT_SECRET,
  closeHarness,
  createHarness,
  sessionCount,
} from "./support/testHarness";

import type { TestHarness } from "./support/testHarness";

/** The access token held by the session under test. Must never be serialised. */
const ACCESS_TOKEN = "session-access-token-must-not-leak";

/** The refresh token held by the session under test. Must never be serialised. */
const REFRESH_TOKEN = "session-refresh-token-must-not-leak";

/** The shape `/api/session` answers with. */
interface SessionBody {
  issuer: string;
  issuerLabel: string;
  patientId: string | null;
  userDisplay: string | null;
  expiresAt: number;
}

describe("the session API", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await closeHarness(harness);
  });

  /**
   * Insert an active session row.
   * @param overrides fields to vary from the default active session
   * @param overrides.id the session id, and therefore the cookie value
   * @param overrides.issuer the issuer the session is against
   * @param overrides.expiresAt access token expiry in epoch seconds
   * @param overrides.refreshToken the refresh token to store, or null for none
   * @param overrides.patientId the launch context patient, or null for none
   * @param overrides.userDisplay the requester display name, or null for none
   * @returns the id of the inserted row
   */
  function insertActive(
    overrides: {
      id?: string;
      issuer?: string;
      expiresAt?: number;
      refreshToken?: string | null;
      patientId?: string | null;
      userDisplay?: string | null;
    } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const id = overrides.id ?? "active-session-id";
    harness.db
      .prepare(
        `INSERT INTO sessions (id, status, issuer, accessToken, accessTokenExpiresAt,
                               refreshToken, patientId, userDisplay, createdAt)
         VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        overrides.issuer ?? ISSUER,
        ACCESS_TOKEN,
        overrides.expiresAt ?? now + 3600,
        overrides.refreshToken === undefined
          ? REFRESH_TOKEN
          : overrides.refreshToken,
        overrides.patientId === undefined ? "pt-1" : overrides.patientId,
        overrides.userDisplay === undefined
          ? "Dr Jane Smith"
          : overrides.userDisplay,
        now,
      );
    return id;
  }

  describe("GET /api/session", () => {
    it("answers no-session without a cookie", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
    });

    it("answers no-session for a cookie naming a session that does not exist", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "not-a-real-session" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
    });

    it("answers no-session once the token has expired with nothing to refresh with", async () => {
      insertActive({
        expiresAt: Math.floor(Date.now() / 1000) - 60,
        refreshToken: null,
      });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "active-session-id" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
    });

    it("reports the session while a refresh token can still rescue it", async () => {
      insertActive({ expiresAt: Math.floor(Date.now() / 1000) - 60 });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "active-session-id" },
      });

      expect(response.statusCode).toBe(200);
    });

    it("reports the issuer, its label, the launch context and the expiry, and nothing else", async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 1800;
      insertActive({ expiresAt });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "active-session-id" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<SessionBody>();
      expect(body).toEqual({
        issuer: ISSUER,
        issuerLabel: ISSUER_LABEL,
        patientId: "pt-1",
        userDisplay: "Dr Jane Smith",
        expiresAt,
      });
      expect(Object.keys(body).toSorted()).toEqual([
        "expiresAt",
        "issuer",
        "issuerLabel",
        "patientId",
        "userDisplay",
      ]);
    });

    it("reports a standalone session's absent launch context as null", async () => {
      insertActive({ patientId: null, userDisplay: null });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "active-session-id" },
      });

      const body = response.json<SessionBody>();
      expect(body.patientId).toBeNull();
      expect(body.userDisplay).toBeNull();
    });

    it("labels a second registered issuer with its own label", async () => {
      insertActive({ issuer: AWKWARD_ISSUER });

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "active-session-id" },
      });

      expect(response.json<SessionBody>().issuerLabel).toBe(
        AWKWARD_ISSUER_LABEL,
      );
    });

    it("serialises no token, secret or key material", async () => {
      insertActive();

      const response = await harness.server.inject({
        method: "GET",
        url: "/api/session",
        cookies: { shl_session: "active-session-id" },
      });

      for (const forbidden of [
        ACCESS_TOKEN,
        REFRESH_TOKEN,
        LAUNCH_CLIENT_SECRET,
        AWKWARD_CLIENT_SECRET,
        FAKE_PRIVATE_EXPONENT,
        "accessToken",
        "refreshToken",
        "clientSecret",
        "privateKeyJwk",
      ]) {
        expect(response.body).not.toContain(forbidden);
      }
    });
  });

  describe("POST /api/logout", () => {
    it("deletes the session, clears the cookie and answers 204", async () => {
      insertActive();

      const response = await harness.server.inject({
        method: "POST",
        url: "/api/logout",
        cookies: { shl_session: "active-session-id" },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      expect(sessionCount(harness.db)).toBe(0);
      const setCookie = response.headers["set-cookie"] as string;
      expect(setCookie).toContain("shl_session=");
      expect(setCookie).toContain("Path=/");
      // Either form of immediate expiry is acceptable; one of them must be present.
      expect(/Expires=|Max-Age=0/.test(setCookie)).toBe(true);
    });

    it("is idempotent, so a stale cookie does not become an error the SPA must handle", async () => {
      const response = await harness.server.inject({
        method: "POST",
        url: "/api/logout",
        cookies: { shl_session: "gone-already" },
      });

      expect(response.statusCode).toBe(204);
    });

    it("succeeds with no cookie at all", async () => {
      const response = await harness.server.inject({
        method: "POST",
        url: "/api/logout",
      });

      expect(response.statusCode).toBe(204);
    });

    it("does not delete a different user's session", async () => {
      insertActive({ id: "session-one" });
      insertActive({ id: "session-two" });

      await harness.server.inject({
        method: "POST",
        url: "/api/logout",
        cookies: { shl_session: "session-one" },
      });

      expect(sessionCount(harness.db)).toBe(1);
    });
  });

  describe("GET /api/issuers", () => {
    it("lists every registered issuer with its label, without a session", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/issuers",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { issuer: ISSUER, label: ISSUER_LABEL },
        { issuer: AWKWARD_ISSUER, label: AWKWARD_ISSUER_LABEL },
      ]);
    });

    it("discloses no client ids, secrets or keys", async () => {
      const response = await harness.server.inject({
        method: "GET",
        url: "/api/issuers",
      });

      for (const forbidden of [
        LAUNCH_CLIENT_ID,
        LAUNCH_CLIENT_SECRET,
        AWKWARD_CLIENT_ID,
        AWKWARD_CLIENT_SECRET,
        FAKE_PRIVATE_EXPONENT,
        "clientId",
        "clientSecret",
        "backendClient",
        "grantTtlSeconds",
      ]) {
        expect(response.body).not.toContain(forbidden);
      }
    });
  });
});
