/**
 * What the rest of the app is allowed to know about a launch.
 *
 * The launch itself no longer happens here. It happens in the BFF - `server/smart/launch.ts` runs
 * the authorization code flow, and the access token, the refresh token and the client secret all
 * stay on that side of the wire (FR-005). This file is what is left in the browser once the
 * credential is gone: a **view** of the session, derived from `GET /api/session`, shaped so that
 * every caller written against the old client-side launch keeps working.
 *
 * That shape is deliberate rather than sentimental. `SmartSession` names the four things the app
 * actually does with a launch - where to send FHIR traffic, who is in context, who is acting, and
 * what they were granted - and none of those changed when the credential moved. What changed is
 * that {@link SmartSession.authorizationHeader} now has nothing to return, which is the whole
 * point: the browser cannot attach the session's authority to a request even if it wanted to, and
 * `src/fhir/authedFetch.ts` spends it by addressing the proxy instead.
 *
 * A session stays optional at this layer. The filler's half of the app has no account to log into
 * and never will, so every consumer takes `SmartSession | null` and has to mean something sensible
 * for `null`. The refusal to *write* without one lives a layer up - see `canWriteToRecord` in
 * `src/lib/config.ts` for why it is there and not here.
 * @author John Grimes
 */

import type { Session } from "@/lib/session";

import { proxyBaseUrl } from "@/fhir/authedFetch";

/**
 * A launched session, as the app uses one.
 *
 * Narrow on purpose. Nothing outside this file should know that the session arrived as JSON from
 * `/api/session`, so that the transport stays a one-file change.
 */
export interface SmartSession {
  /**
   * Where FHIR traffic goes: this app's own proxy, not the launched server.
   *
   * Callers build `${serverUrl}/Patient?…` exactly as they did when this was an EHR base URL, and
   * the proxy forwards it to the issuer with the session's token attached. The substitution is why
   * `src/fhir/ehrServer.ts`, `submit.ts`, `populate.ts` and `writeBundle.ts` needed no changes
   * when the launch moved to the server.
   */
  readonly serverUrl: string;

  /** The launched server's FHIR base. For display and provenance, never fetched directly. */
  readonly issuer: string;

  /** The launched server's human-readable name, from the deployment's issuer registry. */
  readonly issuerLabel: string;

  /** Patient in context, when the launch supplied one. Null on a standalone launch that declined to. */
  readonly patientId: string | null;

  /** The user, as a FHIR reference such as `Practitioner/123`. Null when `fhirUser` was not granted. */
  readonly fhirUser: string | null;

  /** The user's name, when the launch or a lookup disclosed one. For display and `Task.requester.display`. */
  readonly userDisplay: string | null;

  /** Scopes the server actually granted. The empty string when it declined to say. */
  readonly grantedScopes: string;

  /** Scopes this deployment asked for, so a narrowed grant can be spotted. */
  readonly requestedScopes: string;

  /** Access token expiry in epoch seconds. Advisory: the BFF enforces it. */
  readonly expiresAt: number;

  /**
   * Historically the `Authorization` header value. Now always null, and that is not a stub.
   *
   * The token is on the server, so there is no header for the browser to build. Callers already
   * had to treat null as "send this request without the session's authority", because an anonymous
   * read against a public server is exactly what this app did before launches existed. Keeping the
   * method rather than deleting it is what lets `authedFetch` keep one signature across both
   * architectures; keeping it *async* is what lets a future deployment reintroduce a
   * browser-visible credential without touching every call site.
   */
  authorizationHeader(): Promise<string | null>;
}

/**
 * Build the app's view of a session from what `/api/session` said.
 *
 * Total: every field of {@link Session} maps onto one of {@link SmartSession}, except that
 * `serverUrl` is *substituted* rather than copied. The session names the issuer; the app addresses
 * the proxy. Conflating the two is the one mistake this function exists to prevent, which is why
 * both are carried and named for what they are.
 * @param session the session as read from the BFF
 * @returns the session as the app uses it
 * @example
 * const smart = toSmartSession(await fetchSession());
 */
export function toSmartSession(session: Session): SmartSession {
  return {
    serverUrl: proxyBaseUrl(),
    issuer: session.issuer,
    issuerLabel: session.issuerLabel,
    patientId: session.patientId,
    fhirUser: session.fhirUser,
    userDisplay: session.userDisplay,
    grantedScopes: session.grantedScopes ?? "",
    requestedScopes: session.requestedScopes ?? "",
    expiresAt: session.expiresAt,
    authorizationHeader: () => Promise.resolve(null),
  };
}

/**
 * How to refer to whoever is acting, preferring the reference over the name.
 *
 * `Provenance.agent.who` and `Task.requester` both take a `Reference`, and a reference that names a
 * resource on the launched server is worth more than one that carries only a display string: the
 * first can be resolved by anyone reading the record later, the second is an assertion about a
 * person who may not be identifiable at all. So `fhirUser` wins when it was granted, and the
 * display name is the fallback rather than the default.
 * @param session the launched session, or null when nobody is signed in
 * @returns a FHIR `Reference` naming the actor, or undefined when nothing is known about them
 * @example
 * const who = actorReference(session); // { reference: "Practitioner/123", display: "Dr Chen" }
 */
export function actorReference(
  session: SmartSession | null,
): { reference?: string; display?: string } | undefined {
  if (session === null) {
    return undefined;
  }
  const reference = session.fhirUser ?? undefined;
  const display = session.userDisplay ?? undefined;
  if (reference === undefined && display === undefined) {
    return undefined;
  }
  return { ...(reference && { reference }), ...(display && { display }) };
}
