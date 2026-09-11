/**
 * Invitation rows: the hosted payload behind a `shlink:/` URL.
 *
 * A row is written at mint time and read on every manifest fetch and every facade call. The
 * link key is kept because the grant file has to be encrypted under it at fetch time, long
 * after minting (research.md, "Token minting timing").
 *
 * Two of its columns are written after minting rather than at it. `respondedAt` and
 * `responseReference` carry the at-most-one-response rule, which lives here rather than in
 * either filler: two different fillers stamp two different identifier systems, so the only
 * place that can hold the rule for both of them is the server they both write through.
 *
 * The read deliberately collapses two cases into one: an id that never existed and an id whose
 * invitation has expired both come back as `undefined`. That is what stops `POST /shl/:id`
 * becoming an oracle for which links were ever minted (contracts/http-api.md - unknown and
 * expired return an identical 404).
 * @author John Grimes
 */

import { randomBytes } from "node:crypto";

import type { AppDatabase } from "../db";

/** Bytes of entropy in an invitation id. */
const INVITATION_ID_BYTES = 16;

/** Fields written when an invitation is minted. */
export interface InvitationInput {
  /** 256-bit base64url JWE key shared with the link holder. */
  readonly linkKey: string;
  /** JWE of the invitation Bundle, encrypted once at mint time. */
  readonly payloadCiphertext: string;
  /** SHL label, normally the questionnaire title. */
  readonly label: string;
  /** Link expiry in epoch seconds, or null for a link that never expires. */
  readonly expiresAt: number | null;
  /** Issuer of the minting session; also the grant's `aud` base. */
  readonly issuer: string;
  /** Destination patient for the grant's `patient` property, when the request named one. */
  readonly patientId: string | null;
  /** Durable `urn:uuid:` correlation key, also the conditional-create key. */
  readonly requestIdentifier: string;
  /** Absolute URL of the Task published on the issuer. */
  readonly publishedTaskUrl: string;
  /**
   * Canonical URL of the questionnaire this invitation asks for, or null when it declared none.
   *
   * Captured at mint time so the facade can refuse answers to a different form without
   * decrypting the payload on every write. Null for rows written before the column existed;
   * {@link findInvitation} returns them unchanged and the facade falls back to the payload.
   */
  readonly questionnaireCanonical: string | null;
}

/** A stored invitation. */
export interface Invitation extends InvitationInput {
  /** Random base64url id; appears in the manifest URL path. */
  readonly id: string;
  /** When the invitation was minted, in epoch seconds. */
  readonly createdAt: number;
  /**
   * When a send claimed this invitation, in epoch seconds, or null while it is unanswered.
   *
   * Set before the upstream write and cleared if that write fails, so it means "a send is in
   * flight or has succeeded" rather than "answers exist". {@link responseReference} is what
   * distinguishes the two.
   */
  readonly respondedAt: number | null;
  /**
   * Relative reference to the QuestionnaireResponse the upstream server created, or null.
   *
   * Present only once a forward has succeeded. A replayed send reads this and answers from it
   * rather than writing again.
   */
  readonly responseReference: string | null;
}

/**
 * Store a freshly minted invitation.
 * @param db the database
 * @param input the invitation fields
 * @param now current time in epoch seconds, injectable for tests
 * @returns the stored invitation, including its minted id
 * @example
 * const invitation = insertInvitation(db, { linkKey, payloadCiphertext, ... });
 */
export function insertInvitation(
  db: AppDatabase,
  input: InvitationInput,
  now: number = Math.floor(Date.now() / 1000),
): Invitation {
  const id = randomBytes(INVITATION_ID_BYTES).toString("base64url");
  db.prepare(
    `INSERT INTO invitations (id, linkKey, payloadCiphertext, label, expiresAt, issuer,
                              patientId, requestIdentifier, publishedTaskUrl,
                              questionnaireCanonical, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.linkKey,
    input.payloadCiphertext,
    input.label,
    input.expiresAt,
    input.issuer,
    input.patientId,
    input.requestIdentifier,
    input.publishedTaskUrl,
    input.questionnaireCanonical,
    now,
  );
  return {
    ...input,
    id,
    createdAt: now,
    respondedAt: null,
    responseReference: null,
  };
}

/**
 * Read an invitation that is still within its lifetime.
 *
 * An expired invitation is reported exactly as an unknown one, so that a caller cannot learn
 * whether an id was ever minted. (Timing side channels are out of scope: the expiry check runs
 * after the same single indexed lookup in both cases.)
 * @param db the database
 * @param id the invitation id from the manifest URL
 * @param now current time in epoch seconds, injectable for tests
 * @returns the invitation, or undefined when unknown or expired
 * @example
 * const invitation = findInvitation(db, request.params.id);
 * if (invitation === undefined) return reply.code(404).send({ error: "not-found" });
 */
export function findInvitation(
  db: AppDatabase,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
): Invitation | undefined {
  const row = db
    .prepare<[string], Invitation>(
      `SELECT id, linkKey, payloadCiphertext, label, expiresAt, issuer, patientId,
              requestIdentifier, publishedTaskUrl, questionnaireCanonical,
              respondedAt, responseReference, createdAt
       FROM invitations WHERE id = ?`,
    )
    .get(id);
  if (row === undefined || (row.expiresAt !== null && row.expiresAt <= now)) {
    return undefined;
  }
  return row;
}

/**
 * Claim an invitation for a send, so that only one send can be in flight or succeed.
 *
 * The whole rule is the `WHERE` clause: a single conditional `UPDATE` is atomic, so two
 * concurrent sends cannot both see an unclaimed row. This is the same shape
 * `writeToSlot` uses, and for the same reason - a read followed by a write would let both
 * fillers through the gap between them.
 *
 * A claim is not proof that answers exist. It is released again when the upstream write
 * fails ({@link releaseInvitationResponseClaim}), because one bad gateway must not burn an
 * invitation permanently.
 * @param db the database
 * @param id the invitation id
 * @param now current time in epoch seconds, injectable for tests
 * @returns true when this call took the claim, false when a send already holds it
 * @example
 * if (!claimInvitationResponse(db, id)) return alreadyAnsweredOrInFlight(invitation);
 */
export function claimInvitationResponse(
  db: AppDatabase,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const result = db
    .prepare(
      `UPDATE invitations SET respondedAt = ?
       WHERE id = ? AND respondedAt IS NULL`,
    )
    .run(now, id);
  return result.changes === 1;
}

/**
 * Record where the upstream server put the answers, completing a claim.
 * @param db the database
 * @param id the invitation id
 * @param reference relative reference to the created response, e.g. `QuestionnaireResponse/1`
 * @example
 * recordInvitationResponse(db, invitation.id, "QuestionnaireResponse/123");
 */
export function recordInvitationResponse(
  db: AppDatabase,
  id: string,
  reference: string,
): void {
  db.prepare(`UPDATE invitations SET responseReference = ? WHERE id = ?`).run(
    reference,
    id,
  );
}

/**
 * Release a claim whose upstream write did not succeed.
 *
 * Guarded on `responseReference IS NULL` so that a late failure path can never unpick a
 * forward that actually landed.
 * @param db the database
 * @param id the invitation id
 * @example
 * releaseInvitationResponseClaim(db, invitation.id); // upstream refused; let them retry
 */
export function releaseInvitationResponseClaim(
  db: AppDatabase,
  id: string,
): void {
  db.prepare(
    `UPDATE invitations SET respondedAt = NULL
     WHERE id = ? AND responseReference IS NULL`,
  ).run(id);
}
