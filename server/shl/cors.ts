/**
 * Cross-origin access to the public SHL routes, so a patient app running in a browser can open a
 * link and send the answers back.
 *
 * Everything under `/shl` answers any origin by default. Everything else answers none.
 *
 * ```text
 * POST /shl/:id                  manifest           ──> Access-Control-Allow-Origin: *
 * ALL  /shl/:id/fhir/*           facade write       ──> Access-Control-Allow-Origin: *
 * GET  /shl/slot/:id, PUT …      write slot         ──> Access-Control-Allow-Origin: *
 * /api/*, /launch, /auth/*       session cookie     ──> no CORS headers at all
 * ```
 *
 * Four decisions are worth stating.
 *
 * **Any origin by default, because nothing here is ambient.** CORS protects credentials a browser attaches
 * on its own, which means cookies. The `/shl` routes take none: the manifest is public to whoever
 * holds the link, and every write is authorised by a bearer token the caller has to put in the
 * header deliberately. A hostile page gains nothing it could not get with `curl`. Credentials are
 * therefore never allowed, which is also what `*` requires.
 *
 * A deployment that only wants to serve apps it knows sets `SHL_CORS_ORIGINS` to a list of
 * origins. Each route then names the caller's origin back only when it is on the list, and adds
 * `Vary: Origin` so a cache cannot hand one origin's answer to another. A caller not on the list
 * gets no CORS headers, and its preflight falls through to the not-found handler, so the browser
 * blocks it.
 *
 * **The session routes stay closed.** `/api/*` is authorised by the session cookie, so a
 * permissive policy there would let any page read and write as whoever is signed in. The prefix
 * check is the whole of that guarantee, and the tests assert it from the outside.
 *
 * **Any request header, too.** A preflight is told yes to whichever headers it asks about. Other
 * FHIR clients send headers ours does not, and one missing name blocks the whole request; no header
 * can carry ambient authority here, so there is nothing to withhold.
 *
 * **A hook rather than a route.** It runs at `onRequest`, before routing has an opinion, so the
 * headers reach every answer under `/shl` - including the 401s, 404s and 412s a browser app needs
 * to see to tell a used link from a network failure. A preflight is answered here too, because no
 * route is registered for `OPTIONS` and the not-found handler would otherwise refuse it.
 *
 * Kill the Clipboard asks patient apps to serve the same policy in the other direction (its
 * "SHOULD serve a permissive CORS policy"); this is the requester's half of that arrangement.
 * @author Clinton Gillespie
 */

import type { ShlCorsOrigins } from "../config";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Path prefix of every public SHL route: manifests, the facade and write slots. */
export const PUBLIC_SHL_PREFIX = "/shl";

/** Methods the public routes answer. */
const ALLOWED_METHODS = "GET, POST, PUT, OPTIONS";

/**
 * Request headers allowed when a preflight names none.
 *
 * A preflight that does name some gets those back instead ({@link allowedHeaders}). This list is
 * what our own filler sends, and it is written out rather than `*` because the wildcard does not
 * cover `Authorization` - the one header every write depends on.
 */
const DEFAULT_ALLOWED_HEADERS = "Authorization, Content-Type, If-Match, Accept";

/** One header name, as RFC 9110 defines a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Response headers a browser app may read.
 *
 * `ETag` is how a write slot reports its version for the conditional write, and `Location` and
 * `Content-Location` are where a FHIR write reports what it created. Without this list a browser
 * hides all three.
 */
const EXPOSED_HEADERS = "ETag, Location, Content-Location";

/**
 * How long, in seconds, a browser may cache a preflight. Ten minutes covers a form being filled in
 * without making a policy change wait a day to take effect.
 */
const PREFLIGHT_MAX_AGE_SECONDS = "600";

/**
 * Whether a request path is one of the public SHL routes.
 * @param url the raw request URL, query string and all
 * @returns true for `/shl` and anything beneath it
 */
function isPublicShlPath(url: string): boolean {
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path === PUBLIC_SHL_PREFIX || path.startsWith(`${PUBLIC_SHL_PREFIX}/`);
}

/**
 * The request headers to allow, for one preflight.
 *
 * Whatever the preflight asks for, because other FHIR clients send headers ours does not -
 * `Prefer`, `Cache-Control`, a tracing id - and a browser blocks the whole request if any one of
 * them is missing from the answer. Allowing them gives nothing away: no header can carry ambient
 * authority to these routes, for the same reason any origin is safe. Names that are not valid
 * header tokens are dropped rather than echoed.
 * @param requested the preflight's `Access-Control-Request-Headers`, if it sent one
 * @returns the value for `Access-Control-Allow-Headers`
 */
function allowedHeaders(requested: string | string[] | undefined): string {
  const names = [requested ?? []]
    .flat()
    .flatMap((value) => value.split(","))
    .map((name) => name.trim())
    .filter((name) => HEADER_NAME.test(name));
  return names.length === 0 ? DEFAULT_ALLOWED_HEADERS : names.join(", ");
}

/**
 * Build the `onRequest` hook that adds the CORS headers to a public SHL request and answers its
 * preflight.
 *
 * A request outside `/shl` passes through untouched, and so does one from an origin the
 * configuration does not allow. An `OPTIONS` request carrying `Access-Control-Request-Method` is a
 * preflight and is answered here with `204`; any other request continues to its route with the
 * headers already set.
 * @param allowedOrigins `"*"` for any origin, or the exact origins allowed
 * @returns the hook
 * @example
 * fastify.addHook("onRequest", publicShlCors(config.shlCorsOrigins));
 */
export function publicShlCors(allowedOrigins: ShlCorsOrigins) {
  const anyOrigin = allowedOrigins === "*";
  const listed = new Set(anyOrigin ? [] : allowedOrigins);

  return async function publicShlCorsHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    if (!isPublicShlPath(request.url)) {
      return undefined;
    }

    // With a list, the answer depends on who asked, so a cache must key on it - allowed or not.
    const vary = anyOrigin ? [] : ["Origin"];
    if (!anyOrigin) {
      reply.header("vary", vary.join(", "));
    }

    const origin = request.headers.origin;
    let allowOrigin: string | undefined;
    if (anyOrigin) {
      allowOrigin = "*";
    } else if (origin !== undefined && listed.has(origin)) {
      allowOrigin = origin;
    }
    if (allowOrigin === undefined) {
      return undefined;
    }

    reply.header("access-control-allow-origin", allowOrigin);
    reply.header("access-control-expose-headers", EXPOSED_HEADERS);

    const isPreflight =
      request.method === "OPTIONS" &&
      request.headers["access-control-request-method"] !== undefined;
    if (!isPreflight) {
      return undefined;
    }

    return reply
      .code(204)
      .header("access-control-allow-methods", ALLOWED_METHODS)
      .header(
        "access-control-allow-headers",
        allowedHeaders(request.headers["access-control-request-headers"]),
      )
      .header("vary", [...vary, "Access-Control-Request-Headers"].join(", "))
      .header("access-control-max-age", PREFLIGHT_MAX_AGE_SECONDS)
      .send();
  };
}
