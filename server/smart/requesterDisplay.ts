/**
 * Resolving a human name for the person a launch signed in.
 *
 * `Task.requester.display` (FR-009) is read by whoever fills the form, so "Dr Alex Fielding"
 * is worth one extra request and `https://ehr.example.org/Practitioner/prac-demo` is not. The
 * launch itself rarely states a name: SMART App Launch guarantees only a `fhirUser` reference,
 * and the name lives on the resource that reference points at.
 *
 * Three properties are deliberate.
 *
 * **The reference is reduced to `ResourceType/id`, never dereferenced as given.** The claim is
 * an absolute URL chosen by the authorisation server, so following it verbatim would let an
 * issuer aim this process at any URL it liked. Only the type and id are taken, and they are
 * resolved against the FHIR base already registered for that issuer. On the reference
 * implementation instance that is also the only thing that works: Aidbox's `fhirUser` claim
 * names its own origin (`https://<host>/Practitioner/prac-demo`), which sits outside the launch
 * client's access policy and answers 403, while `https://<host>/fhir/Practitioner/prac-demo`
 * answers 200. Measured 2026-08-22.
 *
 * **A failure to resolve is never a failed launch.** Every outcome except a resolved name falls
 * through to the display the ID token's claims carried, and then to null, which is the SPA's
 * signal to use its configured sender name. A session with no requester display is degraded;
 * a session that could not be created is a launch the user has to start again.
 *
 * **The access token is used but never logged.** The lookup is made with the session's own
 * grant, so it sees exactly what the requester is allowed to see, and the warning emitted on
 * failure names the reference and the status, never the credential.
 * @author John Grimes
 */

import { isJsonObject } from "../json";

import type { FastifyBaseLogger } from "fastify";

/**
 * A FHIR resource type: one or more capitalised words, per the `id` and type rules in the FHIR
 * specification. Anchored, so a path segment that merely starts with a capital does not pass.
 */
const RESOURCE_TYPE_PATTERN = /^[A-Z][A-Za-z]+$/;

/** A FHIR resource id, as defined by the `id` datatype. */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/** Arguments for resolving a requester display. */
export interface RequesterDisplayOptions {
  /** The registered FHIR base URL of the session's issuer. */
  readonly fhirBase: string;
  /** The session's access token. Used for the lookup, never logged. */
  readonly accessToken: string;
  /** The `fhirUser` reference the launch disclosed, if any. */
  readonly fhirUser: string | null;
  /** The display the ID token's claims carried, used when no name can be resolved. */
  readonly claimDisplay: string | null;
  /** Logger for a failed lookup. */
  readonly log: FastifyBaseLogger;
}

/**
 * Reduce a `fhirUser` reference to the `ResourceType/id` it names.
 *
 * Accepts both the absolute form SMART servers send and a bare relative reference. Anything
 * whose last two path segments are not a resource type and an id is rejected rather than
 * guessed at.
 * @param reference the reference as the launch disclosed it
 * @returns `ResourceType/id`, or undefined when the value does not name a resource
 * @example
 * parseFhirUserReference("https://ehr.example.org/Practitioner/prac-1"); // "Practitioner/prac-1"
 * parseFhirUserReference("https://attacker.example/internal/metadata"); // undefined
 */
function parseFhirUserReference(reference: string): string | undefined {
  const [path] = reference.split(/[?#]/, 1);
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  const [resourceType, id] = segments.slice(-2);
  if (
    !RESOURCE_TYPE_PATTERN.test(resourceType) ||
    !RESOURCE_ID_PATTERN.test(id)
  ) {
    return undefined;
  }
  return `${resourceType}/${id}`;
}

/**
 * Derive a display name from a resource's `name` element.
 *
 * `name.text` is the server's own rendering and is preferred; otherwise the given names and
 * the family name are joined, which is the best a client can do without knowing the locale's
 * name order.
 * @param resource a resource read from the issuer's FHIR API
 * @returns the display name, or null when the resource carries no usable name
 * @example
 * humanNameDisplay({ name: [{ family: "Fielding", given: ["Alex"] }] }); // "Alex Fielding"
 */
function humanNameDisplay(resource: unknown): string | null {
  if (!isJsonObject(resource) || !Array.isArray(resource.name)) {
    return null;
  }
  for (const entry of resource.name) {
    if (!isJsonObject(entry)) {
      continue;
    }
    if (typeof entry.text === "string" && entry.text.trim().length > 0) {
      return entry.text.trim();
    }
    const given = Array.isArray(entry.given)
      ? entry.given.filter((part): part is string => typeof part === "string")
      : [];
    const family = typeof entry.family === "string" ? [entry.family] : [];
    const composed = [...given, ...family].join(" ").trim();
    if (composed.length > 0) {
      return composed;
    }
  }
  return null;
}

/**
 * Resolve the display name to store against a session.
 * @param options the FHIR base, the session's access token, the launch's `fhirUser` reference,
 *   the claim-derived fallback and a logger
 * @returns the resolved name, the claim fallback, or null when the launch disclosed neither.
 *   Never throws: see the module comment.
 * @example
 * const userDisplay = await resolveRequesterDisplay({
 *   fhirBase: registration.issuer,
 *   accessToken: token.accessToken,
 *   fhirUser: token.fhirUser,
 *   claimDisplay: token.userDisplay,
 *   log: request.log,
 * });
 */
export async function resolveRequesterDisplay(
  options: RequesterDisplayOptions,
): Promise<string | null> {
  const reference =
    options.fhirUser === null
      ? undefined
      : parseFhirUserReference(options.fhirUser);
  if (reference === undefined) {
    return options.claimDisplay;
  }

  const url = `${options.fhirBase.replace(/\/+$/, "")}/${reference}`;
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        accept: "application/fhir+json, application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const display = humanNameDisplay(await response.json());
    if (display !== null) {
      return display;
    }
    options.log.info(
      { reference },
      "launched user's FHIR resource carries no name",
    );
  } catch (error) {
    options.log.warn(
      { err: error, reference },
      "could not resolve a display name for the launched user",
    );
  }
  return options.claimDisplay;
}
