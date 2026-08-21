/**
 * Session rows: the requester's launch state, keyed by an opaque cookie value.
 *
 * The state machine is the one in data-model.md:
 *
 * ```text
 * createPendingSession ──> pending ──activateSession──> active ──> expired ──> deleted
 *                             │                                        │
 *                             └── ten minutes ─────────────────────────┘
 *                                    purgeExpiredSessions
 * ```
 *
 * A pending row exists only between issuing the authorize redirect and completing the code
 * exchange, so it dies ten minutes later whether or not the user came back. An active row is
 * "expired" once its access token has passed its expiry with no refresh token to rescue it;
 * `findActiveSession` reports that as absent, which is what the API surface needs.
 *
 * Tokens live in this table and nowhere else. No function here returns a row to a route that
 * serialises it - callers pick the fields they are allowed to disclose.
 * @author John Grimes
 */

import { randomBytes } from "node:crypto";

import type { AppDatabase } from "./db";

/** How long an unfinished authorize redirect stays resumable. */
export const PENDING_SESSION_TTL_SECONDS = 600;

/** Bytes of entropy in a session id: 128 bits, per data-model.md. */
const SESSION_ID_BYTES = 16;

/** A session between the authorize redirect and the code exchange. */
export interface PendingSession {
  /** Opaque session id; also the cookie value once the session is active. */
  readonly id: string;
  /** Issuer the launch is against. */
  readonly issuer: string;
  /** The `state` parameter sent to the authorization endpoint. */
  readonly state: string;
  /** The PKCE code verifier whose challenge was sent. */
  readonly verifier: string;
  /** When the pending session was opened, in epoch seconds. */
  readonly createdAt: number;
}

/** A session holding a launch token. */
export interface ActiveSession {
  /** Opaque session id, carried by the cookie. */
  readonly id: string;
  /** Issuer the token is for. */
  readonly issuer: string;
  /** Launch access token. Never leaves the server. */
  readonly accessToken: string;
  /** Access token expiry, in epoch seconds. */
  readonly accessTokenExpiresAt: number;
  /** Refresh token, when one was granted. */
  readonly refreshToken: string | null;
  /** Launch context patient, when the launch carried one. */
  readonly patientId: string | null;
  /** Display name for `Task.requester.display`, when known. */
  readonly userDisplay: string | null;
  /** When the session was opened, in epoch seconds. */
  readonly createdAt: number;
}

/** Fields needed to open a pending session. */
export interface PendingSessionInput {
  /** Issuer the launch is against. */
  readonly issuer: string;
  /** The `state` parameter being sent to the authorization endpoint. */
  readonly state: string;
  /** The PKCE code verifier. */
  readonly verifier: string;
}

/** Fields captured when a code exchange succeeds. */
export interface SessionActivation {
  /** Id of the pending session being promoted. */
  readonly id: string;
  /** Launch access token from the token response. */
  readonly accessToken: string;
  /** Absolute expiry derived from `expires_in`, in epoch seconds. */
  readonly accessTokenExpiresAt: number;
  /** Refresh token, when granted. */
  readonly refreshToken?: string | null;
  /** Launch context patient, when present. */
  readonly patientId?: string | null;
  /** Display name derived from `fhirUser` or the ID token, when available. */
  readonly userDisplay?: string | null;
}

/** Fields replaced when a refresh succeeds. */
export interface SessionTokenUpdate {
  /** Id of the active session being updated. */
  readonly id: string;
  /** The new access token. */
  readonly accessToken: string;
  /** Absolute expiry derived from the new `expires_in`, in epoch seconds. */
  readonly accessTokenExpiresAt: number;
  /** The refresh token to keep: the rotated one, or the existing one when none was returned. */
  readonly refreshToken: string | null;
}

/**
 * A pending row as stored. The `CHECK` constraint in the schema guarantees `state` and
 * `verifier` are set on any row with `status = 'pending'`.
 */
interface PendingRow {
  id: string;
  issuer: string;
  state: string;
  verifier: string;
  createdAt: number;
}

/**
 * An active row as stored. The `CHECK` constraint guarantees `accessToken` and
 * `accessTokenExpiresAt` are set on any row with `status = 'active'`.
 */
interface ActiveRow {
  id: string;
  issuer: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string | null;
  patientId: string | null;
  userDisplay: string | null;
  createdAt: number;
}

/**
 * Current time in epoch seconds, the unit every timestamp in this module uses.
 * @returns the current time in epoch seconds
 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Open a pending session, holding the PKCE verifier and `state` until the callback arrives.
 * @param db the database
 * @param input the issuer, `state` and PKCE verifier for this launch
 * @param now current time in epoch seconds, injectable for tests
 * @returns the created pending session, including its freshly minted id
 * @throws {Error} when the `state` parameter is already in use
 * @example
 * const pending = createPendingSession(db, { issuer, state, verifier });
 */
export function createPendingSession(
  db: AppDatabase,
  input: PendingSessionInput,
  now: number = nowSeconds(),
): PendingSession {
  const id = randomBytes(SESSION_ID_BYTES).toString("base64url");
  db.prepare(
    `INSERT INTO sessions (id, status, issuer, state, verifier, createdAt)
     VALUES (?, 'pending', ?, ?, ?, ?)`,
  ).run(id, input.issuer, input.state, input.verifier, now);
  return {
    id,
    issuer: input.issuer,
    state: input.state,
    verifier: input.verifier,
    createdAt: now,
  };
}

/**
 * Find the pending session a callback's `state` belongs to.
 *
 * A pending session older than {@link PENDING_SESSION_TTL_SECONDS} is reported as absent, so a
 * stale authorize redirect cannot be completed later.
 * @param db the database
 * @param state the `state` parameter returned by the authorization server
 * @param now current time in epoch seconds, injectable for tests
 * @returns the pending session, or undefined when unknown or expired
 */
export function findPendingSessionByState(
  db: AppDatabase,
  state: string,
  now: number = nowSeconds(),
): PendingSession | undefined {
  const row = db
    .prepare<[string], PendingRow>(
      `SELECT id, issuer, state, verifier, createdAt
       FROM sessions WHERE status = 'pending' AND state = ?`,
    )
    .get(state);
  if (row === undefined || row.createdAt + PENDING_SESSION_TTL_SECONDS <= now) {
    return undefined;
  }
  return row;
}

/**
 * Promote a pending session to active, recording the exchanged tokens and launch context.
 *
 * The `state` and PKCE verifier are cleared in the same statement, so a replayed authorization
 * code finds nothing to exchange against.
 * @param db the database
 * @param activation the tokens and context captured from the exchange
 * @returns the resulting active session
 * @throws {Error} naming the id when there is no pending session to promote
 * @example
 * const session = activateSession(db, { id, accessToken, accessTokenExpiresAt });
 */
export function activateSession(
  db: AppDatabase,
  activation: SessionActivation,
): ActiveSession {
  const result = db
    .prepare(
      `UPDATE sessions
       SET status = 'active', state = NULL, verifier = NULL,
           accessToken = ?, accessTokenExpiresAt = ?, refreshToken = ?,
           patientId = ?, userDisplay = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(
      activation.accessToken,
      activation.accessTokenExpiresAt,
      activation.refreshToken ?? null,
      activation.patientId ?? null,
      activation.userDisplay ?? null,
      activation.id,
    );
  if (result.changes === 0) {
    throw new Error(
      `Cannot activate session ${activation.id}: no pending session with that id`,
    );
  }
  const row = db
    .prepare<[string], ActiveRow>(
      `SELECT id, issuer, accessToken, accessTokenExpiresAt, refreshToken,
              patientId, userDisplay, createdAt
       FROM sessions WHERE id = ? AND status = 'active'`,
    )
    .get(activation.id);
  if (row === undefined) {
    throw new Error(`Session ${activation.id} vanished during activation`);
  }
  return row;
}

/**
 * Read an active session by id without applying the expiry rule.
 *
 * The FHIR proxy needs this: to decide between "your session has expired" and "you have no
 * session", it has to be able to see a row whose token has run out. Every other caller wants
 * {@link findActiveSession}, which hides those rows.
 * @param db the database
 * @param id the session id from the cookie
 * @returns the active session as stored, or undefined when there is no active row with that id
 */
export function findActiveSessionIgnoringExpiry(
  db: AppDatabase,
  id: string,
): ActiveSession | undefined {
  return db
    .prepare<[string], ActiveRow>(
      `SELECT id, issuer, accessToken, accessTokenExpiresAt, refreshToken,
              patientId, userDisplay, createdAt
       FROM sessions WHERE status = 'active' AND id = ?`,
    )
    .get(id);
}

/**
 * Read an active session by id.
 *
 * An active row whose access token has expired is only reported when a refresh token remains:
 * expiry with nothing to refresh with is the `expired` state, which callers must treat exactly
 * like an unknown session.
 * @param db the database
 * @param id the session id from the cookie
 * @param now current time in epoch seconds, injectable for tests
 * @returns the active session, or undefined when unknown, still pending, or expired
 */
export function findActiveSession(
  db: AppDatabase,
  id: string,
  now: number = nowSeconds(),
): ActiveSession | undefined {
  const row = findActiveSessionIgnoringExpiry(db, id);
  if (row === undefined) {
    return undefined;
  }
  if (row.accessTokenExpiresAt <= now && row.refreshToken === null) {
    return undefined;
  }
  return row;
}

/**
 * Replace an active session's tokens after a refresh.
 *
 * A refresh response need not carry a new refresh token; when it does not, the caller passes
 * the one it already had, because losing it would strand the session at the next expiry.
 * @param db the database
 * @param update the session id, the new access token, its absolute expiry and the refresh token
 *   to keep
 * @returns the updated session
 * @throws {Error} naming the id when there is no active session to update
 * @example
 * const session = updateSessionTokens(db, {
 *   id, accessToken, accessTokenExpiresAt, refreshToken: token.refreshToken ?? session.refreshToken,
 * });
 */
export function updateSessionTokens(
  db: AppDatabase,
  update: SessionTokenUpdate,
): ActiveSession {
  const result = db
    .prepare(
      `UPDATE sessions
       SET accessToken = ?, accessTokenExpiresAt = ?, refreshToken = ?
       WHERE id = ? AND status = 'active'`,
    )
    .run(
      update.accessToken,
      update.accessTokenExpiresAt,
      update.refreshToken,
      update.id,
    );
  if (result.changes === 0) {
    throw new Error(
      `Cannot update session ${update.id}: no active session with that id`,
    );
  }
  const row = findActiveSessionIgnoringExpiry(db, update.id);
  if (row === undefined) {
    throw new Error(`Session ${update.id} vanished during a token update`);
  }
  return row;
}

/**
 * Delete a session, whatever state it is in.
 * @param db the database
 * @param id the session id
 * @returns true when a row was deleted, false when there was nothing to delete
 */
export function deleteSession(db: AppDatabase, id: string): boolean {
  return db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
}

/**
 * Delete every session that can no longer be used: abandoned pending rows, and active rows
 * whose token has expired with no refresh token.
 * @param db the database
 * @param now current time in epoch seconds, injectable for tests
 * @returns the number of rows deleted
 * @example
 * setInterval(() => purgeExpiredSessions(db), 60_000);
 */
export function purgeExpiredSessions(
  db: AppDatabase,
  now: number = nowSeconds(),
): number {
  return db
    .prepare(
      `DELETE FROM sessions
       WHERE (status = 'pending' AND createdAt + ? <= ?)
          OR (status = 'active' AND refreshToken IS NULL AND accessTokenExpiresAt <= ?)`,
    )
    .run(PENDING_SESSION_TTL_SECONDS, now, now).changes;
}
