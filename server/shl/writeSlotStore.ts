/**
 * The `writeSlots` table: pre-allocated resources a filler may write to exactly once.
 *
 * Channel D used to live on a third-party FHIR server, where "once" was a property of the wire -
 * `If-Match` against the version the slot was already at, refused by any conformant server - and
 * the write token was advisory, because a plain FHIR server has no notion of one. The slot now
 * lives here, which changes both halves for the better: the version check is enforced by this
 * module in a single transaction, and the token is actually checked.
 *
 * What has *not* changed is the posture, and it is the reason the channel still exists. A slot is
 * **transport**, not a record. It holds an unreviewed assertion from somebody whose only credential
 * is that they had a link, so it is deliberately not on the launched server: the requester collects
 * it, a human reads it, and only then does `submitResponse` write to the record. Putting the slot
 * on the record server instead is the refused channel B, and the review gate is the whole
 * difference.
 *
 * Slots hold plaintext, so this app can read them. That is the trade against channel C, whose host
 * cannot; what it buys is a filler who needs `PUT` and no crypto at all.
 * @author John Grimes
 */

import { randomBytes } from "node:crypto";

import type { AppDatabase } from "../db";

/** Bytes of entropy in a slot id. Appears in the URL a link carries. */
const SLOT_ID_BYTES = 16;

/** Bytes of entropy in a write token. The capability to write to one slot, once. */
const WRITE_TOKEN_BYTES = 32;

/** A slot as stored. */
export interface WriteSlot {
  /** Random base64url id; appears in the slot URL path. */
  readonly id: string;
  /** The capability to write. Compared in constant time. */
  readonly writeToken: string;
  /** Version the slot is at. Starts at 1, becomes 2 when written. Serialised as the `ETag`. */
  readonly version: number;
  /** Whether the slot is still awaiting answers. */
  readonly status: "in-progress" | "completed";
  /** The QuestionnaireResponse as JSON text. */
  readonly content: string;
  /** Slot expiry in epoch seconds, mirroring the invitation's own. Null never expires. */
  readonly expiresAt: number | null;
  /** When the slot was minted, in epoch seconds. */
  readonly createdAt: number;
  /** When it was written, in epoch seconds, or null while it is still empty. */
  readonly completedAt: number | null;
}

/** What a write attempt did. */
export type WriteSlotResult =
  /** The answers were stored. */
  | { readonly outcome: "written"; readonly slot: WriteSlot }
  /** The slot has already been written, or the `If-Match` named a different version. */
  | { readonly outcome: "taken" }
  /** The token did not match. */
  | { readonly outcome: "refused" }
  /** No such slot, or it has expired. */
  | { readonly outcome: "gone" };

/**
 * Current time in epoch seconds, the unit every timestamp here uses.
 * @returns the current time in epoch seconds
 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Serialise a version as an HTTP entity tag.
 *
 * Weak tags are not used: `If-Match` on a weak tag is not allowed to succeed, and this comparison
 * is exactly the thing that makes the write happen once.
 * @param version the slot's version
 * @returns the strong entity tag
 * @example
 * etagFor(1); // '"1"'
 */
export function etagFor(version: number): string {
  return `"${version}"`;
}

/**
 * Whether an `If-Match` header matches the version a slot is at.
 *
 * `*` matches any existing slot, which is what the specification says it means. A list is accepted
 * because the header permits one. A missing header does **not** match: an unconditional write to a
 * slot whose whole purpose is to be written once is the case this channel exists to refuse.
 * @param header the raw `If-Match` header, if there was one
 * @param version the version the slot is at
 * @returns true when the write may proceed
 * @example
 * matchesEtag('"1"', 1); // true
 */
export function matchesEtag(
  header: string | undefined,
  version: number,
): boolean {
  if (header === undefined) {
    return false;
  }
  const wanted = etagFor(version);
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === wanted);
}

/**
 * Compare two tokens without revealing where they first differ.
 *
 * Length is compared first and separately, which does leak it; the token is fixed-width, so there
 * is nothing there to learn.
 * @param a one token
 * @param b the other
 * @returns true when they are the same
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

/**
 * Mint an empty slot.
 * @param db the database
 * @param options the empty resource to seed it with, and when it stops accepting writes
 * @param options.content the empty QuestionnaireResponse, as JSON text
 * @param options.expiresAt slot expiry in epoch seconds, or null to never expire
 * @returns the minted slot, including the token the caller must put in the link
 * @example
 * const slot = insertWriteSlot(db, { content, expiresAt });
 */
export function insertWriteSlot(
  db: AppDatabase,
  options: { content: string; expiresAt: number | null },
): WriteSlot {
  const slot: WriteSlot = {
    id: randomBytes(SLOT_ID_BYTES).toString("base64url"),
    writeToken: randomBytes(WRITE_TOKEN_BYTES).toString("base64url"),
    version: 1,
    status: "in-progress",
    content: options.content,
    expiresAt: options.expiresAt,
    createdAt: nowSeconds(),
    completedAt: null,
  };

  db.prepare(
    `INSERT INTO writeSlots (id, writeToken, version, status, content, expiresAt, createdAt, completedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    slot.id,
    slot.writeToken,
    slot.version,
    slot.status,
    slot.content,
    slot.expiresAt,
    slot.createdAt,
    slot.completedAt,
  );

  return slot;
}

/**
 * Read a slot that has not expired.
 *
 * Unknown and expired collapse to the same answer, for the same reason they do for invitations:
 * distinguishing them would turn the route into an oracle for which slots had ever been minted.
 * @param db the database
 * @param id the slot id from the URL
 * @param now the current time in epoch seconds, injectable for tests
 * @returns the slot, or undefined when there is no live slot with that id
 * @example
 * const slot = findWriteSlot(db, "4mV1…");
 */
export function findWriteSlot(
  db: AppDatabase,
  id: string,
  now = nowSeconds(),
): WriteSlot | undefined {
  const row = db
    .prepare<[string], WriteSlot>(
      `SELECT id, writeToken, version, status, content, expiresAt, createdAt, completedAt
       FROM writeSlots WHERE id = ?`,
    )
    .get(id);
  if (row === undefined) {
    return undefined;
  }
  return row.expiresAt !== null && row.expiresAt < now ? undefined : row;
}

/**
 * Write answers into a slot, at most once.
 *
 * The check and the update are one statement rather than a read followed by a write, so two
 * simultaneous writes cannot both observe version 1 and both succeed. `changes === 0` means the row
 * moved between the read above and this statement, which is the same answer as a stale `If-Match`:
 * somebody else got there first.
 * @param db the database
 * @param options the slot id, the token offered, the `If-Match` header and the answers
 * @param options.id the slot id from the URL
 * @param options.writeToken the bearer token the filler offered
 * @param options.ifMatch the raw `If-Match` header, if there was one
 * @param options.content the completed QuestionnaireResponse, as JSON text
 * @returns what happened, for the route to turn into a status
 * @example
 * const result = writeToSlot(db, { id, writeToken, ifMatch, content });
 */
export function writeToSlot(
  db: AppDatabase,
  options: {
    id: string;
    writeToken: string | undefined;
    ifMatch: string | undefined;
    content: string;
  },
): WriteSlotResult {
  const slot = findWriteSlot(db, options.id);
  if (slot === undefined) {
    return { outcome: "gone" };
  }

  if (
    options.writeToken === undefined ||
    !tokensMatch(options.writeToken, slot.writeToken)
  ) {
    return { outcome: "refused" };
  }

  if (
    slot.status === "completed" ||
    !matchesEtag(options.ifMatch, slot.version)
  ) {
    return { outcome: "taken" };
  }

  const completedAt = nowSeconds();
  const result = db
    .prepare(
      `UPDATE writeSlots
       SET content = ?, status = 'completed', version = version + 1, completedAt = ?
       WHERE id = ? AND version = ? AND status = 'in-progress'`,
    )
    .run(options.content, completedAt, slot.id, slot.version);

  if (result.changes === 0) {
    return { outcome: "taken" };
  }

  return {
    outcome: "written",
    slot: {
      ...slot,
      content: options.content,
      status: "completed",
      version: slot.version + 1,
      completedAt,
    },
  };
}

/**
 * Delete slots whose expiry has passed.
 * @param db the database
 * @param now the current time in epoch seconds, injectable for tests
 * @returns how many rows were removed
 * @example
 * const removed = deleteExpiredWriteSlots(db);
 */
export function deleteExpiredWriteSlots(
  db: AppDatabase,
  now = nowSeconds(),
): number {
  return db
    .prepare(
      `DELETE FROM writeSlots WHERE expiresAt IS NOT NULL AND expiresAt < ?`,
    )
    .run(now).changes;
}
