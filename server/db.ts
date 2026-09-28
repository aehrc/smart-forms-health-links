/**
 * SQLite connection and schema.
 *
 * One file holds the tables described in data-model.md: `sessions` (the requester's launch
 * sessions) and `invitations` (the hosted SHL payloads), plus the two that were added after it -
 * `writeSlots` (channel D) and `standingInvitations` (the walk-in QR a practice prints once).
 * Minted access tokens are never written here - they exist only for the duration of a manifest
 * response (FR-018).
 *
 * `standingInvitations` is a table of its own rather than a flag on `invitations`, and that is
 * load-bearing rather than tidy. A standing row is not writable: it is the thing scans are minted
 * from*, never the thing answers are written *to*. Keeping it out of `invitations` means
 * `findInvitation` cannot return one, so the facade refuses `/shl/{standingId}/fhir` with the 404
 * it gives any unknown id, without a guard that somebody could later forget to write.
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
  fhirUser             TEXT,
  grantedScopes        TEXT,
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
  id                     TEXT PRIMARY KEY,
  linkKey                TEXT NOT NULL,
  payloadCiphertext      TEXT NOT NULL,
  label                  TEXT NOT NULL,
  expiresAt              INTEGER,
  issuer                 TEXT NOT NULL,
  patientId              TEXT,
  requestIdentifier      TEXT NOT NULL,
  publishedTaskUrl       TEXT NOT NULL,
  questionnaireCanonical TEXT,
  respondedAt            INTEGER,
  responseReference      TEXT,
  createdAt              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS invitations_expiresAt ON invitations (expiresAt);

CREATE TABLE IF NOT EXISTS writeSlots (
  id           TEXT PRIMARY KEY,
  writeToken   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in-progress', 'completed')),
  content      TEXT NOT NULL,
  expiresAt    INTEGER,
  createdAt    INTEGER NOT NULL,
  completedAt  INTEGER
);

CREATE INDEX IF NOT EXISTS writeSlots_expiresAt ON writeSlots (expiresAt);

CREATE TABLE IF NOT EXISTS standingInvitations (
  id                     TEXT PRIMARY KEY,
  linkKey                TEXT NOT NULL,
  payloadCiphertext      TEXT NOT NULL,
  label                  TEXT NOT NULL,
  expiresAt              INTEGER,
  issuer                 TEXT NOT NULL,
  requestIdentifier      TEXT NOT NULL,
  publishedTaskUrl       TEXT NOT NULL,
  questionnaireCanonical TEXT,
  revokedAt              INTEGER,
  createdAt              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS standingInvitations_expiresAt
  ON standingInvitations (expiresAt);
`;

/**
 * Columns added after the first schema was written.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a column added
 * later has to be added explicitly. Applied one at a time and tolerantly: SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and the only reason the statement can fail here is that the column
 * is already there, which is the state we wanted.
 */
const ADDED_COLUMNS: readonly string[] = [
  "ALTER TABLE sessions ADD COLUMN fhirUser TEXT",
  "ALTER TABLE sessions ADD COLUMN grantedScopes TEXT",
  "ALTER TABLE invitations ADD COLUMN questionnaireCanonical TEXT",
  "ALTER TABLE invitations ADD COLUMN respondedAt INTEGER",
  "ALTER TABLE invitations ADD COLUMN responseReference TEXT",
  "ALTER TABLE invitations ADD COLUMN standingId TEXT",
  "CREATE INDEX IF NOT EXISTS invitations_standingId ON invitations (standingId)",
];

/**
 * Apply the schema. Safe to call on an already-migrated database.
 * @param db an open database
 * @example
 * migrateSchema(db); // idempotent
 */
export function migrateSchema(db: AppDatabase): void {
  db.exec(SCHEMA);
  for (const statement of ADDED_COLUMNS) {
    try {
      db.exec(statement);
    } catch {
      // The column is already present, which is the only outcome this can have on a database
      // the current schema already created.
    }
  }
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
