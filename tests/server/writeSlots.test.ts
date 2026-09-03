/**
 * Tests for the channel D slot: `server/shl/writeSlotStore.ts` and `server/api/writeSlots.ts`.
 *
 * One property carries most of these. **The second write must fail**, and it must fail for a reason
 * that is a property of the exchange rather than of anyone's good behaviour. That is what makes this
 * a capability a link can safely carry: a photographed invitation buys at most one write, and a
 * filler who sends twice learns that the first one landed rather than silently overwriting it.
 *
 * The rest is about who may do what. Minting needs a session, because a slot is an offer to accept
 * somebody's answers and an app that let anyone create them would be an open relay. Writing needs
 * only the token from the link, because the filler has nothing else by construction.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ISSUER, closeHarness, createHarness } from "./support/testHarness";
import {
  etagFor,
  findWriteSlot,
  insertWriteSlot,
  matchesEtag,
  writeToSlot,
  deleteExpiredWriteSlots,
} from "../../server/shl/writeSlotStore";

import type { TestHarness } from "./support/testHarness";

const SESSION_ID = "active-session-id";
const SLOT_PATH = "/shl/slot";

/** An empty slot's contents, as the invitation route seeds them. */
const EMPTY_RESOURCE = {
  resourceType: "QuestionnaireResponse",
  status: "in-progress",
};

/** The same thing as stored: the store holds JSON text, not an object. */
const EMPTY = JSON.stringify(EMPTY_RESOURCE);

/** Completed answers, as a filler would send them. */
const ANSWERS = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  item: [{ linkId: "1", answer: [{ valueString: "Yes" }] }],
};

/**
 * Insert the active session the mint route requires.
 * @param db the harness database to insert into
 */
function seedSession(db: TestHarness["db"]): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO sessions (id, status, issuer, accessToken, accessTokenExpiresAt,
                           refreshToken, patientId, userDisplay, createdAt)
     VALUES (?, 'active', ?, 'token', ?, NULL, 'pt-1', 'Dr Jane Smith', ?)`,
  ).run(SESSION_ID, ISSUER, now + 3600, now);
}

describe("the write slot store", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await closeHarness(harness);
  });

  describe("matchesEtag", () => {
    it("matches the version the slot is at", () => {
      expect(matchesEtag('"1"', 1)).toBe(true);
    });

    it("matches a wildcard, which means any existing slot", () => {
      expect(matchesEtag("*", 7)).toBe(true);
    });

    it("accepts a list, because the header permits one", () => {
      expect(matchesEtag('"0", "1"', 1)).toBe(true);
    });

    it("does not match a different version", () => {
      expect(matchesEtag('"1"', 2)).toBe(false);
    });

    /*
     * The absent case is the one that matters. An unconditional write to a slot whose whole purpose
     * is to be written once is exactly what this channel exists to refuse.
     */
    it("does not match a missing header", () => {
      expect(matchesEtag(undefined, 1)).toBe(false);
    });
  });

  describe("writing", () => {
    it("stores the answers and moves the slot on a version", () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      const result = writeToSlot(harness.db, {
        id: slot.id,
        writeToken: slot.writeToken,
        ifMatch: etagFor(slot.version),
        content: JSON.stringify(ANSWERS),
      });

      expect(result.outcome).toBe("written");
      const stored = findWriteSlot(harness.db, slot.id);
      expect(stored?.status).toBe("completed");
      expect(stored?.version).toBe(slot.version + 1);
      expect(stored?.completedAt).not.toBeNull();
    });

    it("refuses the second write, which is the whole point of the channel", () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });
      const write = () =>
        writeToSlot(harness.db, {
          id: slot.id,
          writeToken: slot.writeToken,
          ifMatch: etagFor(slot.version),
          content: JSON.stringify(ANSWERS),
        });

      expect(write().outcome).toBe("written");
      expect(write().outcome).toBe("taken");
    });

    it("refuses a stale If-Match even before the slot is written", () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      expect(
        writeToSlot(harness.db, {
          id: slot.id,
          writeToken: slot.writeToken,
          ifMatch: '"99"',
          content: JSON.stringify(ANSWERS),
        }).outcome,
      ).toBe("taken");
    });

    it("refuses a wrong token", () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      expect(
        writeToSlot(harness.db, {
          id: slot.id,
          writeToken: "not-the-token",
          ifMatch: etagFor(slot.version),
          content: JSON.stringify(ANSWERS),
        }).outcome,
      ).toBe("refused");
    });

    it("refuses a missing token", () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      expect(
        writeToSlot(harness.db, {
          id: slot.id,
          writeToken: undefined,
          ifMatch: etagFor(slot.version),
          content: JSON.stringify(ANSWERS),
        }).outcome,
      ).toBe("refused");
    });

    it("reports an unknown slot as gone", () => {
      expect(
        writeToSlot(harness.db, {
          id: "no-such-slot",
          writeToken: "whatever",
          ifMatch: "*",
          content: JSON.stringify(ANSWERS),
        }).outcome,
      ).toBe("gone");
    });
  });

  describe("expiry", () => {
    /*
     * Unknown and expired collapse to the same answer, for the same reason they do for invitations:
     * distinguishing them would turn the route into an oracle for which slots had ever been minted.
     */
    it("hides an expired slot rather than reporting it as expired", () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });

      expect(findWriteSlot(harness.db, slot.id)).toBeUndefined();
      expect(
        writeToSlot(harness.db, {
          id: slot.id,
          writeToken: slot.writeToken,
          ifMatch: "*",
          content: JSON.stringify(ANSWERS),
        }).outcome,
      ).toBe("gone");
    });

    it("sweeps expired slots and leaves live ones", () => {
      const past = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });
      const future = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      const forever = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      expect(deleteExpiredWriteSlots(harness.db)).toBe(1);
      expect(findWriteSlot(harness.db, past.id)).toBeUndefined();
      expect(findWriteSlot(harness.db, future.id)).toBeDefined();
      expect(findWriteSlot(harness.db, forever.id)).toBeDefined();
    });
  });

  describe("the routes", () => {
    it("refuses to mint without a session", async () => {
      const response = await harness.server.inject({
        method: "POST",
        url: "/api/write-slots",
        payload: { content: EMPTY_RESOURCE },
      });

      expect(response.statusCode).toBe(401);
    });

    it("mints a slot and answers with an address, an ETag and a token", async () => {
      seedSession(harness.db);

      const response = await harness.server.inject({
        method: "POST",
        url: "/api/write-slots",
        cookies: { shl_session: SESSION_ID },
        payload: { content: EMPTY_RESOURCE },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json<{
        writeUrl: string;
        writeEtag: string;
        writeToken: string;
      }>();
      expect(body.writeUrl).toContain(SLOT_PATH);
      expect(body.writeEtag).toBe('"1"');
      expect(body.writeToken).toBeTruthy();
    });

    it("serves the slot publicly, with its ETag", async () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      const response = await harness.server.inject({
        method: "GET",
        url: `${SLOT_PATH}/${slot.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(response.json<{ status: string }>().status).toBe("in-progress");
    });

    it("accepts a conditional write carrying the token, once", async () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });
      const send = () =>
        harness.server.inject({
          method: "PUT",
          url: `${SLOT_PATH}/${slot.id}`,
          headers: {
            "content-type": "application/fhir+json",
            "if-match": '"1"',
            authorization: `Bearer ${slot.writeToken}`,
          },
          payload: ANSWERS,
        });

      const first = await send();
      expect(first.statusCode).toBe(200);

      // 412, the same status a plain FHIR server gives, so a filler written against one reads the
      // same outcome whoever is hosting the slot.
      const second = await send();
      expect(second.statusCode).toBe(412);
    });

    it("answers a bad token with 403 and a missing slot with 404", async () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      const forbidden = await harness.server.inject({
        method: "PUT",
        url: `${SLOT_PATH}/${slot.id}`,
        headers: {
          "content-type": "application/fhir+json",
          "if-match": '"1"',
          authorization: "Bearer wrong",
        },
        payload: ANSWERS,
      });
      expect(forbidden.statusCode).toBe(403);

      const missing = await harness.server.inject({
        method: "PUT",
        url: `${SLOT_PATH}/nope`,
        headers: {
          "content-type": "application/fhir+json",
          "if-match": "*",
          authorization: "Bearer wrong",
        },
        payload: ANSWERS,
      });
      expect(missing.statusCode).toBe(404);
    });

    it("refuses a body that is not a QuestionnaireResponse", async () => {
      const slot = insertWriteSlot(harness.db, {
        content: EMPTY,
        expiresAt: null,
      });

      const response = await harness.server.inject({
        method: "PUT",
        url: `${SLOT_PATH}/${slot.id}`,
        headers: {
          "content-type": "application/fhir+json",
          "if-match": '"1"',
          authorization: `Bearer ${slot.writeToken}`,
        },
        payload: { resourceType: "Patient" },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
