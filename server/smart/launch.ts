/**
 * The launch routes: `GET /launch` and `GET /auth/callback`.
 *
 * Together they implement SMART App Launch for a confidential client, in both the EHR-launch and
 * standalone shapes. The difference between the two is one query parameter and one scope, so
 * they are one route rather than two: an `iss` with a `launch` token is an EHR launch, an `iss`
 * without one is a standalone launch, and everything else about the redirect is identical.
 *
 * Four properties are deliberate.
 *
 * **Nothing is stored until the launch is going to happen.** The issuer is checked against the
 * registry and its SMART configuration is fetched *before* a pending session is created, so a
 * refused launch (FR-003) and an unreachable authorisation server both leave the database
 * exactly as they found it. That is also why the refusal path makes no outbound request at all:
 * the first request a launch makes is for the well-known document of the server being launched
 * from, and an unregistered server should not learn that anyone tried.
 *
 * **PKCE is real.** The verifier is 256 bits of randomness held only in the pending row, and the
 * challenge is its SHA-256. An attacker who intercepts an authorization code cannot exchange it
 * without the verifier, which never leaves this process.
 *
 * **The `state` is the pending session.** It is unique by a database constraint and it is
 * cleared when the session is promoted, so a replayed callback finds nothing to exchange
 * against and cannot disturb the session it already created.
 *
 * **Refusals and failures are pages, not JSON.** These two routes are reached by a browser
 * navigation, so what they answer with has to be readable by the person in front of it. The
 * issuer is named, because the user's next step is to tell whoever configured the launch, and it
 * is HTML-escaped, because an issuer URL arrives from outside.
 * @author John Grimes
 */

import { createHash, randomBytes } from "node:crypto";

import { findIssuerRegistration } from "../config";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "../sessionCookie";
import {
  activateSession,
  createPendingSession,
  deleteSession,
  findPendingSessionByState,
  purgeExpiredSessions,
} from "../sessions";
import { exchangeAuthorizationCode } from "./confidentialClient";
import { discoverSmartConfiguration } from "./discovery";
import { resolveRequesterDisplay } from "./requesterDisplay";

import type { FastifyPluginCallback, FastifyReply } from "fastify";

/** Bytes of entropy in a PKCE verifier: 256 bits, which base64url-encodes to 43 characters. */
const VERIFIER_BYTES = 32;

/** Bytes of entropy in the `state` parameter: 128 bits. */
const STATE_BYTES = 16;

/** The scope that only means something when an EHR supplied launch context. */
const LAUNCH_PATIENT_SCOPE = "launch/patient";

/**
 * OAuth error codes are a restricted vocabulary. An `error` parameter that does not look like
 * one is not repeated, so a hostile redirect cannot use it to write text into our logs.
 */
const OAUTH_ERROR_CODE_PATTERN = /^[\w.:-]{1,64}$/;

/** What a rendered page needs. */
interface PageContent {
  /** Document title and page heading. */
  readonly heading: string;
  /** One or two sentences of plain language, already escaped. */
  readonly body: string;
  /** Target of the retry link, when retrying is meaningful. */
  readonly retryHref?: string;
  /** Label of the retry link. */
  readonly retryLabel?: string;
}

/**
 * Escape text for inclusion in HTML.
 * @param value the raw text
 * @returns the text with the five significant characters escaped
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render one of the two pages these routes can answer with.
 *
 * The styling is inline and minimal: this document is served before the SPA has loaded, and in
 * the refusal case the SPA is never going to load, so it cannot depend on the built stylesheet.
 * It still honours the system colour scheme and reads well on a phone.
 * @param content the heading, body and optional retry link
 * @returns a complete HTML document
 */
function renderPage(content: PageContent): string {
  const retry =
    content.retryHref === undefined
      ? ""
      : `<p><a href="${escapeHtml(content.retryHref)}">${escapeHtml(
          content.retryLabel ?? "Try again",
        )}</a></p>`;
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.heading)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0 auto; max-width: 34rem;
       padding: 2rem 1rem; }
h1 { font-size: 1.375rem; }
code { overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>${escapeHtml(content.heading)}</h1>
<p>${content.body}</p>
${retry}
</body>
</html>
`;
}

/**
 * Read a single-valued query parameter.
 *
 * A repeated parameter arrives as an array, which is treated as absent: nothing this route
 * accepts is legitimately repeated, and picking one of the values would be guesswork.
 * @param query the parsed query string
 * @param name the parameter name
 * @returns the value, or undefined when it is absent, empty or repeated
 */
function readParameter(
  query: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = query[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The `redirect_uri` this app is registered with, derived from the configured origin so that
 * the authorize request and the code exchange can never disagree about it.
 * @param appOrigin the configured application origin
 * @returns the absolute callback URL
 */
function callbackUri(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, "")}/auth/callback`;
}

/**
 * Drop `launch/patient` from a scope string, for a standalone launch where there is no EHR
 * context to be granted.
 * @param scopes the registry's space-separated scope string
 * @returns the scope string a standalone launch asks for
 */
function standaloneScopes(scopes: string): string {
  return scopes
    .split(/\s+/)
    .filter((scope) => scope.length > 0 && scope !== LAUNCH_PATIENT_SCOPE)
    .join(" ");
}

/**
 * Answer with a rendered page at the given status.
 * @param reply the reply to answer on
 * @param status the HTTP status
 * @param content the page content
 * @returns the reply, answered
 */
function sendPage(
  reply: FastifyReply,
  status: number,
  content: PageContent,
): FastifyReply {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(renderPage(content));
}

/**
 * Register the launch routes.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the routes are registered
 * @example
 * fastify.register(launchRoutes);
 */
export const launchRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;
  const redirectUri = callbackUri(config.appOrigin);

  /**
   * EHR and standalone launch entry point.
   *
   * Answers a redirect to the issuer's authorization endpoint, or a page explaining why it
   * will not.
   */
  fastify.get<{ Querystring: Record<string, unknown> }>(
    "/launch",
    async (request, reply) => {
      const db = fastify.appDb;
      purgeExpiredSessions(db);

      const issuer = readParameter(request.query, "iss");
      if (issuer === undefined) {
        return sendPage(reply, 400, {
          heading: "This launch is incomplete",
          body:
            "The launch did not say which server it came from, so there is nothing to sign " +
            "in to. Start again from your clinical system, or choose a server from the app.",
          retryHref: "/",
          retryLabel: "Choose a server",
        });
      }

      const named = `<code>${escapeHtml(issuer)}</code>`;
      let parsed: URL | undefined;
      try {
        parsed = new URL(issuer);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || parsed.protocol !== "https:") {
        return sendPage(reply, 400, {
          heading: "This launch was refused",
          body:
            `The server this launch names, ${named}, is not an <code>https</code> address. ` +
            "Nothing has been sent to it and nothing has been stored.",
          retryHref: "/",
          retryLabel: "Choose a registered server",
        });
      }

      const registration = findIssuerRegistration(config.issuers, issuer);
      if (registration === undefined) {
        return sendPage(reply, 403, {
          heading: "This launch was refused",
          body:
            `This app is not registered with ${named}, so it cannot sign you in to it. ` +
            "Nothing has been sent to that server and nothing has been stored. Ask whoever " +
            "administers this app to register the server if it should be available.",
          retryHref: "/",
          retryLabel: "Choose a registered server",
        });
      }

      let smart;
      try {
        smart = await discoverSmartConfiguration(registration.issuer);
      } catch (error) {
        request.log.error(
          { err: error, issuer: registration.issuer },
          "launch discovery failed",
        );
        return sendPage(reply, 502, {
          heading: "That server could not be reached",
          body:
            `${named} did not answer, so this launch cannot continue. Nothing has been ` +
            "stored. This is usually temporary.",
          retryHref: `/launch?iss=${encodeURIComponent(registration.issuer)}`,
          retryLabel: "Try the launch again",
        });
      }

      const verifier = randomBytes(VERIFIER_BYTES).toString("base64url");
      const state = randomBytes(STATE_BYTES).toString("base64url");
      createPendingSession(db, {
        issuer: registration.issuer,
        state,
        verifier,
      });

      const launchToken = readParameter(request.query, "launch");
      const authorize = new URL(smart.authorizationEndpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set(
        "client_id",
        registration.launchClient.clientId,
      );
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set(
        "scope",
        launchToken === undefined
          ? standaloneScopes(registration.launchClient.scopes)
          : registration.launchClient.scopes,
      );
      authorize.searchParams.set("state", state);
      // The registered form of the issuer, so that `aud` cannot differ from the value the
      // authorisation server knows itself by over a trailing slash.
      authorize.searchParams.set("aud", registration.issuer);
      authorize.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier, "ascii").digest("base64url"),
      );
      authorize.searchParams.set("code_challenge_method", "S256");
      if (launchToken !== undefined) {
        authorize.searchParams.set("launch", launchToken);
      }

      return reply.redirect(authorize.toString(), 302);
    },
  );

  /**
   * The authorization server's redirect back.
   *
   * Answers a redirect to the app root with the session cookie set, or a page explaining why
   * the sign-in did not complete.
   */
  fastify.get<{ Querystring: Record<string, unknown> }>(
    "/auth/callback",
    async (request, reply) => {
      const db = fastify.appDb;
      // Clears pending rows that have timed out, so an expired `state` leaves nothing behind.
      purgeExpiredSessions(db);

      const state = readParameter(request.query, "state");
      const pending =
        state === undefined ? undefined : findPendingSessionByState(db, state);
      if (pending === undefined) {
        return sendPage(reply, 400, {
          heading: "This sign-in could not be completed",
          body:
            "The sign-in this page belongs to was not recognised. It may have already " +
            "finished, or it may have been left too long. Nothing has been stored.",
          retryHref: "/",
          retryLabel: "Start again",
        });
      }

      try {
        const authorizationError = readParameter(request.query, "error");
        if (authorizationError !== undefined) {
          const code = OAUTH_ERROR_CODE_PATTERN.test(authorizationError)
            ? authorizationError
            : "unrecognised";
          throw new Error(`authorization server refused the launch (${code})`);
        }
        const code = readParameter(request.query, "code");
        if (code === undefined) {
          throw new Error("callback carried no authorization code");
        }
        const registration = findIssuerRegistration(
          config.issuers,
          pending.issuer,
        );
        if (registration === undefined) {
          throw new Error(`issuer ${pending.issuer} is no longer registered`);
        }

        const smart = await discoverSmartConfiguration(pending.issuer);
        const token = await exchangeAuthorizationCode({
          tokenEndpoint: smart.tokenEndpoint,
          client: registration.launchClient,
          code,
          redirectUri,
          verifier: pending.verifier,
        });

        // The name is worth a request but not the launch: a lookup that fails leaves the
        // session with whatever the claims said, or with nothing.
        const userDisplay = await resolveRequesterDisplay({
          fhirBase: registration.issuer,
          accessToken: token.accessToken,
          fhirUser: token.fhirUser,
          claimDisplay: token.userDisplay,
          log: request.log,
        });

        const session = activateSession(db, {
          id: pending.id,
          accessToken: token.accessToken,
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + token.expiresIn,
          refreshToken: token.refreshToken,
          patientId: token.patientId,
          userDisplay,
          fhirUser: token.fhirUser,
          grantedScopes: token.grantedScopes,
        });
        reply.setCookie(
          SESSION_COOKIE_NAME,
          session.id,
          SESSION_COOKIE_OPTIONS,
        );
        return reply.redirect("/", 302);
      } catch (error) {
        deleteSession(db, pending.id);
        request.log.error(
          { err: error, issuer: pending.issuer },
          "launch callback failed",
        );
        return sendPage(reply, 502, {
          heading: "This sign-in could not be completed",
          body:
            `Signing in to <code>${escapeHtml(pending.issuer)}</code> did not finish, so you ` +
            "are not signed in and nothing has been stored. This is usually temporary.",
          retryHref: `/launch?iss=${encodeURIComponent(pending.issuer)}`,
          retryLabel: "Try signing in again",
        });
      }
    },
  );

  done();
};
