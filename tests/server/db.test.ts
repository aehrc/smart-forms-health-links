/**
 * Tests for the SQLite layer: `server/db.ts`, `server/sessions.ts` and
 * `server/shl/invitationStore.ts`.
 *
 * The state machines in data-model.md are the subject here. A session goes
 * `pending` → `active` → `expired`, with pending rows dying after ten minutes so an abandoned
 * authorize redirect cannot be resumed later. An invitation goes `active` → `expired`, and the
 * store must answer identically for an expired id and an unknown one, so that a caller cannot
 * use the manifest route to discover which ids ever existed.
 * @author John Grimes
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateSchema, openDatabase } from "../../server/db";
import {
  PENDING_SESSION_TTL_SECONDS,
  activateSession,
  createPendingSession,
  deleteSession,
  findActiveSession,
  findPendingSessionByState,
  purgeExpiredSessions,
} from "../../server/sessions";
import {
  findInvitation,
  insertInvitation,
} from "../../server/shl/invitationStore";

import type { AppDatabase } from "../../server/db";
import type { InvitationInput } from "../../server/shl/invitationStore";

/** A fixed point in time, so every expiry assertion is deterministic. */
const NOW = 1_800_000_000;

/**
 * Invitation fields common to most tests.
 * @param overrides fields to replace on the base invitation
 * @returns a complete invitation input
 */
function invitationInput(
  overrides: Partial<InvitationInput> = {},
): InvitationInput {
  return {
    linkKey: "TVLzO1Xdak1nJ3zJyv6wLmnbBHhBRT7YyEKk4hZlNsY",
    payloadCiphertext: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aaa.bbb.ccc",
    label: "GP Chronic Condition Management Plan",
    expiresAt: NOW + 2_592_000,
    issuer: "https://ehr.example.org/fhir",
    patientId: "pt-1",
    requestIdentifier: "urn:uuid:7f1a2f0e-6e0b-4c2a-9c1f-2f4c9e0b7a11",
    publishedTaskUrl: "https://ehr.example.org/fhir/Task/task-1",
    ...overrides,
  };
}

describe("SQLite layer", () => {
  let directory: string;
  let db: AppDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "shl-db-"));
    db = openDatabase(path.join(directory, "app.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  /**
   * Create a pending session with the standard fixture values.
   * @param overrides fields to replace
   * @param now the creation time
   * @returns the created pending session
   */
  function pending(
    overrides: Partial<{
      issuer: string;
      state: string;
      verifier: string;
    }> = {},
    now = NOW,
  ) {
    return createPendingSession(
      db,
      {
        issuer: "https://ehr.example.org/fhir",
        state: "state-abc",
        verifier: "verifier-abc",
        ...overrides,
      },
      now,
    );
  }

  describe("schema", () => {
    it("creates the sessions and invitations tables", () => {
      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(tables).toContain("sessions");
      expect(tables).toContain("invitations");
    });

    it("enables write-ahead logging and foreign key enforcement", () => {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });

    it("applies the migration idempotently, preserving existing rows", () => {
      const invitation = insertInvitation(db, invitationInput(), NOW);

      migrateSchema(db);
      migrateSchema(db);

      expect(findInvitation(db, invitation.id, NOW)?.label).toBe(
        "GP Chronic Condition Management Plan",
      );
    });
  });

  describe("sessions", () => {
    it("mints an opaque, unique id for each pending session", () => {
      const first = pending();
      const second = pending({ state: "state-def" });

      expect(first.id).not.toBe(second.id);
      // 128 bits of base64url is 22 characters, with no padding and no URL-unsafe characters.
      expect(first.id).toMatch(/^[\w-]{22,}$/);
    });

    it("finds a pending session by its state parameter", () => {
      const created = pending();

      const found = findPendingSessionByState(db, "state-abc", NOW);

      expect(found?.id).toBe(created.id);
      expect(found?.issuer).toBe("https://ehr.example.org/fhir");
      expect(found?.verifier).toBe("verifier-abc");
      expect(found?.createdAt).toBe(NOW);
    });

    it("does not find a pending session under an unknown state", () => {
      pending();

      expect(
        findPendingSessionByState(db, "state-unknown", NOW),
      ).toBeUndefined();
    });

    it("expires a pending session ten minutes after it was created", () => {
      pending();

      expect(PENDING_SESSION_TTL_SECONDS).toBe(600);
      // One second inside the window it is still resumable ...
      expect(
        findPendingSessionByState(db, "state-abc", NOW + 599),
      ).toBeDefined();
      // ... and at the boundary it is gone.
      expect(
        findPendingSessionByState(db, "state-abc", NOW + 600),
      ).toBeUndefined();
      expect(
        findPendingSessionByState(db, "state-abc", NOW + 601),
      ).toBeUndefined();
    });

    it("promotes a pending session to active, capturing tokens and launch context", () => {
      const created = pending();

      const active = activateSession(db, {
        id: created.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 3600,
        refreshToken: "refresh-token-value",
        patientId: "pt-1",
        userDisplay: "Dr Alex Jones",
      });

      expect(active.id).toBe(created.id);
      expect(active.issuer).toBe("https://ehr.example.org/fhir");
      expect(active.accessToken).toBe("access-token-value");
      expect(active.accessTokenExpiresAt).toBe(NOW + 3600);
      expect(active.refreshToken).toBe("refresh-token-value");
      expect(active.patientId).toBe("pt-1");
      expect(active.userDisplay).toBe("Dr Alex Jones");

      const read = findActiveSession(db, created.id, NOW + 5);
      expect(read).toEqual(active);
    });

    it("retires the state parameter once the session is active, so a code cannot be replayed", () => {
      const created = pending();
      activateSession(db, {
        id: created.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 3600,
      });

      expect(findPendingSessionByState(db, "state-abc", NOW)).toBeUndefined();
    });

    it("stores absent launch context and refresh token as nulls", () => {
      const created = pending();

      const active = activateSession(db, {
        id: created.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 3600,
      });

      expect(active.refreshToken).toBeNull();
      expect(active.patientId).toBeNull();
      expect(active.userDisplay).toBeNull();
    });

    it("refuses to promote a session that does not exist", () => {
      expect(() =>
        activateSession(db, {
          id: "no-such-session",
          accessToken: "access-token-value",
          accessTokenExpiresAt: NOW + 3600,
        }),
      ).toThrow(/no-such-session/);
    });

    it("does not read a pending session as an active one", () => {
      const created = pending();

      expect(findActiveSession(db, created.id, NOW)).toBeUndefined();
    });

    it("treats an active session whose token has expired with no refresh token as expired", () => {
      const created = pending();
      activateSession(db, {
        id: created.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 3600,
      });

      expect(findActiveSession(db, created.id, NOW + 3599)).toBeDefined();
      expect(findActiveSession(db, created.id, NOW + 3600)).toBeUndefined();
    });

    it("keeps an expired-token session readable while a refresh token remains", () => {
      const created = pending();
      activateSession(db, {
        id: created.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 3600,
        refreshToken: "refresh-token-value",
      });

      // Expiry alone is not the end of the session: the caller can still refresh.
      expect(findActiveSession(db, created.id, NOW + 7200)?.refreshToken).toBe(
        "refresh-token-value",
      );
    });

    it("deletes a session, and reports whether there was one to delete", () => {
      const created = pending();

      expect(deleteSession(db, created.id)).toBe(true);
      expect(deleteSession(db, created.id)).toBe(false);
      expect(findPendingSessionByState(db, "state-abc", NOW)).toBeUndefined();
    });

    it("purges expired rows of both kinds and leaves live ones alone", () => {
      pending({ state: "state-stale" });
      pending({ state: "state-fresh" }, NOW + 590);

      const expiredActiveSource = pending({ state: "state-active-expired" });
      activateSession(db, {
        id: expiredActiveSource.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 100,
      });

      const refreshableSource = pending({ state: "state-active-refreshable" });
      activateSession(db, {
        id: refreshableSource.id,
        accessToken: "access-token-value",
        accessTokenExpiresAt: NOW + 100,
        refreshToken: "refresh-token-value",
      });

      const purged = purgeExpiredSessions(db, NOW + 601);

      expect(purged).toBe(2);
      expect(
        findPendingSessionByState(db, "state-stale", NOW + 601),
      ).toBeUndefined();
      expect(
        findPendingSessionByState(db, "state-fresh", NOW + 601),
      ).toBeDefined();
      expect(
        db
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) AS count FROM sessions WHERE id = ?",
          )
          .get(expiredActiveSource.id)?.count,
      ).toBe(0);
      expect(
        findActiveSession(db, refreshableSource.id, NOW + 601)?.refreshToken,
      ).toBe("refresh-token-value");
    });
  });

  describe("invitations", () => {
    it("stores an invitation and reads every field back", () => {
      const created = insertInvitation(db, invitationInput(), NOW);

      const found = findInvitation(db, created.id, NOW);

      expect(found).toEqual(created);
      expect(found?.linkKey).toBe(
        "TVLzO1Xdak1nJ3zJyv6wLmnbBHhBRT7YyEKk4hZlNsY",
      );
      expect(found?.payloadCiphertext).toContain("eyJhbGciOiJkaXIi");
      expect(found?.issuer).toBe("https://ehr.example.org/fhir");
      expect(found?.patientId).toBe("pt-1");
      expect(found?.requestIdentifier).toBe(
        "urn:uuid:7f1a2f0e-6e0b-4c2a-9c1f-2f4c9e0b7a11",
      );
      expect(found?.publishedTaskUrl).toBe(
        "https://ehr.example.org/fhir/Task/task-1",
      );
      expect(found?.createdAt).toBe(NOW);
    });

    it("mints a unique, URL-safe id for each invitation", () => {
      const first = insertInvitation(db, invitationInput(), NOW);
      const second = insertInvitation(db, invitationInput(), NOW);

      expect(first.id).not.toBe(second.id);
      expect(first.id).toMatch(/^[\w-]{22,}$/);
    });

    it("returns nothing for an unknown id", () => {
      expect(findInvitation(db, "no-such-invitation", NOW)).toBeUndefined();
    });

    it("answers identically for an expired invitation and an unknown one", () => {
      const created = insertInvitation(
        db,
        invitationInput({ expiresAt: NOW + 60 }),
        NOW,
      );

      // Inside the window the invitation resolves ...
      expect(findInvitation(db, created.id, NOW + 59)).toBeDefined();

      // ... and afterwards the read is indistinguishable from one for an id that never
      // existed, so the route built on it cannot become an existence oracle.
      const expired = findInvitation(db, created.id, NOW + 60);
      const unknown = findInvitation(db, "no-such-invitation", NOW + 60);
      expect(expired).toBeUndefined();
      expect(expired).toEqual(unknown);
    });

    it("treats a null expiry as never expiring", () => {
      const created = insertInvitation(
        db,
        invitationInput({ expiresAt: null }),
        NOW,
      );

      expect(findInvitation(db, created.id, NOW + 10_000_000)?.id).toBe(
        created.id,
      );
      expect(created.expiresAt).toBeNull();
    });

    it("stores an absent destination patient as null", () => {
      const created = insertInvitation(
        db,
        invitationInput({ patientId: null }),
        NOW,
      );

      expect(findInvitation(db, created.id, NOW)?.patientId).toBeNull();
    });
  });
});
