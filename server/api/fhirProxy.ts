/**
 * `ALL /api/fhir/*`: the SPA's only route to the launched FHIR server.
 *
 * Every questionnaire, patient, response and Task the requester reads or writes goes through
 * here (FR-004), which is what allows the launch token to stay on the server (FR-005). The
 * browser addresses the proxy exactly as it would address the FHIR base - `/api/fhir/Task?
 * status=requested` in place of `{issuer}/Task?status=requested` - and the proxy adds the one
 * thing the browser does not have.
 *
 * The interesting parts are the boundaries.
 *
 * **The request is rebuilt, not relayed.** Headers the browser sent that would confuse or
 * compromise the upstream are dropped: its own `Authorization` (which would otherwise let a
 * page attempt to use a token of its choosing), the session cookie (which the FHIR server has
 * no business seeing), and the hop-by-hop headers that belong to this connection rather than the
 * next one. The path suffix is taken from the raw URL rather than the decoded route parameter,
 * so percent-encoded identifiers survive the trip unchanged.
 *
 * **The suffix cannot leave the issuer.** A `..` segment, an absolute URL and a
 * protocol-relative path are all refused, and the resolved URL is checked to still start with
 * the issuer base. Without that, a request for `/api/fhir/../../oauth/token` would be a
 * server-side request forgery with the session's bearer token attached.
 *
 * **Expiry is handled once, not twice.** An expired token is refreshed before the request is
 * made; a `401` from the upstream is retried once through a refresh in case the server disagreed
 * about the expiry. Anything left after that is a session that cannot be rescued, so the row is
 * deleted and the SPA is told `session-expired` - its cue to offer a re-launch rather than an
 * error (US1 acceptance scenario 4).
 *
 * The response travels back with its status, body and content type intact, plus the few headers
 * FHIR clients act on. Nothing else from the upstream is copied: a `Set-Cookie` or
 * `WWW-Authenticate` from the FHIR server has no meaning on this origin.
 * @author John Grimes
 */

import { findIssuerRegistration } from "../config";
import { readSessionCookie } from "../sessionCookie";
import {
  deleteSession,
  findActiveSessionIgnoringExpiry,
  updateSessionTokens,
} from "../sessions";
import { refreshLaunchToken } from "../smart/confidentialClient";
import { discoverSmartConfiguration } from "../smart/discovery";

import type { ActiveSession } from "../sessions";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";

/** The route prefix, stripped from the raw URL to leave the FHIR path suffix. */
const ROUTE_PREFIX = "/api/fhir/";

/**
 * Margin applied to the stored expiry, so a token that is about to lapse is refreshed before it
 * is used rather than after it fails.
 */
const EXPIRY_MARGIN_SECONDS = 10;

/**
 * Request headers that must not be forwarded: the ones that belong to this hop, the ones that
 * would carry the browser's credentials to the FHIR server, and `accept-encoding`, because the
 * fetch client negotiates and decodes its own compression.
 */
const STRIPPED_REQUEST_HEADERS: Record<string, true> = {
  "accept-encoding": true,
  authorization: true,
  connection: true,
  "content-length": true,
  cookie: true,
  expect: true,
  host: true,
  "keep-alive": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

/** Response headers passed back to the browser. Nothing else from the upstream is copied. */
const RELAYED_RESPONSE_HEADERS = [
  "content-type",
  "content-location",
  "etag",
  "last-modified",
  "location",
];

/**
 * Build the upstream URL for a proxied request, or refuse it.
 * @param issuer the session's FHIR base URL
 * @param suffix the still-encoded path suffix from the raw request URL
 * @param query the raw query string, including its leading `?`, or the empty string
 * @returns the absolute upstream URL, or undefined when the suffix is not addressing something
 *   inside the issuer's FHIR base
 * @example
 * upstreamUrl("https://ehr/fhir", "Task/t-1", "?_count=1");
 * // "https://ehr/fhir/Task/t-1?_count=1"
 */
function upstreamUrl(
  issuer: string,
  suffix: string,
  query: string,
): string | undefined {
  if (suffix.length === 0 || suffix.startsWith("/") || suffix.includes("\\")) {
    return undefined;
  }
  // An absolute URL as the suffix, however it is spelled.
  if (/^[a-z][\d+.a-z-]*:/i.test(suffix)) {
    return undefined;
  }
  // Traversal, whether it arrives literally, percent-encoded, or with its separators encoded
  // so that a server which decodes before resolving would see a different path than we do.
  for (const segment of suffix.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    for (const part of decoded.split("/")) {
      if (part === ".." || part === ".") {
        return undefined;
      }
    }
  }

  const base = `${issuer.replace(/\/+$/, "")}/`;
  let resolved: URL;
  try {
    resolved = new URL(`${suffix}${query}`, base);
  } catch {
    return undefined;
  }
  return resolved.href.startsWith(base) ? resolved.href : undefined;
}

/**
 * Copy the request headers worth forwarding, and attach the session's authority.
 * @param request the incoming request
 * @param accessToken the session's launch access token
 * @returns the headers to make the upstream request with
 */
function upstreamHeaders(
  request: FastifyRequest,
  accessToken: string,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS[name] === true) {
      continue;
    }
    for (const single of Array.isArray(value) ? value : [value]) {
      headers.append(name, single);
    }
  }
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

/**
 * Register the FHIR proxy route.
 *
 * The plugin replaces its own content type parsers with one that keeps every body as a buffer,
 * so a request body is forwarded byte for byte rather than parsed and re-serialised. Because the
 * plugin is registered without `fastify-plugin`, that applies to this route alone; the JSON API
 * routes elsewhere on the instance still parse their bodies normally.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the route is registered
 * @example
 * fastify.register(fhirProxyRoutes);
 */
export const fhirProxyRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;

  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  /**
   * Exchange the session's refresh token for a fresh access token.
   * @param request the request being served, for its logger
   * @param session the session to refresh
   * @returns the updated session, or undefined when it cannot be refreshed
   */
  async function refreshSession(
    request: FastifyRequest,
    session: ActiveSession,
  ): Promise<ActiveSession | undefined> {
    if (session.refreshToken === null) {
      return undefined;
    }
    const registration = findIssuerRegistration(config.issuers, session.issuer);
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
      return updateSessionTokens(fastify.appDb, {
        id: session.id,
        accessToken: token.accessToken,
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + token.expiresIn,
        refreshToken: token.refreshToken ?? session.refreshToken,
      });
    } catch (error) {
      request.log.warn(
        { err: error, issuer: session.issuer },
        "session refresh failed",
      );
      return undefined;
    }
  }

  fastify.all("/api/fhir/*", async (request, reply) => {
    const db = fastify.appDb;
    const sessionId = readSessionCookie(request);
    if (sessionId === undefined) {
      return reply.code(401).send({ error: "no-session" });
    }
    let session = findActiveSessionIgnoringExpiry(db, sessionId);
    if (session === undefined) {
      return reply.code(401).send({ error: "no-session" });
    }

    const queryStart = request.url.indexOf("?");
    const rawPath =
      queryStart === -1 ? request.url : request.url.slice(0, queryStart);
    const query = queryStart === -1 ? "" : request.url.slice(queryStart);
    const target = rawPath.startsWith(ROUTE_PREFIX)
      ? upstreamUrl(session.issuer, rawPath.slice(ROUTE_PREFIX.length), query)
      : undefined;
    if (target === undefined) {
      return reply.code(400).send({ error: "invalid-path" });
    }

    // A body of `undefined` (no request body) is what `fetch` wants for a GET; anything else is
    // the raw buffer the content type parser kept.
    const body = request.body instanceof Buffer ? request.body : undefined;

    let refreshed = false;
    if (
      session.accessTokenExpiresAt - EXPIRY_MARGIN_SECONDS <=
      Math.floor(Date.now() / 1000)
    ) {
      const next = await refreshSession(request, session);
      if (next === undefined) {
        deleteSession(db, session.id);
        return reply.code(401).send({ error: "session-expired" });
      }
      session = next;
      refreshed = true;
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders(request, session.accessToken),
        body,
      });
      if (upstream.status === 401 && !refreshed) {
        const next = await refreshSession(request, session);
        if (next !== undefined) {
          session = next;
          upstream = await fetch(target, {
            method: request.method,
            headers: upstreamHeaders(request, session.accessToken),
            body,
          });
        }
      }
    } catch (error) {
      request.log.error(
        { err: error, issuer: session.issuer, method: request.method },
        "proxied FHIR request failed",
      );
      return reply.code(502).send({ error: "upstream-unreachable" });
    }

    if (upstream.status === 401) {
      deleteSession(db, session.id);
      return reply.code(401).send({ error: "session-expired" });
    }

    reply.code(upstream.status);
    for (const name of RELAYED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        reply.header(name, value);
      }
    }
    if (upstream.status === 204 || upstream.status === 304) {
      return reply.send();
    }
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });

  done();
};
