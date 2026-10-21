/**
 * Tests for `server/shl/cors.ts`: cross-origin access to the public SHL routes.
 *
 * Two properties matter, and they pull in opposite directions. A browser app on another origin
 * has to be able to reach every public route - preflight, answer and refusal alike - or it cannot
 * open a link or send the answers back. And nothing authorised by the session cookie may answer
 * another origin at all, because that is the one place a permissive policy would leak authority.
 * @author Clinton Gillespie
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeHarness, createHarness } from "./support/testHarness";

import type { TestHarness } from "./support/testHarness";

/** The origin a browser patient app would send from. */
const FOREIGN_ORIGIN = "https://patient-app.example.com";

/** One route of each public kind, with the method a browser app would use on it. */
const PUBLIC_ROUTES = [
  { method: "POST", url: "/shl/inv-unknown" },
  { method: "POST", url: "/shl/inv-unknown/fhir" },
  { method: "POST", url: "/shl/inv-unknown/fhir/QuestionnaireResponse" },
  { method: "PUT", url: "/shl/inv-unknown/fhir/Task/task-1" },
  { method: "GET", url: "/shl/slot/slot-unknown" },
  { method: "PUT", url: "/shl/slot/slot-unknown" },
] as const;

describe("CORS on the public SHL routes", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await closeHarness(harness);
  });

  describe.each(PUBLIC_ROUTES)("$method $url", ({ method, url }) => {
    it("answers a preflight from any origin", async () => {
      const response = await harness.server.inject({
        method: "OPTIONS",
        url,
        headers: {
          origin: FOREIGN_ORIGIN,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-methods"]).toContain(
        method,
      );
      const allowedHeaders = String(
        response.headers["access-control-allow-headers"],
      ).toLowerCase();
      expect(allowedHeaders).toContain("authorization");
      expect(allowedHeaders).toContain("content-type");
      expect(response.headers["access-control-allow-credentials"]).toBe(
        undefined,
      );
    });

    it("lets a browser read the refusal, not just a network error", async () => {
      const response = await harness.server.inject({
        method,
        url,
        headers: {
          origin: FOREIGN_ORIGIN,
          "content-type": "application/fhir+json",
        },
        ...(method === "GET"
          ? {}
          : { payload: { resourceType: "QuestionnaireResponse" } }),
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-expose-headers"]).toContain(
        "ETag",
      );
    });
  });

  it("keeps the header on an error the error handler answers", async () => {
    const response = await harness.server.inject({
      method: "PUT",
      url: "/shl/slot/slot-unknown",
      headers: { origin: FOREIGN_ORIGIN, "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("keeps the header on a path under /shl that no route matches", async () => {
    const response = await harness.server.inject({
      method: "GET",
      url: "/shl/inv-unknown/nowhere/at/all",
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  /**
   * Send a preflight for a write to the facade.
   * @param requestHeaders the `Access-Control-Request-Headers` to send, if any
   * @returns the response
   */
  function preflight(requestHeaders?: string) {
    return harness.server.inject({
      method: "OPTIONS",
      url: "/shl/inv-unknown/fhir",
      headers: {
        origin: FOREIGN_ORIGIN,
        "access-control-request-method": "POST",
        ...(requestHeaders === undefined
          ? {}
          : { "access-control-request-headers": requestHeaders }),
      },
    });
  }

  // Other FHIR clients send headers ours does not, and one missing name blocks the whole request.
  it("allows whatever request headers a preflight asks for", async () => {
    const response = await preflight(
      "authorization,content-type,prefer,cache-control,x-request-id",
    );

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]).toBe(
      "authorization, content-type, prefer, cache-control, x-request-id",
    );
    expect(response.headers.vary).toContain("Access-Control-Request-Headers");
  });

  it("falls back to the headers our own filler sends when none are asked for", async () => {
    const response = await preflight();

    const allowed = String(
      response.headers["access-control-allow-headers"],
    ).toLowerCase();
    for (const name of [
      "authorization",
      "content-type",
      "if-match",
      "accept",
    ]) {
      expect(allowed).toContain(name);
    }
  });

  it("drops a requested name that is not a valid header token", async () => {
    const response = await preflight("prefer, not a header, x-ok");

    expect(response.headers["access-control-allow-headers"]).toBe(
      "prefer, x-ok",
    );
  });

  it("does not mistake a plain OPTIONS for a preflight", async () => {
    const response = await harness.server.inject({
      method: "OPTIONS",
      url: "/shl/inv-unknown",
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("CORS everywhere else", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await closeHarness(harness);
  });

  it.each([
    "/api/session",
    "/api/fhir/Patient",
    "/api/invitations",
    "/api/write-slots",
    "/launch",
    "/health",
    "/shlx",
  ])("refuses a preflight for %s", async (url) => {
    const response = await harness.server.inject({
      method: "OPTIONS",
      url,
      headers: {
        origin: FOREIGN_ORIGIN,
        "access-control-request-method": "POST",
      },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(undefined);
    expect(response.statusCode).not.toBe(204);
  });

  it("sends no CORS headers on a session route's answer", async () => {
    const response = await harness.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { origin: FOREIGN_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(undefined);
    expect(response.headers["access-control-expose-headers"]).toBe(undefined);
  });
});
