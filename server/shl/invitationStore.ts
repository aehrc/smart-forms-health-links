/**
 * Invitation rows: the hosted payload behind a `shlink:/` URL.
 *
 * A row is written once, at mint time, and read once per manifest fetch. The link key is kept
 * because the grant file has to be encrypted under it at fetch time, long after minting
 * (research.md, "Token minting timing").
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
}

/** A stored invitation. */
export interface Invitation extends InvitationInput {
  /** Random base64url id; appears in the manifest URL path. */
  readonly id: string;
  /** When the invitation was minted, in epoch seconds. */
  readonly createdAt: number;
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
                              patientId, requestIdentifier, publishedTaskUrl, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now,
  );
  return { ...input, id, createdAt: now };
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
              requestIdentifier, publishedTaskUrl, createdAt
       FROM invitations WHERE id = ?`,
    )
    .get(id);
  if (row === undefined || (row.expiresAt !== null && row.expiresAt <= now)) {
    return undefined;
  }
  return row;
}
