/**
 * Acting on the launched server with a session's authority.
 *
 * Two routes now make FHIR requests on a requester's behalf - the proxy the SPA reads and
 * writes through (`server/api/fhirProxy.ts`) and the mint that publishes the request Task
 * (`server/api/invitations.ts`) - and both have to answer the same question first: is this
 * session's access token still good, and if not, can it be rescued? Answering it in one place
 * matters more than the few lines it saves. A second copy that drifted would mean a session
 * that the proxy considers live and the mint considers dead, which reads to the user as the
 * app losing their sign-in halfway through an action.
 *
 * Nothing here ever returns, logs or throws token material: a refresh that fails is reported as
 * `undefined` and logged as the issuer it failed against (FR-018).
 * @author John Grimes
 */

import { findIssuerRegistration } from "../config";
import { updateSessionTokens } from "../sessions";
import { refreshLaunchToken } from "./confidentialClient";
import { discoverSmartConfiguration } from "./discovery";

import type { IssuerRegistration } from "../config";
import type { AppDatabase } from "../db";
import type { ActiveSession } from "../sessions";
import type { FastifyBaseLogger } from "fastify";

/**
 * Margin applied to the stored expiry, so a token that is about to lapse is refreshed before it
 * is used rather than after it fails.
 */
export const EXPIRY_MARGIN_SECONDS = 10;

/** What a caller has to hand for a session to be refreshed on its behalf. */
export interface SessionAuthorityContext {
  /** The open database, where the refreshed tokens are written. */
  readonly db: AppDatabase;
  /** The issuer registry, for the confidential client the refresh authenticates as. */
  readonly issuers: readonly IssuerRegistration[];
  /** The request's logger, so a failed refresh is attributable to the request it broke. */
  readonly log: FastifyBaseLogger;
}

/**
 * Exchange a session's refresh token for a fresh access token.
 * @param context the database, issuer registry and logger
 * @param session the session to refresh
 * @returns the updated session, or undefined when it holds no refresh token, its issuer is no
 *   longer registered, or the authorisation server refused
 * @example
 * const next = await refreshSessionTokens({ db, issuers, log: request.log }, session);
 */
export async function refreshSessionTokens(
  context: SessionAuthorityContext,
  session: ActiveSession,
): Promise<ActiveSession | undefined> {
  if (session.refreshToken === null) {
    return undefined;
  }
  const registration = findIssuerRegistration(context.issuers, session.issuer);
  if (registration === undefined) {
    return undefined;
  }
  try {
    const smart = await discoverSmartConfiguration(session.issuer);
    const token = await refreshLaunchToken({
      tokenEndpoint: smart.tokenEndpoint,
      client: registration.launchClient,
      refreshToken: session.refreshToken,
    });
    return updateSessionTokens(context.db, {
      id: session.id,
      accessToken: token.accessToken,
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + token.expiresIn,
      refreshToken: token.refreshToken ?? session.refreshToken,
    });
  } catch (error) {
    context.log.warn(
      { err: error, issuer: session.issuer },
      "session refresh failed",
    );
    return undefined;
  }
}

/**
 * A session whose access token is good for the request about to be made.
 *
 * A token within {@link EXPIRY_MARGIN_SECONDS} of its stated expiry is refreshed first, so the
 * request is not spent discovering what the clock already said.
 * @param context the database, issuer registry and logger
 * @param session the session about to be used
 * @returns the session to use - the original one when it is still good, a refreshed one when it
 *   was not - or undefined when it has expired and cannot be refreshed
 * @example
 * const usable = await freshSession({ db, issuers, log: request.log }, session);
 * if (usable === undefined) {
 *   deleteSession(db, session.id);
 *   return reply.code(401).send({ error: "session-expired" });
 * }
 */
export async function freshSession(
  context: SessionAuthorityContext,
  session: ActiveSession,
): Promise<ActiveSession | undefined> {
  const lapsing =
    session.accessTokenExpiresAt - EXPIRY_MARGIN_SECONDS <=
    Math.floor(Date.now() / 1000);
  return lapsing ? refreshSessionTokens(context, session) : session;
}
