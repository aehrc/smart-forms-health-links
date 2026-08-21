/**
 * The session cookie.
 *
 * The cookie carries the opaque session id and nothing else: no token, no issuer, no claim
 * about the user (FR-005). Its attributes are fixed rather than configurable, because every one
 * of them is load bearing - `HttpOnly` keeps the id out of reach of any script on the page,
 * `Secure` keeps it off plain HTTP, `SameSite=Lax` still allows the top-level redirect back from
 * the authorisation server to arrive with the cookie set, and `Path=/` matches the fact that one
 * origin serves both the SPA and the API.
 *
 * The name and attributes live here, apart from the routes, because three modules need them in
 * lockstep: the callback sets the cookie, the session API reads and clears it, and the FHIR
 * proxy reads it.
 * @author John Grimes
 */

import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyRequest } from "fastify";

/** Name of the cookie carrying the opaque session id. */
export const SESSION_COOKIE_NAME = "shl_session";

/** Attributes every session cookie is written with, including when it is cleared. */
export const SESSION_COOKIE_OPTIONS: CookieSerializeOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};

/**
 * Read the session id a request carries, if it carries one.
 *
 * An empty cookie value is treated as no cookie at all, so that a browser holding a cleared
 * cookie is indistinguishable from one that never had a session.
 * @param request the incoming request
 * @returns the session id, or undefined when there is no usable cookie
 * @example
 * const sessionId = readSessionCookie(request);
 * if (sessionId === undefined) return reply.code(401).send({ error: "no-session" });
 */
export function readSessionCookie(request: FastifyRequest): string | undefined {
  const value = request.cookies[SESSION_COOKIE_NAME];
  return value === undefined || value.length === 0 ? undefined : value;
}
