/**
 * Standing invitation rows: the QR a practice prints once and many walk-ins scan.
 *
 * An ordinary invitation is minted for one person and answered once. A standing invitation is
 * minted for nobody in particular and answered by whoever walks through the door, so the two
 * cannot be the same row. This one holds the *hosting* state - the sealed payload, the link key,
 * the lifetime and whether staff have withdrawn it - and mints an ordinary invitation on every
 * scan to hold the *answering* state.
 *
 * ```text
 * standingInvitations (one row, printed on a poster)
 *        │
 *        ├── invitations (standingId = …)   scan 1, its own requestIdentifier, answered once
 *        ├── invitations (standingId = …)   scan 2, ditto
 *        └── …
 * ```
 *
 * That split is what lets the at-most-one-response rule in `invitationStore` stay exactly as it
 * is. Nothing about it had to be relaxed to serve a link that many people use, because no single
 * child is used by more than one of them.
 *
 * **Three states read as absent.** Unknown, expired and revoked all come back as `undefined` from
 * {@link findStandingInvitation}, for the reason `findInvitation` collapses the first two: a
 * caller must not be able to learn from the manifest route which links were ever printed, and a
 * revoked link must answer exactly as a link that never existed.
 * @author John Grimes
 */

import { randomBytes } from "node:crypto";

import type { AppDatabase } from "../db";

/** Bytes of entropy in a standing invitation id. Matches an invitation id. */
const STANDING_ID_BYTES = 16;

/** Fields written when a standing invitation is created. */
export interface StandingInvitationInput {
  /** 256-bit base64url JWE key, shared with everyone who scans the printed code. */
  readonly linkKey: string;
  /** JWE of the invitation Bundle, encrypted once when the link was created. */
  readonly payloadCiphertext: string;
  /** SHL label, normally the questionnaire title. */
  readonly label: string;
  /** When the printed code stops working, in epoch seconds, or null for no expiry. */
  readonly expiresAt: number | null;
  /** Issuer of the creating session; the destination every scan's answers are forwarded to. */
  readonly issuer: string;
  /**
   * The `urn:uuid:` identifier of the standing request, as published on the issuer.
   *
   * The children do **not** inherit it. Each scan mints its own, because that identifier is the
   * conditional-create key upstream, and two walk-ins sharing one would mean the second person's
   * answers were absorbed as a replay of the first person's.
   */
  readonly requestIdentifier: string;
  /** Absolute URL of the one Task published for this standing invitation. */
  readonly publishedTaskUrl: string;
  /** Canonical URL of the questionnaire, or null when it declared none. */
  readonly questionnaireCanonical: string | null;
}

/** A stored standing invitation. */
export interface StandingInvitation extends StandingInvitationInput {
  /** Random base64url id; appears in the printed manifest URL. */
  readonly id: string;
  /** When staff withdrew the link, in epoch seconds, or null while it is live. */
  readonly revokedAt: number | null;
  /** When the link was created, in epoch seconds. */
  readonly createdAt: number;
}

/** A standing invitation as the staff-facing list shows it. */
export interface StandingInvitationSummary extends StandingInvitation {
  /** How many scans have minted an invitation from this link, over its whole life. */
  readonly scans: number;
  /** How many of those scans produced answers the practice accepted. */
  readonly answered: number;
}

/** The row's columns, in one place so the two reads below cannot drift apart. */
const COLUMNS: readonly string[] = [
  "id",
  "linkKey",
  "payloadCiphertext",
  "label",
  "expiresAt",
  "issuer",
  "requestIdentifier",
  "publishedTaskUrl",
  "questionnaireCanonical",
  "revokedAt",
  "createdAt",
];

/**
 * The column list for a `SELECT`, optionally qualified by a table alias.
 * @param alias the alias to qualify each column with, for a join
 * @returns the comma-separated list
 */
function columnList(alias?: string): string {
  return COLUMNS.map((column) =>
    alias === undefined ? column : `${alias}.${column}`,
  ).join(", ");
}

/**
 * Store a freshly created standing invitation.
 * @param db the database
 * @param input the fields fixed when the link is created
 * @param now current time in epoch seconds, injectable for tests
 * @returns the stored row, including its minted id
 * @example
 * const standing = insertStandingInvitation(db, { linkKey, payloadCiphertext, ... });
 */
export function insertStandingInvitation(
  db: AppDatabase,
  input: StandingInvitationInput,
  now: number = Math.floor(Date.now() / 1000),
): StandingInvitation {
  const id = randomBytes(STANDING_ID_BYTES).toString("base64url");
  db.prepare(
    `INSERT INTO standingInvitations (id, linkKey, payloadCiphertext, label, expiresAt,
                                      issuer, requestIdentifier, publishedTaskUrl,
                                      questionnaireCanonical, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.linkKey,
    input.payloadCiphertext,
    input.label,
    input.expiresAt,
    input.issuer,
    input.requestIdentifier,
    input.publishedTaskUrl,
    input.questionnaireCanonical,
    now,
  );
  return { ...input, id, revokedAt: null, createdAt: now };
}

/**
 * Read a standing invitation that is still live.
 *
 * Expired and revoked are reported exactly as unknown, so that neither the manifest route nor
 * anything downstream becomes an oracle for which codes a practice has ever printed.
 * @param db the database
 * @param id the id from the manifest URL
 * @param now current time in epoch seconds, injectable for tests
 * @returns the row, or undefined when it is unknown, expired or revoked
 * @example
 * const standing = findStandingInvitation(db, request.params.id);
 */
export function findStandingInvitation(
  db: AppDatabase,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
): StandingInvitation | undefined {
  const row = db
    .prepare<[string], StandingInvitation>(
      `SELECT ${columnList()} FROM standingInvitations WHERE id = ?`,
    )
    .get(id);
  if (
    row === undefined ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && row.expiresAt <= now)
  ) {
    return undefined;
  }
  return row;
}

/**
 * Every standing invitation created against one issuer, newest first.
 *
 * Expired and revoked rows are included here, unlike {@link findStandingInvitation}, because this
 * is the staff-facing list: a link that has stopped working is exactly what somebody looking at
 * this list needs to be told about. Scoped to the issuer so that a deployment serving two
 * practices does not show either of them the other's codes.
 * @param db the database
 * @param issuer the FHIR base of the reading session
 * @returns the rows, each with its scan and answer counts
 * @example
 * const links = listStandingInvitations(db, session.issuer);
 */
export function listStandingInvitations(
  db: AppDatabase,
  issuer: string,
): StandingInvitationSummary[] {
  return db
    .prepare<[string], StandingInvitationSummary>(
      `SELECT ${columnList("s")},
              (SELECT count(*) FROM invitations i WHERE i.standingId = s.id) AS scans,
              (SELECT count(*) FROM invitations i
                WHERE i.standingId = s.id AND i.responseReference IS NOT NULL) AS answered
       FROM standingInvitations s
       WHERE s.issuer = ?
       ORDER BY s.createdAt DESC`,
    )
    .all(issuer);
}

/**
 * Withdraw a standing invitation, so the printed code stops resolving.
 *
 * This is the only control a practice has over a code that has already left the building, and it
 * takes effect on the next scan rather than on the links already open: a grant minted a minute ago
 * is still good for its hour, because the facade checks the child invitation, which is unaffected.
 * That window is the price of minting grants per fetch and storing none.
 *
 * Guarded on `revokedAt IS NULL` so a second revoke does not move the time it happened.
 * @param db the database
 * @param id the standing invitation id
 * @param issuer the FHIR base of the revoking session, so one practice cannot revoke another's
 * @param now current time in epoch seconds, injectable for tests
 * @returns true when this call withdrew it, false when it was unknown or already withdrawn
 * @example
 * if (!revokeStandingInvitation(db, id, session.issuer)) return reply.code(404).send(...);
 */
export function revokeStandingInvitation(
  db: AppDatabase,
  id: string,
  issuer: string,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const result = db
    .prepare(
      `UPDATE standingInvitations SET revokedAt = ?
       WHERE id = ? AND issuer = ? AND revokedAt IS NULL`,
    )
    .run(now, id, issuer);
  return result.changes === 1;
}

/**
 * Replace the sealed payload of a live standing invitation, keeping everything else.
 *
 * This is what lets a printed code serve a newer copy of its form. The id and the key are the two
 * halves of the printed link, and neither is touched, so the QR on the wall stays valid and its
 * next scan gets the new payload.
 *
 * Guarded on the payload the caller read, so two refreshes racing each other cannot interleave a
 * read of one with a write of the other, and on `revokedAt IS NULL` so a withdrawn code stays
 * exactly as it was withdrawn.
 * @param db the database
 * @param id the standing invitation id
 * @param issuer the FHIR base of the refreshing session, so one practice cannot touch another's
 * @param expected the payload the caller read and re-sealed from
 * @param replacement the new payload, sealed with the same key
 * @returns true when this call replaced it, false when it was unknown, withdrawn or changed since
 * @example
 * if (!replaceStandingInvitationPayload(db, id, issuer, row.payloadCiphertext, next)) ...
 */
export function replaceStandingInvitationPayload(
  db: AppDatabase,
  id: string,
  issuer: string,
  expected: string,
  replacement: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE standingInvitations SET payloadCiphertext = ?
       WHERE id = ? AND issuer = ? AND payloadCiphertext = ? AND revokedAt IS NULL`,
    )
    .run(replacement, id, issuer, expected);
  return result.changes === 1;
}

/**
 * How many scans one standing invitation has minted since a moment.
 *
 * The scan cap is built on this. A printed code is public by construction - the whole point is
 * that anyone may scan it - so the only thing standing between a photographed poster and an
 * unbounded number of rows is a ceiling on how fast they can be minted.
 * @param db the database
 * @param standingId the standing invitation
 * @param since epoch seconds; scans minted at or after this instant are counted
 * @returns the count
 * @example
 * const recent = countRecentScans(db, standing.id, now - 3600);
 */
export function countRecentScans(
  db: AppDatabase,
  standingId: string,
  since: number,
): number {
  const row = db
    .prepare<[string, number], { count: number }>(
      `SELECT count(*) AS count FROM invitations
       WHERE standingId = ? AND createdAt >= ?`,
    )
    .get(standingId, since);
  return row?.count ?? 0;
}

/**
 * Remove standing invitations whose lifetime has passed.
 *
 * Their children are left alone deliberately. A child holds the reference to answers that already
 * reached the practice, and deleting it would not unsend them - it would only lose the record that
 * this app forwarded them.
 * @param db the database
 * @param now current time in epoch seconds, injectable for tests
 * @returns how many rows were removed
 * @example
 * deleteExpiredStandingInvitations(db);
 */
export function deleteExpiredStandingInvitations(
  db: AppDatabase,
  now: number = Math.floor(Date.now() / 1000),
): number {
  return db
    .prepare(
      `DELETE FROM standingInvitations WHERE expiresAt IS NOT NULL AND expiresAt <= ?`,
    )
    .run(now).changes;
}
