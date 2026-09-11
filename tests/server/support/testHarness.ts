/**
 * Shared fixtures for the BFF route tests.
 *
 * Every route test needs the same three things: a configuration with a registered issuer whose
 * credentials are distinctive enough that a leak assertion can look for them, an open database,
 * and a Fastify instance built over both. Building that once here keeps each test file to the
 * behaviour it is actually about.
 *
 * The harness captures log output rather than silencing it, because "no log line contains a
 * secret, a code or a token" is one of the properties under test (FR-018 and the invariants in
 * `contracts/http-api.md`).
 * @author John Grimes
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDatabase } from "../../../server/db";
import { buildServer } from "../../../server/index";
import { clearSmartConfigurationCache } from "../../../server/smart/discovery";

import type { ServerConfig } from "../../../server/config";
import type { AppDatabase } from "../../../server/db";
import type { FastifyInstance } from "fastify";

/** Origin the app is served from, and therefore the origin of the redirect URI. */
export const APP_ORIGIN = "https://app.example.org";

/** The redirect URI every authorize request and code exchange must use. */
export const REDIRECT_URI = "https://app.example.org/auth/callback";

/**
 * The session cookie secret the test configuration uses.
 *
 * Exported because grant tokens are signed with a key derived from it, so a test that wants to
 * verify one has to derive the same key rather than guess at it.
 */
export const COOKIE_SECRET = "0123456789abcdef0123456789abcdef";

/** The primary registered issuer. */
export const ISSUER = "https://ehr.example.org/fhir";

/** Its label, as the session and issuer-list routes must report it. */
export const ISSUER_LABEL = "Example EHR";

/** Its confidential launch client id. */
export const LAUNCH_CLIENT_ID = "launch-client";

/** Its launch client secret. Distinctive so leak assertions have something to look for. */
export const LAUNCH_CLIENT_SECRET = "launch-secret-never-logged";

/** The scopes the registry asks for, including the EHR-launch-only `launch/patient`. */
export const LAUNCH_SCOPES =
  "openid fhirUser launch launch/patient online_access user/*.cruds";

/** Where the primary issuer's SMART configuration points the browser. */
export const AUTHORIZATION_ENDPOINT = "https://ehr.example.org/auth/authorize";

/** Where the primary issuer's codes are exchanged and refreshes are made. */
export const TOKEN_ENDPOINT = "https://ehr.example.org/auth/token";

/**
 * A second registered issuer whose client id and secret contain the characters RFC 6749
 * section 2.3.1 requires to be form-urlencoded before they are Basic-encoded.
 */
export const AWKWARD_ISSUER = "https://other.example.org/fhir";

/** Label of the second issuer. */
export const AWKWARD_ISSUER_LABEL = "Awkward Credentials Clinic";

/** A client id containing a space. */
export const AWKWARD_CLIENT_ID = "launch client";

/** A client secret containing a colon, a space and an ampersand. */
export const AWKWARD_CLIENT_SECRET = "sec:ret pass&word";

/** The second issuer's token endpoint. */
export const AWKWARD_TOKEN_ENDPOINT = "https://other.example.org/auth/token";

/** A fake private exponent, so JWKS and body leak assertions have a needle. */
export const FAKE_PRIVATE_EXPONENT = "fake-private-exponent-do-not-log";

/** The primary issuer's SMART configuration document, as it arrives on the wire. */
export const SMART_CONFIGURATION = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  capabilities: [
    "launch-ehr",
    "launch-standalone",
    "client-confidential-symmetric",
  ],
};

/** The second issuer's SMART configuration document. */
export const AWKWARD_SMART_CONFIGURATION = {
  issuer: AWKWARD_ISSUER,
  authorization_endpoint: "https://other.example.org/auth/authorize",
  token_endpoint: AWKWARD_TOKEN_ENDPOINT,
};

/** What a harness hands back to a test. */
export interface TestHarness {
  /** The built server, ready for `inject`. */
  readonly server: FastifyInstance;
  /** The open database, for asserting on stored rows. */
  readonly db: AppDatabase;
  /** The configuration the server was built with. */
  readonly config: ServerConfig;
  /** Every log line the server emitted, as serialised JSON. */
  readonly logLines: string[];
  /** The temporary directory holding the database file. */
  readonly directory: string;
}

/**
 * Build the test configuration.
 * @param sqlitePath path of the database file
 * @returns a configuration registering {@link ISSUER} and {@link AWKWARD_ISSUER}
 */
export function testConfig(sqlitePath: string): ServerConfig {
  return {
    appOrigin: APP_ORIGIN,
    sqlitePath,
    issuerRegistryPath: "/dev/null",
    cookieSecret: COOKIE_SECRET,
    port: 3000,
    issuers: [
      {
        issuer: ISSUER,
        label: ISSUER_LABEL,
        launchClient: {
          clientId: LAUNCH_CLIENT_ID,
          clientSecret: LAUNCH_CLIENT_SECRET,
          scopes: LAUNCH_SCOPES,
        },
        backendClient: {
          clientId: "backend-client",
          privateKeyJwk: {
            kty: "RSA",
            kid: "backend-key-1",
            n: "public-modulus",
            e: "AQAB",
            d: FAKE_PRIVATE_EXPONENT,
          },
          scopes: "system/QuestionnaireResponse.c system/Task.r system/Task.u",
        },
        grantTtlSeconds: 3600,
      },
      {
        issuer: AWKWARD_ISSUER,
        label: AWKWARD_ISSUER_LABEL,
        launchClient: {
          clientId: AWKWARD_CLIENT_ID,
          clientSecret: AWKWARD_CLIENT_SECRET,
          scopes: "openid fhirUser launch launch/patient user/*.cruds",
        },
        backendClient: {
          clientId: "other-backend-client",
          privateKeyJwk: {
            kty: "RSA",
            kid: "backend-key-2",
            n: "other-public-modulus",
            e: "AQAB",
            d: FAKE_PRIVATE_EXPONENT,
          },
          scopes: "system/QuestionnaireResponse.c system/Task.r system/Task.u",
        },
        grantTtlSeconds: 900,
      },
    ],
  };
}

/**
 * Stand up a database and a server over it, capturing the log.
 *
 * The discovery cache is cleared, because it is process-wide and would otherwise carry a stub
 * response from one test into the next.
 * @returns the harness
 * @example
 * const harness = createHarness();
 * const response = await harness.server.inject({ method: "GET", url: "/api/issuers" });
 */
export function createHarness(): TestHarness {
  clearSmartConfigurationCache();
  const directory = mkdtempSync(path.join(tmpdir(), "shl-routes-"));
  const sqlitePath = path.join(directory, "app.db");
  const db = openDatabase(sqlitePath);
  const config = testConfig(sqlitePath);
  const logLines: string[] = [];
  const server = buildServer({
    config,
    db,
    // No built SPA: these tests are about the API surface, and the fallback is covered by
    // `tests/server/index.test.ts`.
    staticRoot: path.join(directory, "absent-dist"),
    logger: {
      level: "trace",
      stream: {
        write(line: string) {
          logLines.push(line);
        },
      },
    },
  });
  return { server, db, config, logLines, directory };
}

/**
 * Close the server and database and remove the temporary directory.
 * @param harness the harness to dispose of
 * @returns nothing; resolves once the server is closed
 */
export async function closeHarness(harness: TestHarness): Promise<void> {
  await harness.server.close();
  harness.db.close();
  rmSync(harness.directory, { recursive: true, force: true });
}

/**
 * Build a JSON response the way a SMART server would.
 * @param body the document to serialise
 * @param status the HTTP status, defaulting to 200
 * @returns the response
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Read the request URL out of a `fetch` call's arguments.
 * @param input the first argument `fetch` was called with
 * @returns the URL as a string
 */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * Count the sessions currently stored, by status.
 * @param db the database
 * @returns the number of rows in the `sessions` table
 */
export function sessionCount(db: AppDatabase): number {
  return (
    db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM sessions")
      .get()?.count ?? 0
  );
}
