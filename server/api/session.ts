/**
 * The session API: who am I, log me out, and which servers can I sign in to.
 *
 * These three routes are the whole of what the SPA is told about its own session. The response
 * to `GET /api/session` is assembled field by field rather than derived from the session row,
 * because the row holds the launch token and its refresh token: an accidental spread would put
 * both in a response body. The same applies to `GET /api/issuers`, which projects the registry
 * down to the two fields the standalone picker needs and drops the client credentials.
 *
 * `POST /api/logout` answers `204` whether or not the cookie named a live session. Logging out
 * is not an assertion about state, it is a request to have none, and a client clearing a stale
 * cookie should not have to handle an error to do it. Nothing is disclosed either way.
 * @author John Grimes
 */

import { findIssuerRegistration } from "../config";
import {
  readSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "../sessionCookie";
import { deleteSession, findActiveSession } from "../sessions";

import type { FastifyPluginCallback } from "fastify";

/** What `GET /api/session` answers with. Every field here is safe to give a browser. */
export interface SessionResponse {
  /** FHIR base URL of the launched server. */
  readonly issuer: string;
  /** Its human-readable name from the registry. */
  readonly issuerLabel: string;
  /** Launch context patient, when the launch carried one. */
  readonly patientId: string | null;
  /** Display name for the signed-in user, when one is known. */
  readonly userDisplay: string | null;
  /** Access token expiry in epoch seconds, so the SPA can anticipate a re-launch. */
  readonly expiresAt: number;
}

/** One entry of `GET /api/issuers`. */
export interface IssuerListEntry {
  /** FHIR base URL to launch against. */
  readonly issuer: string;
  /** Human-readable name. */
  readonly label: string;
}

/**
 * Register the session API.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the routes are registered
 * @example
 * fastify.register(sessionRoutes);
 */
export const sessionRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;

  /** The signed-in session, or `401` when there is not one. */
  fastify.get("/api/session", async (request, reply) => {
    const sessionId = readSessionCookie(request);
    const session =
      sessionId === undefined
        ? undefined
        : findActiveSession(fastify.appDb, sessionId);
    if (session === undefined) {
      return reply.code(401).send({ error: "no-session" });
    }
    const registration = findIssuerRegistration(config.issuers, session.issuer);
    const body: SessionResponse = {
      issuer: session.issuer,
      issuerLabel: registration?.label ?? session.issuer,
      patientId: session.patientId,
      userDisplay: session.userDisplay,
      expiresAt: session.accessTokenExpiresAt,
    };
    return reply.send(body);
  });

  /** Discard the session and the cookie that pointed at it. */
  fastify.post("/api/logout", async (request, reply) => {
    const sessionId = readSessionCookie(request);
    if (sessionId !== undefined) {
      deleteSession(fastify.appDb, sessionId);
    }
    // Cleared with the same attributes it was set with, or the browser keeps the original.
    reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    return reply.code(204).send();
  });

  /** The registry, reduced to what a standalone launch picker may know (FR-002, FR-007). */
  fastify.get("/api/issuers", () =>
    config.issuers.map((registration): IssuerListEntry => ({
      issuer: registration.issuer,
      label: registration.label,
    })),
  );

  done();
};
