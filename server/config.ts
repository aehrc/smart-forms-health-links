/**
 * Process configuration and the issuer registry.
 *
 * Two things are loaded here, both at startup and never again:
 *
 *  1. Process settings, from the environment (`APP_ORIGIN`, `SQLITE_PATH`,
 *     `ISSUER_REGISTRY_PATH`, `SESSION_COOKIE_SECRET`, optional `PORT`).
 *  2. The issuer registry, from the JSON file named by `ISSUER_REGISTRY_PATH`. One entry per
 *     FHIR server this deployment is permitted to launch against, per data-model.md.
 *
 * ## Registry file format
 *
 * A JSON array of entries:
 *
 * ```json
 * [
 *   {
 *     "issuer": "https://kuzfdswqmz.edge.aidbox.app/fhir",
 *     "label": "Aidbox demo",
 *     "launchClient": {
 *       "clientId": "smart-forms-launch",
 *       "clientSecret": "env:LAUNCH_CLIENT_SECRET",
 *       "scopes": "openid fhirUser launch launch/patient online_access ..."
 *     },
 *     "backendClient": {
 *       "clientId": "smart-forms-backend",
 *       "privateKeyJwk": "env:BACKEND_PRIVATE_JWK",
 *       "scopes": "system/QuestionnaireResponse.c system/Provenance.c system/Task.r system/Task.u"
 *     },
 *     "grantTtlSeconds": 3600
 *   }
 * ]
 * ```
 *
 * ## Environment references
 *
 * Secret-bearing fields (`launchClient.clientSecret`, `backendClient.privateKeyJwk`) are never
 * written inline. They hold an *environment reference*: the literal prefix `env:` followed by
 * an environment variable name, for example `"env:LAUNCH_CLIENT_SECRET"`. The variable's value
 * is substituted at load time - a client secret verbatim, a private JWK as JSON text. That way
 * the registry file is safe to commit, mount as a ConfigMap and print, while the values arrive
 * from `op run` in development and Kubernetes Secrets in production.
 *
 * Every validation failure here is a startup failure, and every message names the offending
 * entry (by issuer, or by index when the issuer itself is unusable) without ever including the
 * value of a secret-bearing field.
 * @author John Grimes
 */

import { readFileSync } from "node:fs";

import { isJsonObject } from "./json";

import type { JWK } from "jose";

/** Prefix marking a registry value as a reference to an environment variable. */
const ENV_REFERENCE_PREFIX = "env:";

/** Environment variable names we are prepared to echo into an error message. */
const ENV_NAME_PATTERN = /^[A-Za-z_][\dA-Za-z_]*$/;

/** Stated lifetime of a minted grant when an entry does not say otherwise (FR-016). */
export const DEFAULT_GRANT_TTL_SECONDS = 3600;

/** Port the server listens on when `PORT` is unset. */
const DEFAULT_PORT = 3000;

/** Shortest session cookie secret we will start with. */
const MINIMUM_COOKIE_SECRET_LENGTH = 32;

/** The confidential client used for the requester's SMART App Launch. */
export interface LaunchClientRegistration {
  /** Registered confidential client id. */
  readonly clientId: string;
  /** Resolved client secret. Never leaves the server. */
  readonly clientSecret: string;
  /** Space-separated scopes requested at authorize time. */
  readonly scopes: string;
}

/** The SMART Backend Services client used to mint grants at manifest-fetch time. */
export interface BackendClientRegistration {
  /** Registered Backend Services client id. */
  readonly clientId: string;
  /** Resolved RS384 private JWK, carrying a `kid`. Never leaves the server. */
  readonly privateKeyJwk: JWK;
  /** Space-separated scopes requested at mint time. */
  readonly scopes: string;
}

/** One permitted FHIR server and the credentials registered with it. */
export interface IssuerRegistration {
  /** FHIR base URL, exactly as it arrives in `iss`. Unique, `https` only. */
  readonly issuer: string;
  /** Human-readable name, shown on the standalone picker. */
  readonly label: string;
  /** Confidential launch client. */
  readonly launchClient: LaunchClientRegistration;
  /** Backend Services minting client. */
  readonly backendClient: BackendClientRegistration;
  /** Stated lifetime of grants minted for this issuer, in seconds. */
  readonly grantTtlSeconds: number;
}

/** Whole-process configuration, assembled once at startup. */
export interface ServerConfig {
  /** Absolute origin the app is served from; manifest URLs are built on it. */
  readonly appOrigin: string;
  /** Path of the SQLite database file. */
  readonly sqlitePath: string;
  /** Path the registry was read from, retained for diagnostics. */
  readonly issuerRegistryPath: string;
  /** Key used to sign the session cookie. */
  readonly cookieSecret: string;
  /** TCP port to listen on. */
  readonly port: number;
  /** The loaded issuer registry. */
  readonly issuers: readonly IssuerRegistration[];
}

/**
 * Strip trailing slashes so `https://x/fhir` and `https://x/fhir/` compare equal.
 * @param issuer an issuer URL
 * @returns the issuer with any trailing slashes removed
 */
function normaliseIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/**
 * Resolve an environment reference of the form `env:VARIABLE_NAME`.
 *
 * The reference syntax itself is the contract: anything else - including a value that happens
 * to be the secret - is rejected, because inline secrets in the registry file are exactly what
 * this indirection exists to prevent. Neither the offending value nor the resolved value ever
 * appears in an error message.
 * @param value the raw registry value
 * @param field dotted field name, used to attribute the failure
 * @param entryLabel description of the entry the field belongs to
 * @param env the environment to resolve against
 * @returns the variable name and the value it resolved to
 * @throws {Error} when the value is not a reference, or names an unset or empty variable
 * @example
 * resolveEnvReference("env:LAUNCH_CLIENT_SECRET", "launchClient.clientSecret", label, env)
 */
function resolveEnvReference(
  value: unknown,
  field: string,
  entryLabel: string,
  env: Record<string, string | undefined>,
): { name: string; value: string } {
  const name =
    typeof value === "string" && value.startsWith(ENV_REFERENCE_PREFIX)
      ? value.slice(ENV_REFERENCE_PREFIX.length)
      : undefined;
  if (name === undefined || !ENV_NAME_PATTERN.test(name)) {
    throw new Error(
      `${entryLabel}: "${field}" must be an environment reference of the form ` +
        `"env:VARIABLE_NAME", so that secrets are never written into the registry file`,
    );
  }
  const resolved = env[name];
  if (resolved === undefined || resolved.trim().length === 0) {
    throw new Error(
      `${entryLabel}: "${field}" references environment variable ${name}, ` +
        `which is unset or empty`,
    );
  }
  return { name, value: resolved };
}

/**
 * Resolve and validate an RS384 private JWK held in an environment variable.
 * @param value the raw registry value (expected to be an environment reference)
 * @param field dotted field name, used to attribute the failure
 * @param entryLabel description of the entry the field belongs to
 * @param env the environment to resolve against
 * @returns the parsed private JWK
 * @throws {Error} when the variable is absent, is not JSON, or is not an RSA private JWK
 */
function resolvePrivateKeyJwk(
  value: unknown,
  field: string,
  entryLabel: string,
  env: Record<string, string | undefined>,
): JWK {
  const { name, value: raw } = resolveEnvReference(
    value,
    field,
    entryLabel,
    env,
  );
  const attribution = `${entryLabel}: "${field}" references environment variable ${name}, whose value`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${attribution} is not valid JSON`);
  }
  if (!isJsonObject(parsed) || typeof parsed.kty !== "string") {
    throw new Error(`${attribution} is not a JSON Web Key`);
  }
  if (parsed.kty !== "RSA") {
    throw new Error(
      `${attribution} is not an RSA key, as RS384 signing requires`,
    );
  }
  if (typeof parsed.kid !== "string" || parsed.kid.length === 0) {
    throw new Error(
      `${attribution} carries no "kid", which the JWKS route needs to publish it`,
    );
  }
  if (typeof parsed.d !== "string" || parsed.d.length === 0) {
    throw new Error(`${attribution} is not a private JWK`);
  }
  return parsed;
}

/**
 * Read a required non-empty string field.
 * @param source the object to read from
 * @param key the property name on `source`
 * @param entryLabel description of the entry the field belongs to
 * @param field dotted field name used in the message, defaulting to the property name
 * @returns the field value
 * @throws {Error} when the field is missing, not a string, or empty
 */
function requireString(
  source: Record<string, unknown>,
  key: string,
  entryLabel: string,
  field: string = key,
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${entryLabel}: "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Read a required nested object.
 * @param source the object to read from
 * @param field the property name
 * @param entryLabel description of the entry the field belongs to
 * @returns the nested object
 * @throws {Error} when the property is missing or is not an object
 */
function requireObject(
  source: Record<string, unknown>,
  field: string,
  entryLabel: string,
): Record<string, unknown> {
  const value = source[field];
  if (!isJsonObject(value)) {
    throw new Error(`${entryLabel}: "${field}" must be an object`);
  }
  return value;
}

/**
 * Validate the `issuer` field: present, a URL, and `https`.
 * @param raw the entry
 * @param entryLabel description of the entry
 * @returns the issuer URL as written
 * @throws {Error} when the issuer is absent, unparseable or not `https`
 */
function parseIssuer(raw: Record<string, unknown>, entryLabel: string): string {
  const issuer = requireString(raw, "issuer", entryLabel);
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`${entryLabel}: "issuer" is not a valid absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${entryLabel}: "issuer" must use the https scheme`);
  }
  return issuer;
}

/**
 * Validate `grantTtlSeconds`, defaulting it when absent.
 * @param raw the entry
 * @param entryLabel description of the entry
 * @returns the stated grant lifetime in seconds
 * @throws {Error} when present but not a positive integer
 */
function parseGrantTtl(
  raw: Record<string, unknown>,
  entryLabel: string,
): number {
  const value = raw.grantTtlSeconds;
  if (value === undefined) {
    return DEFAULT_GRANT_TTL_SECONDS;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${entryLabel}: "grantTtlSeconds" must be a positive integer`,
    );
  }
  return value;
}

/**
 * Parse and validate one registry entry.
 * @param raw the entry as read from the file
 * @param index its position in the array, used when the issuer is unusable
 * @param registryPath the file the entry came from
 * @param env the environment to resolve references against
 * @returns the validated registration
 * @throws {Error} naming the entry when any field is invalid
 */
function parseEntry(
  raw: unknown,
  index: number,
  registryPath: string,
  env: Record<string, string | undefined>,
): IssuerRegistration {
  const prefix = `Issuer registry at ${registryPath}`;
  if (!isJsonObject(raw)) {
    throw new Error(`${prefix}: entry at index ${index} must be an object`);
  }
  // Attribute failures by issuer where we can, and by position where we cannot.
  const entryLabel =
    typeof raw.issuer === "string" && raw.issuer.length > 0
      ? `${prefix}: issuer "${raw.issuer}"`
      : `${prefix}: entry at index ${index}`;

  const issuer = parseIssuer(raw, entryLabel);
  const label = requireString(raw, "label", entryLabel);

  const launch = requireObject(raw, "launchClient", entryLabel);
  const backend = requireObject(raw, "backendClient", entryLabel);

  return {
    issuer,
    label,
    launchClient: {
      clientId: requireString(
        launch,
        "clientId",
        entryLabel,
        "launchClient.clientId",
      ),
      clientSecret: resolveEnvReference(
        launch.clientSecret,
        "launchClient.clientSecret",
        entryLabel,
        env,
      ).value,
      scopes: requireString(
        launch,
        "scopes",
        entryLabel,
        "launchClient.scopes",
      ),
    },
    backendClient: {
      clientId: requireString(
        backend,
        "clientId",
        entryLabel,
        "backendClient.clientId",
      ),
      privateKeyJwk: resolvePrivateKeyJwk(
        backend.privateKeyJwk,
        "backendClient.privateKeyJwk",
        entryLabel,
        env,
      ),
      scopes: requireString(
        backend,
        "scopes",
        entryLabel,
        "backendClient.scopes",
      ),
    },
    grantTtlSeconds: parseGrantTtl(raw, entryLabel),
  };
}

/**
 * Load and validate the issuer registry.
 * @param registryPath path of the registry JSON file
 * @param env environment to resolve `env:` references against, defaulting to the process
 *   environment
 * @returns the validated registrations, in file order
 * @throws {Error} when the file is unreadable, is not a JSON array, contains an invalid entry,
 *   repeats an issuer, or names an environment variable that is unset
 * @example
 * const issuers = loadIssuerRegistry("/etc/shl/issuers.json");
 */
export function loadIssuerRegistry(
  registryPath: string,
  env: Record<string, string | undefined> = process.env,
): IssuerRegistration[] {
  let text: string;
  try {
    text = readFileSync(registryPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Issuer registry at ${registryPath} could not be read: ${reason}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Only the position is reported. Modern V8 syntax errors quote the offending source, which
    // could put registry content into a log line.
    const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(
      error instanceof Error ? error.message : "",
    )?.[0];
    throw new Error(
      `Issuer registry at ${registryPath} is not valid JSON` +
        (position === undefined ? "" : ` (${position})`),
    );
  }

  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `Issuer registry at ${registryPath} must be a JSON array of issuer entries`,
    );
  }

  const registrations = parsed.map((raw, index) =>
    parseEntry(raw, index, registryPath, env),
  );

  const seen = new Set<string>();
  for (const registration of registrations) {
    const key = normaliseIssuer(registration.issuer);
    if (seen.has(key)) {
      throw new Error(
        `Issuer registry at ${registryPath} contains a duplicate issuer: ` +
          `${registration.issuer} (a trailing slash does not make it distinct)`,
      );
    }
    seen.add(key);
  }

  return registrations;
}

/**
 * Look up a registration by issuer URL, tolerating a trailing-slash difference.
 *
 * `iss` arrives from the EHR verbatim and servers are inconsistent about the trailing slash on
 * a FHIR base URL, so an exact string match would refuse legitimate launches.
 * @param registrations the loaded registry
 * @param issuer the issuer URL to look for
 * @returns the matching registration, or undefined when the issuer is not registered
 * @example
 * findIssuerRegistration(issuers, "https://ehr.example.org/fhir/"); // matches ".../fhir"
 */
export function findIssuerRegistration(
  registrations: readonly IssuerRegistration[],
  issuer: string,
): IssuerRegistration | undefined {
  if (issuer.length === 0) {
    return undefined;
  }
  const wanted = normaliseIssuer(issuer);
  return registrations.find(
    (registration) => normaliseIssuer(registration.issuer) === wanted,
  );
}

/**
 * Read a required environment variable.
 * @param env the environment
 * @param name the variable name
 * @returns the value
 * @throws {Error} naming the variable when it is unset or empty
 */
function requireEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Environment variable ${name} is required but unset`);
  }
  return value;
}

/**
 * Load the whole-process configuration, including the issuer registry.
 * @param env the environment to read, defaulting to the process environment
 * @returns the validated configuration
 * @throws {Error} when a required variable is unset, a value is malformed, or the registry fails
 *   validation
 * @example
 * const config = loadServerConfig();
 */
export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const rawOrigin = requireEnv(env, "APP_ORIGIN");
  let appOrigin: string;
  try {
    appOrigin = new URL(rawOrigin).origin;
  } catch {
    throw new Error(
      "Environment variable APP_ORIGIN must be an absolute URL, for example " +
        "https://app.example.org",
    );
  }

  const cookieSecret = requireEnv(env, "SESSION_COOKIE_SECRET");
  if (cookieSecret.length < MINIMUM_COOKIE_SECRET_LENGTH) {
    throw new Error(
      `Environment variable SESSION_COOKIE_SECRET must be at least ` +
        `${MINIMUM_COOKIE_SECRET_LENGTH} characters`,
    );
  }

  const rawPort = env.PORT;
  const port =
    rawPort === undefined ? DEFAULT_PORT : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Environment variable PORT must be a TCP port number");
  }

  const issuerRegistryPath = requireEnv(env, "ISSUER_REGISTRY_PATH");

  return {
    appOrigin,
    sqlitePath: requireEnv(env, "SQLITE_PATH"),
    issuerRegistryPath,
    cookieSecret,
    port,
    issuers: loadIssuerRegistry(issuerRegistryPath, env),
  };
}
