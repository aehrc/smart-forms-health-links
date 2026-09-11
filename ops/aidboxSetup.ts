/**
 * Idempotent Aidbox setup for the confidential SMART app.
 *
 * Applies everything `contracts/aidbox-setup.md` describes: the confidential launch client, the
 * SMART Backend Services client, one narrow `AccessPolicy` per client, the demo Questionnaires
 * from repo fixtures, the demo Patient, and the `User` the Playwright suite logs in as together
 * with the `Practitioner` that user stands for. It then verifies whether the filler browser may
 * POST a transaction to `/fhir` cross-origin, and reports which of the two send modes
 * validation will run in.
 *
 * ## Idempotence
 *
 * Every resource is written with `PUT` at a known id, but only after the stored copy is read
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

import type { Patient, Practitioner, Questionnaire } from "fhir/r4";
import type { JWK } from "jose";

/**
 * Stem every registered id is built from (contract sections 1-3).
 *
 * The ids themselves are no longer constants, because one Aidbox instance serves more than one
 * environment: see {@link resolveClientIds}.
 */
export const CLIENT_ID_BASE = "smart-forms-health-links";

/** Suffix given to a deployment served from a loopback host, when none is configured. */
export const LOCAL_CLIENT_ID_SUFFIX = "-local";

/**
 * What an Aidbox resource id may look like: FHIR's `[A-Za-z0-9-.]{1,64}`, opening on a
 * letter or digit so a suffix cannot begin an id with punctuation.
 */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][\d.A-Za-z-]{0,63}$/;

/** The four ids one environment registers under. */
export interface ClientIds {
  /** Confidential launch client. */
  readonly launchClient: string;
  /** SMART Backend Services client. */
  readonly backendClient: string;
  /** The launch client's AccessPolicy. */
  readonly launchPolicy: string;
  /** The backend client's AccessPolicy. */
  readonly backendPolicy: string;
}

/** Fixed id of the demo patient (contract section 5). */
export const DEMO_PATIENT_ID = "pt-demo";

/** Fixed id of the demo practitioner the e2e user stands for (contract section 5). */
export const DEMO_PRACTITIONER_ID = "prac-demo";

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

/**
 * Scopes the backend client is allowed: create the response and its provenance, read and update
 * the Task.
 *
 * The provenance create is not optional. FR-021 requires the transaction to carry a provenance
 * naming the patient as author, and Aidbox authorises each transaction entry as its own request,
 * so a grant that can create the response but not its attribution fails every send at entry[1].
 */
const BACKEND_SCOPES = [
  "system/QuestionnaireResponse.c",
  "system/Provenance.c",
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
  /**
   * Origin this resource is being registered against, when it records one.
   *
   * Set only on the two clients. `applyToServer` refuses to write over a stored copy that names
   * a different origin, which is what stops one environment's run from taking another's
   * registration over - see {@link assertOriginUnclaimed}.
   */
  expectedOrigin?: string;
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
  /** The ids this environment registers under, from {@link resolveClientIds}. */
  clientIds: ClientIds;
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
 * Work out which four ids this run registers under.
 *
 * One Aidbox instance serves more than one environment - a developer's `http://localhost:3000`
 * and a deployed demo - and a `Client` holds exactly one `redirect_uri` and one key location. So
 * the environments cannot share a registration: whichever ran `setup:aidbox` last would own it,
 * and the other's launch would fail at the authorize step with no diagnostic beyond a redirect
 * mismatch. Giving each environment its own ids is what makes them independent.
 *
 * **The default comes from the origin, not from the environment.** Requiring a variable to be set
 * for safety gets it exactly backwards: the person who forgets is the person on a laptop, and the
 * registration they would take over is the deployed one. A loopback origin therefore defaults to
 * {@link LOCAL_CLIENT_ID_SUFFIX} and everything else to no suffix, so the deployment keeps the
 * unsuffixed ids it already holds and nobody has to remember anything to leave it alone.
 *
 * `CLIENT_ID_SUFFIX` overrides that, and *unset* is deliberately distinguished from *set to
 * empty*. `.env.deploy` is sourced with `set -a; . ./.env.deploy` into the current shell, so a
 * shell that earlier sourced `.env` still carries `-local`; the deploy file clears it by setting
 * the variable empty, which is only meaningful if an explicit empty value is honoured. Doing so
 * on a loopback origin is a contradiction - it asks for the deployed identity from a developer's
 * machine - and is refused rather than obeyed.
 *
 * A suffix cannot buy access to another environment's resources by construction, but it can
 * collide by accident: `-backend` turns the launch client id into the *backend* client's. Every
 * resulting id is individually legal and the four stay distinct, so nothing here catches it. The
 * origin check in {@link assertOriginUnclaimed} does.
 * @param options the origin being registered and the environment to read the override from
 * @param options.appOrigin origin the app is served from
 * @param options.env the environment to read `CLIENT_ID_SUFFIX` from
 * @returns the launch client, backend client and their two policy ids
 * @throws {Error} when the suffix is explicitly empty on a loopback origin, or when any resulting
 *   id is not a legal Aidbox resource id
 * @example
 * resolveClientIds({ appOrigin: "http://localhost:3000", env: process.env });
 * // -> { launchClient: "smart-forms-health-links-local", ... }
 */
export function resolveClientIds(options: {
  appOrigin: string;
  env: Record<string, string | undefined>;
}): ClientIds {
  const configured = options.env.CLIENT_ID_SUFFIX;
  const loopback = isLoopbackOrigin(options.appOrigin);

  if (configured !== undefined && configured.trim().length === 0 && loopback) {
    throw new Error(
      "CLIENT_ID_SUFFIX is set to an empty value, which asks for the deployed client ids, but " +
        `APP_ORIGIN is ${options.appOrigin}. Registering the deployed ids against a loopback ` +
        "origin would take the deployment's registration over. Unset the variable to get " +
        `"${LOCAL_CLIENT_ID_SUFFIX}", or give this environment a suffix of its own.`,
    );
  }

  const suffix = configured ?? (loopback ? LOCAL_CLIENT_ID_SUFFIX : "");
  const launchClient = `${CLIENT_ID_BASE}${suffix}`;
  const backendClient = `${CLIENT_ID_BASE}-backend${suffix}`;

  /*
   * Policy ids are derived from their client's rather than suffixed independently, so a client
   * and the policy that names it cannot drift apart. They do drift silently: a policy linking to
   * a client id nobody registered is a 403 at request time with nothing to point at.
   */
  const ids: ClientIds = {
    launchClient,
    backendClient,
    launchPolicy: `${launchClient}-policy`,
    backendPolicy: `${backendClient}-policy`,
  };

  const named: readonly (readonly [keyof ClientIds, string])[] = [
    ["launchClient", ids.launchClient],
    ["backendClient", ids.backendClient],
    ["launchPolicy", ids.launchPolicy],
    ["backendPolicy", ids.backendPolicy],
  ];
  for (const [field, id] of named) {
    if (!RESOURCE_ID_PATTERN.test(id)) {
      throw new Error(
        `CLIENT_ID_SUFFIX "${suffix}" makes the ${field} id "${id}", which is not a legal ` +
          "Aidbox resource id: letters, digits, hyphens and dots only, opening on a letter or " +
          "digit, and at most 64 characters.",
      );
    }
  }

  return ids;
}

/**
 * Refuse to write a client that another environment already registered.
 *
 * The failure this prevents is silent and remote: writing a `Client` at an id some other origin
 * holds repoints that deployment's `redirect_uri`, and nothing reports it until somebody tries to
 * sign in there and gets a redirect mismatch. It is the failure that prompted per-environment ids
 * in the first place, so relying on the ids alone to prevent it would be circular - the ids are
 * exactly what a mistyped suffix gets wrong.
 *
 * The check reads the origin already stored on the resource: `smart.launch_uri` for a launch
 * client, `jwks_uri` for a backend client registered against a non-loopback origin. A backend
 * client on a loopback origin carries its key inline and so records no origin at all, which is
 * why nothing is asserted about it - the launch client is written in the same run and by the same
 * suffix, so guarding one guards the pair.
 * @param existing the resource as Aidbox currently holds it, or undefined when there is none
 * @param resourcePath the path about to be written, for the message
 * @param appOrigin the origin this run would register
 * @throws {Error} when the stored resource names a different origin
 * @example
 * assertOriginUnclaimed(existing, "/Client/smart-forms-health-links", "http://localhost:3000");
 */
export function assertOriginUnclaimed(
  existing: AidboxResource | undefined,
  resourcePath: string,
  appOrigin: string,
): void {
  const claimed = claimedOrigin(existing);
  if (claimed === undefined || claimed === appOrigin) {
    return;
  }

  throw new Error(
    `Refusing to write ${resourcePath}: it is registered to ${claimed}, and this run would ` +
      `register it to ${appOrigin}. That would take over another environment's client and ` +
      "break its sign-in. Set CLIENT_ID_SUFFIX to give this environment its own ids, or pass " +
      "--force to take it over deliberately.",
  );
}

/**
 * The origin a stored client is registered against, if it records one.
 * @param existing a resource read back from Aidbox
 * @returns the origin, or undefined when the resource records none
 */
function claimedOrigin(
  existing: AidboxResource | undefined,
): string | undefined {
  if (existing === undefined) {
    return undefined;
  }

  const smart = existing.smart;
  const launchUri =
    typeof smart === "object" && smart !== null
      ? (smart as Record<string, unknown>).launch_uri
      : undefined;
  /*
   * A launch client records its origin in `smart.launch_uri`; a backend client registered
   * against a non-loopback origin records it in `jwks_uri`. A backend client on a loopback
   * origin carries its key inline and records neither, so it claims nothing.
   */
  let candidate: string | undefined;
  if (typeof launchUri === "string") {
    candidate = launchUri;
  } else if (typeof existing.jwks_uri === "string") {
    candidate = existing.jwks_uri;
  }

  if (candidate === undefined) {
    return undefined;
  }

  try {
    return new URL(candidate).origin;
  } catch {
    // A stored value that is not a URL tells us nothing about ownership, so it blocks nothing.
    return undefined;
  }
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
 * @returns the `Client` body to `PUT` at `/Client/<launch client id>`
 * @example
 * buildLaunchClient({ appOrigin, secret, grantTtlSeconds: 3600 });
 */
export function buildLaunchClient(options: {
  appOrigin: string;
  clientId: string;
  secret: string;
  grantTtlSeconds: number;
}): AidboxResource {
  const origin = trimTrailingSlash(options.appOrigin);

  return {
    resourceType: "Client",
    id: options.clientId,
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
 * @returns the `Client` body to `PUT` at `/Client/<backend client id>`
 * @example
 * buildBackendClient({ appOrigin, grantTtlSeconds: 3600, publicJwk });
 */
export function buildBackendClient(options: {
  appOrigin: string;
  clientId: string;
  grantTtlSeconds: number;
  publicJwk: JWK;
}): AidboxResource {
  const origin = trimTrailingSlash(options.appOrigin);
  const keyLocation = isLoopbackOrigin(origin)
    ? { jwks: [toPublicJwk(options.publicJwk)] }
    : { jwks_uri: `${origin}/.well-known/jwks.json` };

  return {
    resourceType: "Client",
    id: options.clientId,
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
 * The `link` keeps the policy off every other request, and the `jwt` assertion keeps it from
 * authorising anything the client does without a signed-in session.
 *
 * **The session is asserted on the token claims, not on `user`.** Measured 2026-08-22 against
 * the target instance: the request context matcho evaluates for a v2 (`atv: 2`) JWT access
 * token carries the token's claims under `jwt` and a resolved `client`, but no `user` object.
 * A policy keyed on `user: "present?"` therefore never matches and every `/fhir` request comes
 * back `403 forbidden`, however correct the rest of the rule is. Bisected by applying single
 * matcho keys against one real user token: `uri` alone, `client: { id }` alone, `link` alone
 * and `jwt: { sub: "present?" }` each authorised the request; `user: "present?"` did not.
 * `jwt.sub` is the user identity in a v2 token - Aidbox sets it to the `User` id - so it says
 * the same thing the `user` key was meant to say, and `jwt.scope` additionally requires the
 * token to have been issued through an authorisation flow that granted scopes.
 * @returns the `AccessPolicy` body to `PUT` at `/AccessPolicy/<launch policy id>`
 * @example
 * buildLaunchPolicy();
 */
export function buildLaunchPolicy(options: {
  clientId: string;
  policyId: string;
}): AidboxResource {
  return {
    resourceType: "AccessPolicy",
    id: options.policyId,
    description:
      "FHIR API access for a signed-in user of the smart-forms-health-links launch client.",
    engine: "matcho",
    matcho: {
      client: { id: options.clientId },
      jwt: { sub: "present?", scope: "present?" },
      uri: "#^/fhir(/.*)?$",
    },
    link: [{ resourceType: "Client", id: options.clientId }],
  };
}

/**
 * Build the backend client's AccessPolicy: a transaction, its two creates, and a Task read or
 * update.
 *
 * Enumerated alternatives rather than one wildcard, because the accepted blast radius of a leaked
 * grant is exactly what this policy bounds (FR-015). `$one-of` is the only key in its object:
 * matcho forbids combining it with siblings, so the client match is repeated inside each
 * alternative.
 *
 * Aidbox authorises each transaction *entry* as its own request as well as the enclosing
 * `POST /fhir`, so every resource the transaction creates needs its own alternative. Verified
 * against the target instance: without the response create the transaction fails with
 * "Transaction failed at entry[0]. Response status is 403" (2026-08-22), and without the
 * provenance create with the same message at `entry[1]` (2026-08-22, during the first live
 * send). The provenance is not an optional extra - FR-021 requires it - so both creates are
 * part of what a grant has to be able to do.
 * @returns the `AccessPolicy` body to `PUT` at
 *   `/AccessPolicy/<backend policy id>`
 * @example
 * buildBackendPolicy();
 */
export function buildBackendPolicy(options: {
  clientId: string;
  policyId: string;
}): AidboxResource {
  return {
    resourceType: "AccessPolicy",
    id: options.policyId,
    description:
      "Transaction POST and Task read/update for the smart-forms-health-links backend client.",
    engine: "matcho",
    matcho: {
      "$one-of": [
        {
          client: { id: options.clientId },
          "request-method": "post",
          uri: "/fhir",
        },
        {
          client: { id: options.clientId },
          "request-method": "post",
          uri: "/fhir/QuestionnaireResponse",
        },
        {
          client: { id: options.clientId },
          "request-method": "post",
          uri: "/fhir/Provenance",
        },
        {
          client: { id: options.clientId },
          "request-method": { $enum: ["get", "put"] },
          uri: "#^/fhir/Task/[^/]+$",
        },
      ],
    },
    link: [{ resourceType: "Client", id: options.clientId }],
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
 * Build the demo practitioner the e2e user stands for.
 *
 * This exists so the launch discloses a requester display name. Measured 2026-08-22 against
 * the target instance: with no `User.fhirUser` link the ID token carries no `fhirUser` claim
 * at all, so nothing names the person behind the session and `Task.requester.display` (FR-009)
 * would have nothing but a configured fallback to fall back to. With the link in place the ID
 * token carries `fhirUser: "<aidbox>/Practitioner/prac-demo"`, which the BFF resolves to this
 * resource's `name[0].text`.
 * @returns the `Practitioner` body to `PUT` at `/fhir/Practitioner/prac-demo`
 * @example
 * buildDemoPractitioner();
 */
export function buildDemoPractitioner(): AidboxResource {
  const practitioner: Practitioner = {
    resourceType: "Practitioner",
    id: DEMO_PRACTITIONER_ID,
    active: true,
    name: [
      {
        text: "Dr Alex Fielding",
        family: "Fielding",
        given: ["Alex"],
        prefix: ["Dr"],
      },
    ],
  };

  return { ...practitioner };
}

/**
 * Build the Aidbox user the Playwright suite logs in as (contract section 6).
 *
 * The password arrives from the environment and is written verbatim so Aidbox can hash it.
 * It is listed as an opaque field by `planSetup`, because Aidbox returns the hash rather than
 * the value and comparing the two would make every run look like a change.
 *
 * `fhirUser` points at {@link buildDemoPractitioner}, which is what makes the launch disclose
 * a display name for the requester. `planSetup` writes the practitioner immediately before
 * this user so the link never dangles.
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
    fhirUser: {
      resourceType: "Practitioner",
      id: DEMO_PRACTITIONER_ID,
    },
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
      path: `/Client/${options.clientIds.launchClient}`,
      body: buildLaunchClient({
        appOrigin: options.appOrigin,
        clientId: options.clientIds.launchClient,
        secret: options.launchClientSecret,
        grantTtlSeconds: options.grantTtlSeconds,
      }),
      opaqueFields: ["secret"],
      /*
       * The one entry that is origin-checked before it is written. A launch client records the
       * origin it belongs to, so it is the resource that can say "another environment holds
       * this" - see `assertOriginUnclaimed`.
       */
      expectedOrigin: options.appOrigin,
    },
    {
      label: "backend services client",
      path: `/Client/${options.clientIds.backendClient}`,
      body: buildBackendClient({
        appOrigin: options.appOrigin,
        clientId: options.clientIds.backendClient,
        grantTtlSeconds: options.grantTtlSeconds,
        publicJwk: options.backendPublicJwk,
      }),
      opaqueFields: [],
      expectedOrigin: options.appOrigin,
    },
    {
      label: "launch client policy",
      path: `/AccessPolicy/${options.clientIds.launchPolicy}`,
      body: buildLaunchPolicy({
        clientId: options.clientIds.launchClient,
        policyId: options.clientIds.launchPolicy,
      }),
      opaqueFields: [],
    },
    {
      label: "backend client policy",
      path: `/AccessPolicy/${options.clientIds.backendPolicy}`,
      body: buildBackendPolicy({
        clientId: options.clientIds.backendClient,
        policyId: options.clientIds.backendPolicy,
      }),
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
      label: "demo practitioner",
      path: `/fhir/Practitioner/${DEMO_PRACTITIONER_ID}`,
      body: buildDemoPractitioner(),
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

    /*
     * Before anything is written, and before the up-to-date shortcut: a resource that belongs to
     * another environment must stop the run whether or not this run would have changed it.
     * `--force` is the deliberate override, which is also what a genuine re-registration uses.
     */
    if (!options.force && planned.expectedOrigin !== undefined) {
      assertOriginUnclaimed(existing, planned.path, planned.expectedOrigin);
    }

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
  /*
   * An empty value means absent, the same as everywhere else this reads the environment
   * ({@link requireEnv} applies the same rule). Without it, the natural first state of a `.env`
   * copied from the template - the variable present and blank, because the value it will hold does
   * not exist yet - reaches `JSON.parse("")` and fails as `Unexpected end of JSON input`, which
   * reads like a corrupt key rather than a missing one.
   */
  const stored = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === "" ? undefined : value;
  };

  const storedSecret = force ? undefined : stored("LAUNCH_CLIENT_SECRET");
  const storedJwk = force ? undefined : stored("BACKEND_PRIVATE_JWK");

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

  const clientIds = resolveClientIds({ appOrigin, env });

  const planned = planSetup({
    appOrigin,
    clientIds,
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
  log(`  origin  ${appOrigin}`);
  log(`  clients ${clientIds.launchClient}, ${clientIds.backendClient}`);
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
