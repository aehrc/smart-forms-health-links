/**
 * Fastify bootstrap: one origin serving the built SPA, the public SHL routes and the
 * session-gated API.
 *
 * The server is assembled by {@link buildServer} from a loaded configuration and an open
 * database, so tests can drive it through `inject` without binding a port, and so the process
 * entry point at the bottom of this file is only a few lines of wiring.
 *
 * Two structural decisions are worth stating.
 *
 * **The SPA fallback.** `@fastify/static` is registered with `wildcard: false`, which globs the
 * built files at startup and registers a route for each. Anything it does not match reaches the
 * not-found handler, which serves `index.html` for browser routes so that `/view#shlink:/…` and
 * other client-side paths render. Reserved prefixes ({@link RESERVED_PREFIXES}) are excluded
 * from that rewrite: a missing API route must answer as an API route, not as an HTML page that
 * a fetch client would then fail to parse.
 *
 * **Nothing sensitive is serialised.** The error handler answers with a stable code and never
 * with the error's own text, and the logger redacts every field that could carry grant material
 * ({@link LOG_REDACTION_PATHS}). Minted access tokens, launch tokens, refresh tokens, client
 * secrets and private keys are never logged and never persisted outside the session row
 * (FR-018).
 * @author John Grimes
 */

import { fastifyCookie } from "@fastify/cookie";
import { fastifyStatic } from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fhirProxyRoutes } from "./api/fhirProxy";
import { invitationRoutes } from "./api/invitations";
import { sessionRoutes } from "./api/session";
import { loadServerConfig } from "./config";
import { openDatabase } from "./db";
import { manifestRoutes } from "./shl/manifest";
import { publicJwks } from "./smart/backendServices";
import { launchRoutes } from "./smart/launch";

import type { ServerConfig } from "./config";
import type { AppDatabase } from "./db";
import type {
  FastifyError,
  FastifyInstance,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    /** The loaded configuration, for route modules registered on this instance. */
    appConfig: ServerConfig;
    /** The open database, for route modules registered on this instance. */
    appDb: AppDatabase;
  }
}

/**
 * Path prefixes that belong to the server rather than to the SPA router. A request for one of
 * these that matches no route is a 404 in JSON, never the SPA shell.
 */
const RESERVED_PREFIXES = [
  "/api",
  "/shl",
  "/launch",
  "/auth",
  "/health",
  "/.well-known",
];

/**
 * Fields redacted from every log line.
 *
 * Header paths cover the request and response as Fastify serialises them; the bare and
 * wildcarded property names cover anything an OAuth payload might be logged inside. Grant
 * material - minted access tokens, launch and refresh tokens, client secrets, client assertions
 * and private keys - is never deliberately logged; this list is the backstop (FR-018).
 */
export const LOG_REDACTION_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "access_token",
  "*.access_token",
  "refresh_token",
  "*.refresh_token",
  "client_secret",
  "*.client_secret",
  "client_assertion",
  "*.client_assertion",
  "secret",
  "*.secret",
];

/**
 * Request serialiser for the log.
 *
 * Pino's default drops the query string nowhere, and on this server the query string is where
 * the secrets are: `/launch?launch=…` carries the EHR's launch token and `/auth/callback?code=…`
 * carries the authorization code. Neither may reach a log line (FR-018 and the invariants in
 * `contracts/http-api.md`), so the logged URL is the path a route matched and nothing more.
 * @param request the request being logged
 * @returns the fields worth logging about it
 */
function serialiseRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: pathOf(request.url),
    remoteAddress: request.ip,
  };
}

/**
 * Combine a caller's logger configuration with the redaction and serialisation the invariants
 * require.
 *
 * A caller may set the level or supply a stream - the tests capture output that way - but may
 * not switch off redaction or restore the query string to the logged URL, so the safety
 * settings are applied last. `false` (silence) and `true` (defaults) pass through unchanged.
 * @param supplied the caller's `logger` option, if any
 * @returns the logger configuration to build Fastify with
 */
function loggerConfiguration(
  supplied: BuildServerOptions["logger"],
): FastifyServerOptions["logger"] {
  const safety = {
    redact: { paths: [...LOG_REDACTION_PATHS], censor: "[redacted]" },
    serializers: { req: serialiseRequest },
  };
  if (supplied === undefined) {
    return safety;
  }
  if (typeof supplied !== "object") {
    return supplied;
  }
  return { ...supplied, ...safety };
}

/** Arguments for building the server. */
export interface BuildServerOptions {
  /** The loaded configuration. */
  readonly config: ServerConfig;
  /** The open, migrated database. */
  readonly db: AppDatabase;
  /**
   * Directory holding the built SPA. Defaults to `dist/` beside this module. When it does not
   * exist the server runs API-only, which is what development looks like: the `Procfile` runs
   * Vite for the SPA and this process for the API.
   */
  readonly staticRoot?: string;
  /** Logger configuration, or `false` to silence it. Defaults to the redacting logger. */
  readonly logger?: FastifyServerOptions["logger"];
}

/**
 * Strip the query string, leaving the path a route would have matched.
 * @param url the raw request URL
 * @returns the path portion
 */
function pathOf(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Assemble the server.
 * @param options the configuration, database, static root and logger
 * @returns the configured Fastify instance, not yet listening
 * @example
 * const server = buildServer({ config, db });
 * await server.listen({ port: config.port });
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { config, db } = options;
  const staticRoot =
    options.staticRoot ?? fileURLToPath(new URL("../dist", import.meta.url));
  const hasBuiltSpa = existsSync(staticRoot);

  const fastify = Fastify({ logger: loggerConfiguration(options.logger) });

  // Available to every route module registered below.
  fastify.decorate("appConfig", config);
  fastify.decorate("appDb", db);

  fastify.register(fastifyCookie, { secret: config.cookieSecret });

  if (hasBuiltSpa) {
    fastify.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      // Register a route per built file, so unmatched paths fall through to the SPA rewrite in
      // the not-found handler below.
      wildcard: false,
    });
  } else {
    fastify.log.warn(
      { staticRoot },
      "no built SPA at the static root; serving the API only",
    );
  }

  /** Liveness and readiness probe. Public, and says nothing about configuration. */
  fastify.get("/health", () => ({ status: "ok" }));

  /**
   * The Backend Services client's public JWKS, registered as `jwks_uri` on the authorisation
   * server. Public members only - {@link publicJwks} strips the private half.
   */
  fastify.get("/.well-known/jwks.json", () => publicJwks(config.issuers));

  // ---------------------------------------------------------------------------------------
  // Route registration.
  //
  // Each module is a Fastify plugin reading `fastify.appConfig` and `fastify.appDb`. They are
  // registered without `fastify-plugin`, so each gets its own encapsulated context: that is what
  // lets the FHIR proxy replace the content type parsers for its own route without changing how
  // the JSON API routes parse their bodies.
  //
  // What each one adds, in the order below:
  //
  //   launchRoutes      GET  /launch            - EHR and standalone launch entry point
  //                     GET  /auth/callback     - authorisation code exchange
  //   sessionRoutes     GET  /api/session       - what the SPA is allowed to know about itself
  //                     POST /api/logout        - drop the session row and its cookie
  //                     GET  /api/issuers       - the registry a standalone picker may know
  //   fhirProxyRoutes   ALL  /api/fhir/*        - the SPA's only route to the launched server
  //   invitationRoutes  POST /api/invitations   - mint one, publish its Task, store the payload
  //   manifestRoutes    POST /shl/:id           - the public SHL manifest
  //
  // Anything registered under a path outside RESERVED_PREFIXES must also be added there, or
  // the SPA rewrite will shadow its 404s.
  // ---------------------------------------------------------------------------------------

  fastify.register(launchRoutes);
  fastify.register(sessionRoutes);
  fastify.register(fhirProxyRoutes);
  fastify.register(invitationRoutes);
  fastify.register(manifestRoutes);

  /**
   * SPA rewrite. A browser navigation that matches no built file and no reserved prefix gets
   * the SPA shell, so client-side routing takes over.
   */
  fastify.setNotFoundHandler((request, reply) => {
    const path = pathOf(request.url);
    const isReserved = RESERVED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    const isNavigation = request.method === "GET" || request.method === "HEAD";
    if (hasBuiltSpa && isNavigation && !isReserved) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not-found" });
  });

  /**
   * Structured error surface. The response carries a code and nothing else, because an error's
   * text is not guaranteed to be free of whatever it was handling.
   */
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    request.log.error(
      {
        err: error,
        statusCode,
        method: request.method,
        path: pathOf(request.url),
      },
      "request failed",
    );
    return reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? "internal-error" : "bad-request" });
  });

  return fastify;
}

/**
 * Signals that mean "stop", and are worth stopping cleanly for.
 *
 * Kubernetes sends `SIGTERM` and then waits out `terminationGracePeriodSeconds` before
 * `SIGKILL`. Without a handler the process ignores it, so every rollout pays the whole grace
 * period and any request in flight dies mid-response.
 */
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Process entry point: load configuration, open the database, listen, and stop cleanly.
 * @returns nothing; resolves once the server is listening
 * @throws {Error} when configuration is invalid, the database cannot be opened, or the port
 *   cannot be bound
 */
async function main(): Promise<void> {
  const config = loadServerConfig();
  const db = openDatabase(config.sqlitePath);
  const server = buildServer({ config, db });

  let stopping = false;
  const stop = (signal: string): void => {
    // A second signal during shutdown is impatience, not new information.
    if (stopping) {
      return;
    }
    stopping = true;
    server.log.info({ signal }, "shutting down");
    void server
      .close()
      .then(() => {
        // Only after the last handler has returned, so nothing writes to a closed handle.
        db.close();
      })
      .catch((error: unknown) => {
        server.log.error({ err: error }, "shutdown failed");
        process.exitCode = 1;
      });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, stop);
  }

  await server.listen({ port: config.port, host: "0.0.0.0" });
}

// Only run when this module is the process entry point, so importing it (from a test, or from
// a future operational script) does not bind a port.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `Server failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
