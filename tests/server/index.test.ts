/**
 * Tests for `server/index.ts`: the Fastify bootstrap.
 *
 * Three properties matter here. The SPA fallback has to be generous enough that a deep link
 * such as `/view#shlink:/…` renders, and narrow enough that a missing API route answers as an
 * API route rather than quietly returning an HTML page. The JWKS route has to publish only
 * public key members. And the error handler has to keep whatever an error happens to say out
 * of the response body.
 * @author John Grimes
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../server/db";
import { LOG_REDACTION_PATHS, buildServer } from "../../server/index";

import type { ServerConfig } from "../../server/config";
import type { AppDatabase } from "../../server/db";
import type { FastifyInstance } from "fastify";

/** A distinctive fake private exponent, so leak assertions have something to look for. */
const FAKE_PRIVATE_EXPONENT = "fake-private-exponent-do-not-log";

/**
 * A configuration with one registered issuer.
 * @param sqlitePath unused by the routes under test, but part of the shape
 * @returns a complete server configuration
 */
function testConfig(sqlitePath: string): ServerConfig {
  return {
    appOrigin: "https://app.example.org",
    sqlitePath,
    issuerRegistryPath: "/dev/null",
    cookieSecret: "0123456789abcdef0123456789abcdef",
    port: 3000,
    issuers: [
      {
        issuer: "https://ehr.example.org/fhir",
        label: "Example EHR",
        launchClient: {
          clientId: "launch-client",
          clientSecret: "launch-secret-never-logged",
          scopes: "openid fhirUser launch",
        },
        backendClient: {
          clientId: "backend-client",
          privateKeyJwk: {
            kty: "RSA",
            kid: "backend-key-1",
            n: "public-modulus",
            e: "AQAB",
            d: FAKE_PRIVATE_EXPONENT,
          },
          scopes: "system/QuestionnaireResponse.c system/Task.r system/Task.u",
        },
        grantTtlSeconds: 3600,
      },
    ],
  };
}

describe("Fastify bootstrap", () => {
  let directory: string;
  let db: AppDatabase;
  let server: FastifyInstance;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "shl-server-"));
    const staticRoot = path.join(directory, "dist");
    mkdirSync(path.join(staticRoot, "assets"), { recursive: true });
    writeFileSync(
      path.join(staticRoot, "index.html"),
      "<!doctype html><title>SPA-SHELL-MARKER</title>",
      "utf8",
    );
    writeFileSync(
      path.join(staticRoot, "assets", "app.js"),
      "// BUILT-ASSET-MARKER",
      "utf8",
    );

    db = openDatabase(path.join(directory, "app.db"));
    server = buildServer({
      config: testConfig(path.join(directory, "app.db")),
      db,
      staticRoot,
      logger: false,
    });
  });

  afterEach(async () => {
    await server.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  describe("operational routes", () => {
    it("reports health", async () => {
      const response = await server.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>().status).toBe("ok");
    });

    it("publishes the backend client's public JWKS and nothing private", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/.well-known/jwks.json",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ keys: Record<string, unknown>[] }>();
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kid).toBe("backend-key-1");
      expect(body.keys[0].n).toBe("public-modulus");
      expect(Object.hasOwn(body.keys[0], "d")).toBe(false);
      expect(response.body).not.toContain(FAKE_PRIVATE_EXPONENT);
    });
  });

  describe("static hosting and the SPA fallback", () => {
    it("serves a built asset from the static root", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/assets/app.js",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("BUILT-ASSET-MARKER");
    });

    it("serves the SPA shell at the root", async () => {
      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("SPA-SHELL-MARKER");
    });

    it("rewrites client-side routes to the SPA shell", async () => {
      for (const url of ["/view", "/view/deep/route", "/requests", "/scan"]) {
        const response = await server.inject({ method: "GET", url });

        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.body).toContain("SPA-SHELL-MARKER");
      }
    });

    it("does not swallow unknown API routes", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/api/no-such-thing",
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json<{ error: string }>().error).toBe("not-found");
    });

    it("does not swallow an unknown SHL route", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/shl/unknown-id",
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("SPA-SHELL-MARKER");
    });

    it("lets the launch routes answer for themselves rather than serving the SPA shell", async () => {
      // `/launch` and `/auth/callback` are real routes from Phase 3 onwards. Both refuse the
      // requests below, and neither may be rewritten to the SPA shell on the way out.
      for (const url of ["/launch?iss=x", "/auth/callback"]) {
        const response = await server.inject({ method: "GET", url });

        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
        expect(response.body).not.toContain("SPA-SHELL-MARKER");
      }
    });

    it("answers a non-GET request for an unknown path as an API 404", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/shl/unknown-id",
        payload: { recipient: "Jane" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe("not-found");
    });

    it("runs without a built SPA, as it does in development behind Vite", async () => {
      const apiOnly = buildServer({
        config: testConfig(path.join(directory, "app.db")),
        db,
        staticRoot: path.join(directory, "absent"),
        logger: false,
      });

      const health = await apiOnly.inject({ method: "GET", url: "/health" });
      const spa = await apiOnly.inject({ method: "GET", url: "/view" });

      expect(health.statusCode).toBe(200);
      expect(spa.statusCode).toBe(404);
      await apiOnly.close();
    });
  });

  describe("sessions and errors", () => {
    it("parses cookies, which the session routes depend on", async () => {
      // Plugins register during `ready`, so the decorators appear only once it resolves.
      await server.ready();

      expect(server.hasRequestDecorator("cookies")).toBe(true);
      expect(server.hasReplyDecorator("setCookie")).toBe(true);
    });

    it("answers a thrown error with a code, never with what the error said", async () => {
      server.get("/boom", () => {
        throw new Error(
          "upstream refused: Bearer secret-token-value-must-not-leak",
        );
      });

      const response = await server.inject({ method: "GET", url: "/boom" });

      expect(response.statusCode).toBe(500);
      expect(response.json<{ error: string }>().error).toBe("internal-error");
      expect(response.body).not.toContain("secret-token-value-must-not-leak");
      expect(response.body).not.toContain("Bearer");
    });

    it("passes a client error's own status and code through", async () => {
      server.get("/bad", async (_request, reply) => {
        await reply.code(400).send({ error: "bad-request" });
      });

      const response = await server.inject({ method: "GET", url: "/bad" });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe("bad-request");
    });

    it("redacts every field that could carry grant material from the logs", () => {
      const joined = LOG_REDACTION_PATHS.join(" ");

      for (const field of [
        "authorization",
        "set-cookie",
        "cookie",
        "access_token",
        "client_secret",
        "client_assertion",
        "secret",
      ]) {
        expect(joined).toContain(field);
      }
    });
  });
});
