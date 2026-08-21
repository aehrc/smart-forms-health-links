/**
 * SQLite connection and schema.
 *
 * One file holds both tables described in data-model.md: `sessions` (the requester's launch
 * sessions) and `invitations` (the hosted SHL payloads). Minted access tokens are never
 * written here - they exist only for the duration of a manifest response (FR-018).
 *
 * Column names are the camelCase field names of the TypeScript row types, so a row maps
 * straight onto its interface with no translation layer.
 * @author John Grimes
 */

import Database from "better-sqlite3";

/** The database handle threaded through every row function. */
export type AppDatabase = Database.Database;

/**
 * The whole schema, written so that re-applying it to an existing database is a no-op.
 *
 * The `CHECK` constraints encode the session state machine: a pending row must carry the PKCE
 * material needed to finish the exchange, and an active row must carry a token and its expiry.
 * The partial unique index on `state` makes a replayed `state` parameter impossible to insert
 * twice while leaving active rows (whose `state` is cleared) unconstrained.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  issuer               TEXT NOT NULL,
  state                TEXT,
  verifier             TEXT,
  accessToken          TEXT,
  accessTokenExpiresAt INTEGER,
  refreshToken         TEXT,
  patientId            TEXT,
  userDisplay          TEXT,
  createdAt            INTEGER NOT NULL,
  CHECK (
    (status = 'pending' AND state IS NOT NULL AND verifier IS NOT NULL)
    OR
    (status = 'active' AND accessToken IS NOT NULL AND accessTokenExpiresAt IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_state
  ON sessions (state) WHERE state IS NOT NULL;

CREATE TABLE IF NOT EXISTS invitations (
  id                TEXT PRIMARY KEY,
  linkKey           TEXT NOT NULL,
  payloadCiphertext TEXT NOT NULL,
  label             TEXT NOT NULL,
  expiresAt         INTEGER,
  issuer            TEXT NOT NULL,
  patientId         TEXT,
  requestIdentifier TEXT NOT NULL,
  publishedTaskUrl  TEXT NOT NULL,
  createdAt         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS invitations_expiresAt ON invitations (expiresAt);
`;

/**
 * Apply the schema. Safe to call on an already-migrated database.
 * @param db an open database
 * @example
 * migrateSchema(db); // idempotent
 */
export function migrateSchema(db: AppDatabase): void {
  db.exec(SCHEMA);
}

/**
 * Open the database file, set the pragmas the app relies on, and migrate.
 *
 * Write-ahead logging keeps a manifest fetch from blocking on a concurrent session write, and
 * `foreign_keys` is enabled so that any future relation is enforced rather than advisory.
 * @param sqlitePath path of the database file; `:memory:` for an ephemeral database
 * @returns the open, migrated handle
 * @throws {Error} when the file cannot be opened or created
 * @example
 * const db = openDatabase("/var/lib/shl/app.db");
 */
export function openDatabase(sqlitePath: string): AppDatabase {
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrateSchema(db);
  return db;
}
