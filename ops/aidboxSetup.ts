/**
 * Idempotent Aidbox setup for the confidential SMART app.
 *
 * Applies everything `contracts/aidbox-setup.md` describes: the confidential launch client, the
 * SMART Backend Services client, one narrow `AccessPolicy` per client, the demo Questionnaires
 * from repo fixtures, the demo Patient, and the `User` the Playwright suite logs in as. It then
 * verifies whether the filler browser may POST a transaction to `/fhir` cross-origin, and
 * reports which of the two send modes validation will run in.
 *
 * ## Idempotence
 *
 * Every resource is written with `PUT` at a fixed id, but only after the stored copy is read
 * and compared. A stored resource that already contains every field we intend to write is left
 * alone, so `meta.versionId` is stable across runs. Fields Aidbox will not echo back - a
 * client secret, a user password - are excluded from that comparison and therefore only
 * established when the resource is created, or when `--force` asks for a rotation.
 *
 * ## Secrets
 *
 * The launch client's secret and the Backend Services private JWK are read from the
 * environment when they already exist (`LAUNCH_CLIENT_SECRET`, `BACKEND_PRIVATE_JWK` - the same
 * variables the issuer registry references), and generated otherwise. A generated value is
 * printed once, at the end, as an `op`-storable block. Nothing else in this module ever emits
 * it: the applier logs a method, a path and a status, and writes no files.
 *
 * ## Usage
 *
 * ```bash
 * op run --env-file .env -- npx tsx ops/aidboxSetup.ts
 * op run --env-file .env -- npx tsx ops/aidboxSetup.ts --force   # rotate credentials
 * ```
 * @author John Grimes
 */

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
} from "jose";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Patient, Questionnaire } from "fhir/r4";
import type { JWK } from "jose";

/** Fixed id of the confidential launch client (contract section 1). */
export const LAUNCH_CLIENT_ID = "smart-forms-health-links";

/** Fixed id of the SMART Backend Services client (contract section 2). */
export const BACKEND_CLIENT_ID = "smart-forms-health-links-backend";

/** Fixed id of the launch client's AccessPolicy (contract section 3). */
export const LAUNCH_POLICY_ID = "smart-forms-health-links-policy";

/** Fixed id of the backend client's AccessPolicy (contract section 3). */
export const BACKEND_POLICY_ID = "smart-forms-health-links-backend-policy";

/** Fixed id of the demo patient (contract section 5). */
export const DEMO_PATIENT_ID = "pt-demo";

/** Questionnaire fixture files, relative to `fixtures/questionnaires`. */
export const QUESTIONNAIRE_FIXTURES = [
  "AdultSepsisScreening.json",
  "GPChronicConditionManagementPlan.json",
] as const;

/** Scopes the launch client requests, in the order the contract lists them. */
const LAUNCH_SCOPES = [
  "openid",
  "fhirUser",
  "launch",
  "launch/patient",
  "online_access",
  "user/*.cruds",
];

/** Scopes the backend client is allowed: create a response, read and update the Task. */
const BACKEND_SCOPES = [
  "system/QuestionnaireResponse.c",
  "system/Task.r",
  "system/Task.u",
];

/** The client assertion type SMART Backend Services requires. */
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Bytes of entropy behind a generated client secret. */
const CLIENT_SECRET_BYTES = 32;

/** Modulus size for the generated RS384 signing key. */
const SIGNING_KEY_MODULUS_LENGTH = 2048;

/** Stated lifetime of a minted grant when the environment does not say otherwise. */
const DEFAULT_GRANT_TTL_SECONDS = 3600;

/** Hostnames an externally hosted Aidbox cannot resolve a JWKS URI on. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** JWK members that carry private key material and must never leave the process. */
const PRIVATE_JWK_MEMBERS = new Set(["d", "p", "q", "dp", "dq", "qi", "k"]);

/** An Aidbox resource body, as it goes over the wire. */
export type AidboxResource = Record<string, unknown>;

/** One resource the setup places at a fixed id. */
export interface PlannedResource {
  /** Human-readable label used in the run report. */
  label: string;
  /** Path relative to the Aidbox base URL, for example `/Client/smart-forms-health-links`. */
  path: string;
  /** The body to `PUT` at that path. */
  body: AidboxResource;
  /** Top-level fields Aidbox will not echo back, excluded from change detection. */
  opaqueFields: readonly string[];
}

/** An RS384 signing key pair, split into the halves that go to different places. */
export interface BackendKeyPair {
  /** The signing key. Stays in the BFF's environment. */
  privateJwk: JWK;
  /** The verification key. Registered with Aidbox or served at `/.well-known/jwks.json`. */
  publicJwk: JWK;
}

/** Everything the plan needs in order to name the resources it will write. */
export interface SetupOptions {
  /** Origin the app is served from, for example `https://links.example.org`. */
  appOrigin: string;
  /**
   * Grant lifetime in seconds. Reaches Aidbox verbatim as `access_token_expiration`, which
   * this build interprets in seconds - see `buildLaunchClient`.
   */
  grantTtlSeconds: number;
  /** The launch client's secret. */
  launchClientSecret: string;
  /** The Backend Services verification key. */
  backendPublicJwk: JWK;
  /** The Aidbox user the Playwright suite logs in as. */
  e2eUser: { id: string; email: string; password: string };
  /** Demo Questionnaires, read from repo fixtures. */
  questionnaires: readonly Questionnaire[];
}

/** What happened to one planned resource. */
export interface ApplyOutcome {
  /** The planned resource's label. */
  label: string;
  /** The path written, or read and left alone. */
  path: string;
  /** Whether the resource was created, updated, or already correct. */
  action: "created" | "updated" | "unchanged";
  /** HTTP status of the last request made for this resource. */
  status: number;
  /** `meta.versionId` after the run, when the server reported one. */
  versionId?: string;
}

/** The subset of `fetch` this module uses. Injected so the logic is testable offline. */
export type FetchLike = typeof fetch;

/** Arguments for applying a plan. */
export interface ApplyOptions {
  /** Aidbox base URL, without a trailing slash. */
  baseUrl: string;
  /** Value of the `Authorization` header for the operator credentials. */
  authorization: string;
  /** The plan to apply, in order. */
  planned: readonly PlannedResource[];
  /** The fetch implementation to use. */
  fetchImpl: FetchLike;
  /** Sink for progress lines. Never receives secret material. */
  log: (line: string) => void;
  /** Write every resource even when the stored copy already matches. */
  force?: boolean;
}

/** What the preflight told us about the filler's direct cross-origin send. */
export interface CorsFinding {
  /** The origin the preflight was sent from. */
  origin: string;
  /** `access-control-allow-origin` from the preflight response. */
  allowOrigin: string | null;
  /** `access-control-allow-headers` from the preflight response. */
  allowHeaders: string | null;
  /** `access-control-allow-methods` from the preflight response. */
  allowMethods: string | null;
  /** Whether a browser would let the filler POST the transaction itself. */
  directSendSupported: boolean;
}

/**
 * Strip trailing slashes so `https://host/` and `https://host` compose the same URLs.
 * @param value a base URL or origin
 * @returns the value with any trailing slashes removed
 */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Generate a client secret with 256 bits of entropy.
 *
 * Base64url so it survives an `.env` file, a Kubernetes Secret and an HTTP Basic header
 * without escaping.
 * @returns a 43-character base64url secret
 * @example
 * const secret = generateClientSecret();
 */
export function generateClientSecret(): string {
  return randomBytes(CLIENT_SECRET_BYTES).toString("base64url");
}

/**
 * Derive the publishable half of a JWK, dropping every private member.
 * @param jwk a private or public JWK
 * @returns the same key with private members removed
 */
function toPublicJwk(jwk: JWK): JWK {
  return Object.fromEntries(
    Object.entries(jwk).filter(([member]) => !PRIVATE_JWK_MEMBERS.has(member)),
  );
}

/**
 * Attach the algorithm metadata the BFF and Aidbox both key off, including a stable `kid`
 * derived from the RFC 7638 thumbprint.
 * @param jwk a bare exported JWK
 * @returns the same key with `alg`, `use` and `kid` set
 */
async function labelSigningJwk(jwk: JWK): Promise<JWK> {
  return {
    ...jwk,
    alg: "RS384",
    use: "sig",
    kid: await calculateJwkThumbprint(jwk, "sha256"),
  };
}

/**
 * Generate the RS384 key pair the Backend Services client authenticates with.
 *
 * SMART Backend Services requires RS384 or ES384, and Aidbox supports only asymmetric client
 * credentials, so this key is the sole thing standing between the internet and a token that
 * can write to the clinic's server.
 * @returns the private half for the BFF's environment and the public half for registration
 * @throws {Error} when the platform cannot produce an extractable RSA key
 * @example
 * const { privateJwk, publicJwk } = await generateBackendKeyPair();
 */
export async function generateBackendKeyPair(): Promise<BackendKeyPair> {
  const { privateKey } = await generateKeyPair("RS384", {
    modulusLength: SIGNING_KEY_MODULUS_LENGTH,
    extractable: true,
  });
  const privateJwk = await labelSigningJwk(await exportJWK(privateKey));

  return { privateJwk, publicJwk: toPublicJwk(privateJwk) };
}

/**
 * Recover the public half of an already-provisioned signing key.
 * @param privateJwk the private JWK held in the environment
 * @returns the matching labelled public JWK
 * @throws {Error} when the JWK is not a usable RSA signing key
 * @example
 * const publicJwk = await publicJwkFrom(JSON.parse(process.env.BACKEND_PRIVATE_JWK));
 */
export async function publicJwkFrom(privateJwk: JWK): Promise<JWK> {
  if (privateJwk.kty !== "RSA" || typeof privateJwk.d !== "string") {
    throw new Error("BACKEND_PRIVATE_JWK must be an RSA private JWK");
  }
  const labelled = privateJwk.kid
    ? privateJwk
    : await labelSigningJwk(privateJwk);

  return toPublicJwk(labelled);
}

/**
 * Whether an externally hosted Aidbox could fetch a JWKS URI on this origin.
 * @param appOrigin the app origin
 * @returns true when the origin's host is a loopback address
 */
function isLoopbackOrigin(appOrigin: string): boolean {
  return LOOPBACK_HOSTNAMES.has(new URL(appOrigin).hostname);
}

/**
 * Build the confidential launch client registration (contract section 1).
 *
 * `access_token_expiration` carries the grant TTL **in seconds**, not the milliseconds
 * `contracts/aidbox-setup.md` originally stated. Measured 2026-08-22 against the target
 * instance: registering 120 yields a token with `exp - iat = 120` and `expires_in: 120`;
 * registering 3600 yields 3600. Writing milliseconds there produced 3,600,000-second (41-day)
 * tokens, which would have silently defeated the short grant window of FR-016.
 * @param options the app origin, the client secret and the grant lifetime
 * @param options.appOrigin origin the app is served from
 * @param options.secret the client secret Aidbox will match on the token request
 * @param options.grantTtlSeconds grant lifetime, carried verbatim in seconds
 * @returns the `Client` body to `PUT` at `/Client/smart-forms-health-links`
 * @example
 * buildLaunchClient({ appOrigin, secret, grantTtlSeconds: 3600 });
 */
export function buildLaunchClient(options: {
  appOrigin: string;
  secret: string;
  grantTtlSeconds: number;
}): AidboxResource {
  const origin = trimTrailingSlash(options.appOrigin);

  return {
    resourceType: "Client",
    id: LAUNCH_CLIENT_ID,
    type: "smart-app",
    grant_types: ["code"],
    secret: options.secret,
    smart: { launch_uri: `${origin}/launch` },
    auth: {
      authorization_code: {
        redirect_uri: `${origin}/auth/callback`,
        token_format: "jwt",
        secret_required: true,
        pkce: true,
        refresh_token: true,
        access_token_expiration: options.grantTtlSeconds,
      },
    },
    scope: [...LAUNCH_SCOPES],
  };
}

/**
 * Build the SMART Backend Services client registration (contract section 2).
 *
 * The verification key reaches Aidbox one of two ways. A publicly reachable app origin gets
 * `jwks_uri`, so rotating the key is a BFF deployment rather than a setup run. A loopback
 * origin - the development default - cannot be fetched by a hosted Aidbox, so the public JWK
 * is registered inline instead.
 * @param options the app origin, the grant lifetime and the verification key
 * @param options.appOrigin origin the app is served from
 * @param options.grantTtlSeconds grant lifetime, carried verbatim in seconds
 * @param options.publicJwk the RS384 verification key
 * @returns the `Client` body to `PUT` at `/Client/smart-forms-health-links-backend`
 * @example
 * buildBackendClient({ appOrigin, grantTtlSeconds: 3600, publicJwk });
 */
export function buildBackendClient(options: {
  appOrigin: string;
  grantTtlSeconds: number;
  publicJwk: JWK;
}): AidboxResource {
  const origin = trimTrailingSlash(options.appOrigin);
  const keyLocation = isLoopbackOrigin(origin)
    ? { jwks: [toPublicJwk(options.publicJwk)] }
    : { jwks_uri: `${origin}/.well-known/jwks.json` };

  return {
    resourceType: "Client",
    id: BACKEND_CLIENT_ID,
    type: "bulk-api-client",
    grant_types: ["client_credentials"],
    ...keyLocation,
    auth: {
      client_credentials: {
        client_assertion_types: [CLIENT_ASSERTION_TYPE],
        token_format: "jwt",
        access_token_expiration: options.grantTtlSeconds,
      },
    },
    scope: [...BACKEND_SCOPES],
  };
}

/**
 * Build the launch client's AccessPolicy: the FHIR API, for that client's signed-in user.
 *
 * The `link` keeps the policy off every other request, and `user: "present?"` keeps it from
 * authorising anything the client does without a session.
 * @returns the `AccessPolicy` body to `PUT` at `/AccessPolicy/smart-forms-health-links-policy`
 * @example
 * buildLaunchPolicy();
 */
export function buildLaunchPolicy(): AidboxResource {
  return {
    resourceType: "AccessPolicy",
    id: LAUNCH_POLICY_ID,
    description:
      "FHIR API access for a signed-in user of the smart-forms-health-links launch client.",
    engine: "matcho",
    matcho: {
      client: { id: LAUNCH_CLIENT_ID },
      user: "present?",
      uri: "#^/fhir(/.*)?$",
    },
    link: [{ resourceType: "Client", id: LAUNCH_CLIENT_ID }],
  };
}

/**
 * Build the backend client's AccessPolicy: a transaction, and a Task read or update.
 *
 * Two alternatives rather than one wildcard, because the accepted blast radius of a leaked
 * grant is exactly what this policy bounds (FR-015). `$one-of` is the only key in its object:
 * matcho forbids combining it with siblings, so the client match is repeated inside each
 * alternative.
 *
 * Aidbox authorises each transaction *entry* as its own request as well as the enclosing
 * `POST /fhir`, so the entry that creates the response needs its own alternative. Verified
 * 2026-08-22 against the target instance: without it the transaction fails with
 * "Transaction failed at entry[0]. Response status is 403."
 * @returns the `AccessPolicy` body to `PUT` at
 *   `/AccessPolicy/smart-forms-health-links-backend-policy`
 * @example
 * buildBackendPolicy();
 */
export function buildBackendPolicy(): AidboxResource {
  return {
    resourceType: "AccessPolicy",
    id: BACKEND_POLICY_ID,
    description:
      "Transaction POST and Task read/update for the smart-forms-health-links backend client.",
    engine: "matcho",
    matcho: {
      "$one-of": [
        {
          client: { id: BACKEND_CLIENT_ID },
          "request-method": "post",
          uri: "/fhir",
        },
        {
          client: { id: BACKEND_CLIENT_ID },
          "request-method": "post",
          uri: "/fhir/QuestionnaireResponse",
        },
        {
          client: { id: BACKEND_CLIENT_ID },
          "request-method": { $enum: ["get", "put"] },
          uri: "#^/fhir/Task/[^/]+$",
        },
      ],
    },
    link: [{ resourceType: "Client", id: BACKEND_CLIENT_ID }],
  };
}

/**
 * Build the demo patient the walkthrough and the Playwright suite both name.
 * @returns the `Patient` body to `PUT` at `/fhir/Patient/pt-demo`
 * @example
 * buildDemoPatient();
 */
export function buildDemoPatient(): AidboxResource {
  const patient: Patient = {
    resourceType: "Patient",
    id: DEMO_PATIENT_ID,
    active: true,
    name: [{ family: "Citizen", given: ["Jane"] }],
    gender: "female",
    birthDate: "1975-03-14",
  };

  return { ...patient };
}

/**
 * Build the Aidbox user the Playwright suite logs in as (contract section 6).
 *
 * The password arrives from the environment and is written verbatim so Aidbox can hash it.
 * It is listed as an opaque field by `planSetup`, because Aidbox returns the hash rather than
 * the value and comparing the two would make every run look like a change.
 * @param options the user's id, email and password
 * @param options.id the fixed resource id
 * @param options.email the login email
 * @param options.password the login password, from the environment
 * @returns the `User` body to `PUT` at `/User/<id>`
 * @example
 * buildE2eUser({ id: "e2e-demo", email: "e2e@example.org", password });
 */
export function buildE2eUser(options: {
  id: string;
  email: string;
  password: string;
}): AidboxResource {
  return {
    resourceType: "User",
    id: options.id,
    email: options.email,
    password: options.password,
  };
}

/**
 * Order every resource the setup writes.
 *
 * Clients come before the policies that link to them, and the demo data comes last, so a run
 * that fails part way leaves no policy pointing at a client Aidbox has never seen.
 * @param options the app origin, credentials, demo user and questionnaire fixtures
 * @returns the ordered plan
 * @example
 * const planned = planSetup({ appOrigin, grantTtlSeconds, ... });
 */
export function planSetup(options: SetupOptions): PlannedResource[] {
  const questionnaires = options.questionnaires.map((questionnaire) => {
    // Server-assigned metadata from the forms server has no meaning on Aidbox, and leaving
    // it in would make the stored copy differ from the fixture on every comparison.
    const body: AidboxResource = { ...questionnaire };
    delete body.meta;

    return {
      label: `questionnaire ${questionnaire.id ?? "(no id)"}`,
      path: `/fhir/Questionnaire/${questionnaire.id ?? ""}`,
      body,
      opaqueFields: [],
    };
  });

  return [
    {
      label: "launch client",
      path: `/Client/${LAUNCH_CLIENT_ID}`,
      body: buildLaunchClient({
        appOrigin: options.appOrigin,
        secret: options.launchClientSecret,
        grantTtlSeconds: options.grantTtlSeconds,
      }),
      opaqueFields: ["secret"],
    },
    {
      label: "backend services client",
      path: `/Client/${BACKEND_CLIENT_ID}`,
      body: buildBackendClient({
        appOrigin: options.appOrigin,
        grantTtlSeconds: options.grantTtlSeconds,
        publicJwk: options.backendPublicJwk,
      }),
      opaqueFields: [],
    },
    {
      label: "launch client policy",
      path: `/AccessPolicy/${LAUNCH_POLICY_ID}`,
      body: buildLaunchPolicy(),
      opaqueFields: [],
    },
    {
      label: "backend client policy",
      path: `/AccessPolicy/${BACKEND_POLICY_ID}`,
      body: buildBackendPolicy(),
      opaqueFields: [],
    },
    ...questionnaires,
    {
      label: "demo patient",
      path: `/fhir/Patient/${DEMO_PATIENT_ID}`,
      body: buildDemoPatient(),
      opaqueFields: [],
    },
    {
      label: "e2e user",
      path: `/User/${options.e2eUser.id}`,
      body: buildE2eUser(options.e2eUser),
      opaqueFields: ["password"],
    },
  ];
}

/**
 * Whether `stored` already contains everything `desired` specifies.
 *
 * Objects match by containment, so server-added members (`meta`, defaults) do not count as
 * drift. Arrays match exactly, so dropping a scope does count.
 * @param stored the value read back from Aidbox
 * @param desired the value we intend to write
 * @returns true when nothing would change
 */
function containsValue(stored: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(stored) &&
      stored.length === desired.length &&
      desired.every((item, index) => containsValue(stored[index], item))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (
      stored === null ||
      typeof stored !== "object" ||
      Array.isArray(stored)
    ) {
      return false;
    }
    const storedRecord: Record<string, unknown> = { ...stored };

    return Object.entries(desired).every(([key, value]) =>
      containsValue(storedRecord[key], value),
    );
  }

  return stored === desired;
}

/**
 * Whether the stored resource already carries every field the plan would write.
 *
 * This is the whole of the idempotence guarantee: when it returns true the applier issues no
 * write, so `meta.versionId` is unchanged by a repeat run.
 * @param existing the resource read back from Aidbox, or undefined when absent
 * @param desired the body the plan would write
 * @param opaqueFields top-level fields Aidbox will not echo back, so cannot be compared
 * @returns true when no write is needed
 * @example
 * isUpToDate(stored, planned.body, planned.opaqueFields);
 */
export function isUpToDate(
  existing: AidboxResource | undefined,
  desired: AidboxResource,
  opaqueFields: readonly string[],
): boolean {
  if (existing === undefined) {
    return false;
  }
  const comparable = Object.fromEntries(
    Object.entries(desired).filter(([key]) => !opaqueFields.includes(key)),
  );

  return containsValue(existing, comparable);
}

/**
 * The secret-bearing values in a planned body, as strings.
 *
 * Aidbox echoes the offending value in some validation failures, so these are what a refusal
 * message has to be scrubbed of before it reaches the operator's terminal.
 * @param planned a planned resource
 * @returns the values of its opaque fields
 */
function opaqueValues(planned: PlannedResource): string[] {
  return planned.opaqueFields
    .map((field) => planned.body[field])
    .filter((value): value is string => typeof value === "string");
}

/**
 * Replace every occurrence of the given values with a marker.
 * @param text text that may quote a secret back at us
 * @param values the values to remove
 * @returns the text with each value replaced by `[redacted]`
 * @example
 * redact(`unexpected value ${secret}`, [secret]);
 */
export function redact(text: string, values: readonly string[]): string {
  let scrubbed = text;
  for (const value of values) {
    if (value !== "") {
      scrubbed = scrubbed.split(value).join("[redacted]");
    }
  }

  return scrubbed;
}

/**
 * Read the current copy of a resource.
 * @param options the applier's options
 * @param resourcePath the path to read
 * @returns the stored resource, or undefined when Aidbox has none
 * @throws {Error} when the read fails for any reason other than absence
 */
async function readExisting(
  options: ApplyOptions,
  resourcePath: string,
): Promise<AidboxResource | undefined> {
  const response = await options.fetchImpl(
    `${options.baseUrl}${resourcePath}`,
    {
      method: "GET",
      headers: {
        authorization: options.authorization,
        accept: "application/json",
      },
    },
  );
  if (response.status === 404 || response.status === 410) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `Reading ${resourcePath} failed with HTTP ${String(response.status)}`,
    );
  }
  const body: unknown = await response.json();

  return body !== null && typeof body === "object"
    ? (body as AidboxResource)
    : undefined;
}

/**
 * Pull `meta.versionId` out of a resource without asserting a shape onto it.
 * @param resource a resource read back from Aidbox
 * @returns the version id, when the server reported one
 */
function versionIdOf(resource: unknown): string | undefined {
  if (
    resource === null ||
    typeof resource !== "object" ||
    !("meta" in resource)
  ) {
    return undefined;
  }
  const meta = resource.meta;
  if (meta === null || typeof meta !== "object" || !("versionId" in meta)) {
    return undefined;
  }

  return typeof meta.versionId === "string" ? meta.versionId : undefined;
}

/**
 * Apply a plan to Aidbox, writing only what differs.
 *
 * Each resource is read first. When the stored copy already contains every comparable field
 * the run reports `unchanged` and issues no write, which is what makes a second run a no-op.
 * The log receives a method, a path and a status and nothing else, so a secret inside a body
 * never reaches the operator's scrollback.
 * @param options base URL, credentials, the plan, an injected fetch and a log sink
 * @returns one outcome per planned resource, in plan order
 * @throws {Error} when a read or a write is refused, naming the path but never the body
 * @example
 * const outcomes = await applyToServer({ baseUrl, authorization, planned, fetchImpl, log });
 */
export async function applyToServer(
  options: ApplyOptions,
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];

  for (const planned of options.planned) {
    const existing = await readExisting(options, planned.path);
    if (
      !options.force &&
      isUpToDate(existing, planned.body, planned.opaqueFields)
    ) {
      options.log(`unchanged  ${planned.path}`);
      outcomes.push({
        label: planned.label,
        path: planned.path,
        action: "unchanged",
        status: 200,
        versionId: versionIdOf(existing),
      });
      continue;
    }

    const response = await options.fetchImpl(
      `${options.baseUrl}${planned.path}`,
      {
        method: "PUT",
        headers: {
          authorization: options.authorization,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(planned.body),
      },
    );
    if (!response.ok) {
      throw new Error(
        `PUT ${planned.path} failed with HTTP ${String(response.status)}: ` +
          redact(await response.text(), opaqueValues(planned)),
      );
    }
    const written: unknown = await response.json();
    const action = existing === undefined ? "created" : "updated";
    options.log(
      `${action.padEnd(10)} ${planned.path} (HTTP ${String(response.status)})`,
    );
    outcomes.push({
      label: planned.label,
      path: planned.path,
      action,
      status: response.status,
      versionId: versionIdOf(written),
    });
  }

  return outcomes;
}

/**
 * Ask Aidbox whether a browser at the app origin could POST the transaction itself.
 *
 * This is the preflight the filler's direct send would trigger: a cross-origin `POST` to
 * `/fhir` carrying `Authorization`. All three of origin, header and method have to come back
 * allowed, or the send has to go through the BFF relay instead.
 * @param options the Aidbox base URL, the app origin and an injected fetch
 * @param options.baseUrl the Aidbox base URL
 * @param options.appOrigin the origin the filler's browser would send from
 * @param options.fetchImpl the fetch implementation to use
 * @returns what the preflight allowed, and the resulting mode
 * @example
 * const finding = await checkCors({ baseUrl, appOrigin, fetchImpl: fetch });
 */
export async function checkCors(options: {
  baseUrl: string;
  appOrigin: string;
  fetchImpl: FetchLike;
}): Promise<CorsFinding> {
  const origin = trimTrailingSlash(options.appOrigin);
  const response = await options.fetchImpl(
    `${trimTrailingSlash(options.baseUrl)}/fhir`,
    {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    },
  );

  const allowOrigin = response.headers.get("access-control-allow-origin");
  const allowHeaders = response.headers.get("access-control-allow-headers");
  const allowMethods = response.headers.get("access-control-allow-methods");

  const originAllowed = allowOrigin === "*" || allowOrigin === origin;
  const headerAllowed = (allowHeaders ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes("authorization");
  const methodAllowed = (allowMethods ?? "")
    .toUpperCase()
    .split(",")
    .map((value) => value.trim())
    .includes("POST");

  return {
    origin,
    allowOrigin,
    allowHeaders,
    allowMethods,
    directSendSupported: originAllowed && headerAllowed && methodAllowed,
  };
}

/**
 * Describe a CORS finding in the terms the walkthrough uses.
 * @param finding the result of `checkCors`
 * @returns a report naming the send mode validation will run in
 * @example
 * console.log(describeCorsFinding(await checkCors(...)));
 */
export function describeCorsFinding(finding: CorsFinding): string {
  const detail = [
    `  origin  ${finding.origin}`,
    `  allow-origin   ${finding.allowOrigin ?? "(absent)"}`,
    `  allow-headers  ${finding.allowHeaders ?? "(absent)"}`,
    `  allow-methods  ${finding.allowMethods ?? "(absent)"}`,
  ].join("\n");

  return finding.directSendSupported
    ? `CORS: send mode is direct browser POST to /fhir.\n${detail}`
    : `CORS: send mode is the BFF relay fallback - the preflight refuses the direct ` +
        `browser POST.\n${detail}`;
}

/**
 * Render the one-time operator report for generated credentials.
 *
 * This is the only authorised exit for secret material. Each value appears exactly once so a
 * copy into 1Password cannot pick up the wrong occurrence.
 * @param secrets the generated launch client secret and Backend Services private JWK
 * @param secrets.launchClientSecret the launch client secret
 * @param secrets.backendPrivateJwk the Backend Services signing key
 * @returns the block to print once
 * @example
 * console.log(formatOperatorSecrets({ launchClientSecret, backendPrivateJwk }));
 */
export function formatOperatorSecrets(secrets: {
  launchClientSecret: string;
  backendPrivateJwk: JWK;
}): string {
  return [
    "Store these in 1Password now. They are printed once and never written to disk.",
    "",
    "LAUNCH_CLIENT_SECRET",
    secrets.launchClientSecret,
    "",
    "BACKEND_PRIVATE_JWK",
    JSON.stringify(secrets.backendPrivateJwk),
  ].join("\n");
}

/**
 * Read a required environment variable.
 * @param env the environment to read
 * @param name the variable name
 * @returns the value
 * @throws {Error} when the variable is unset or empty
 */
function requireEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Environment variable ${name} is required`);
  }

  return value;
}

/**
 * Load the demo Questionnaires from the repository fixtures.
 *
 * Fixtures rather than a live fetch, so a setup run depends on no third party.
 * @param fixtureDirectory directory holding the fixture files
 * @returns the parsed Questionnaires, in fixture order
 * @throws {Error} when a fixture is missing or is not a Questionnaire with an id
 * @example
 * const questionnaires = loadQuestionnaireFixtures("fixtures/questionnaires");
 */
export function loadQuestionnaireFixtures(
  fixtureDirectory: string,
): Questionnaire[] {
  return QUESTIONNAIRE_FIXTURES.map((fileName) => {
    const filePath = path.join(fixtureDirectory, fileName);
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("resourceType" in parsed) ||
      parsed.resourceType !== "Questionnaire" ||
      !("id" in parsed) ||
      typeof parsed.id !== "string"
    ) {
      throw new Error(`${filePath} is not a Questionnaire with an id`);
    }

    return parsed as Questionnaire;
  });
}

/**
 * Resolve the launch client secret and Backend Services key, generating what is missing.
 * @param env the environment to read
 * @param force regenerate even when the environment already holds a value
 * @returns the credentials, and which of them were generated in this run
 */
async function resolveCredentials(
  env: Record<string, string | undefined>,
  force: boolean,
): Promise<{
  launchClientSecret: string;
  privateJwk: JWK;
  publicJwk: JWK;
  generated: boolean;
}> {
  const storedSecret = force ? undefined : env.LAUNCH_CLIENT_SECRET;
  const storedJwk = force ? undefined : env.BACKEND_PRIVATE_JWK;

  const launchClientSecret = storedSecret ?? generateClientSecret();
  if (storedJwk !== undefined) {
    const parsed: unknown = JSON.parse(storedJwk);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("BACKEND_PRIVATE_JWK must be a JSON object");
    }
    const privateJwk = parsed as JWK;
    // Importing proves the key is usable for RS384 before we register its public half.
    await importJWK(privateJwk, "RS384");

    return {
      launchClientSecret,
      privateJwk,
      publicJwk: await publicJwkFrom(privateJwk),
      generated: storedSecret === undefined,
    };
  }

  const generatedPair = await generateBackendKeyPair();

  return {
    launchClientSecret,
    privateJwk: generatedPair.privateJwk,
    publicJwk: generatedPair.publicJwk,
    generated: true,
  };
}

/**
 * Run the whole setup: apply the plan, verify CORS, and report.
 * @param env the environment to read
 * @param argv command-line arguments
 * @param log the sink for progress and report lines
 * @returns nothing
 * @throws {Error} when configuration is missing or Aidbox refuses a request
 * @example
 * await runSetup(process.env, process.argv.slice(2), console.log);
 */
export async function runSetup(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  log: (line: string) => void,
): Promise<void> {
  const force = argv.includes("--force");
  const baseUrl = trimTrailingSlash(requireEnv(env, "AIDBOX_BASE_URL"));
  const appOrigin = new URL(requireEnv(env, "APP_ORIGIN")).origin;
  const authorization = `Basic ${Buffer.from(
    `${requireEnv(env, "AIDBOX_CLIENT_ID")}:${requireEnv(env, "AIDBOX_CLIENT_SECRET")}`,
  ).toString("base64")}`;
  const grantTtlSeconds = Number.parseInt(
    env.GRANT_TTL_SECONDS ?? String(DEFAULT_GRANT_TTL_SECONDS),
    10,
  );
  if (!Number.isInteger(grantTtlSeconds) || grantTtlSeconds <= 0) {
    throw new Error("GRANT_TTL_SECONDS must be a positive whole number");
  }

  const credentials = await resolveCredentials(env, force);
  const fixtureDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/questionnaires",
  );

  const planned = planSetup({
    appOrigin,
    grantTtlSeconds,
    launchClientSecret: credentials.launchClientSecret,
    backendPublicJwk: credentials.publicJwk,
    e2eUser: {
      id: requireEnv(env, "AIDBOX_E2E_USER_ID"),
      email: requireEnv(env, "AIDBOX_E2E_USER_EMAIL"),
      password: requireEnv(env, "AIDBOX_E2E_USER_PASSWORD"),
    },
    questionnaires: loadQuestionnaireFixtures(fixtureDirectory),
  });

  // A run that mints a credential is not a no-op run: the value we are about to print has to
  // reach Aidbox, and a secret cannot be read back to prove that it did. So generating one
  // forces the writes. A run given both credentials in the environment compares and skips.
  log(`Applying ${String(planned.length)} resources to ${baseUrl}`);
  const outcomes = await applyToServer({
    baseUrl,
    authorization,
    planned,
    fetchImpl: fetch,
    log,
    force: force || credentials.generated,
  });

  log("");
  for (const outcome of outcomes) {
    log(
      `${outcome.action.padEnd(10)} ${outcome.path} versionId=${
        outcome.versionId ?? "(none)"
      }`,
    );
  }

  log("");
  log(
    describeCorsFinding(
      await checkCors({ baseUrl, appOrigin, fetchImpl: fetch }),
    ),
  );

  if (credentials.generated) {
    log("");
    log(
      formatOperatorSecrets({
        launchClientSecret: credentials.launchClientSecret,
        backendPrivateJwk: credentials.privateJwk,
      }),
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  await runSetup(process.env, process.argv.slice(2), (line) => {
    // The single sink for the whole run. Nothing that reaches it carries secret material
    // except the deliberate one-time operator report at the end.
    console.log(line);
  });
}
