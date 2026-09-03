/**
 * Tests for `server/smart/discovery.ts`.
 *
 * Discovery is the only thing standing between a registry entry and a redirect to somewhere
 * unexpected, so the endpoints it hands back are validated, not merely parsed. Results are
 * cached per issuer because every launch and every mint would otherwise re-fetch the same
 * document (data-model.md: "discovery results cached in memory with the issuer as key").
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSmartConfigurationCache,
  discoverSmartConfiguration,
} from "../../server/smart/discovery";

import type { Mock } from "vitest";

const ISSUER = "https://ehr.example.org/fhir";

const WELL_FORMED = {
  issuer: ISSUER,
  authorization_endpoint: "https://ehr.example.org/auth/authorize",
  token_endpoint: "https://ehr.example.org/auth/token",
  capabilities: ["launch-ehr", "client-confidential-symmetric"],
};

/**
 * Build a JSON `Response` the way a SMART server would.
 * @param body the document to serialise
 * @param status the HTTP status, defaulting to 200
 * @returns the response
 */
function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SMART discovery", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    clearSmartConfigurationCache();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the well-known document and returns both endpoints", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WELL_FORMED));

    const configuration = await discoverSmartConfiguration(ISSUER);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ehr.example.org/fhir/.well-known/smart-configuration",
    );
    expect(configuration.authorizationEndpoint).toBe(
      "https://ehr.example.org/auth/authorize",
    );
    expect(configuration.tokenEndpoint).toBe(
      "https://ehr.example.org/auth/token",
    );
    expect(configuration.issuer).toBe(ISSUER);
  });

  it("asks for JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WELL_FORMED));

    await discoverSmartConfiguration(ISSUER);

    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get("accept")).toContain(
      "application/json",
    );
  });

  it("caches the result, so a second launch does not re-fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WELL_FORMED));

    const first = await discoverSmartConfiguration(ISSUER);
    const second = await discoverSmartConfiguration(ISSUER);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("keys the cache by issuer", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        typeof input === "string" &&
          input.startsWith("https://other.example.org")
          ? jsonResponse({
              authorization_endpoint: "https://other.example.org/authorize",
              token_endpoint: "https://other.example.org/token",
            })
          : jsonResponse(WELL_FORMED),
      ),
    );

    const first = await discoverSmartConfiguration(ISSUER);
    const second = await discoverSmartConfiguration(
      "https://other.example.org/fhir",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.tokenEndpoint).toBe("https://ehr.example.org/auth/token");
    expect(second.tokenEndpoint).toBe("https://other.example.org/token");
  });

  it("treats a trailing slash on the issuer as the same issuer", async () => {
    fetchMock.mockResolvedValue(jsonResponse(WELL_FORMED));

    await discoverSmartConfiguration(`${ISSUER}/`);
    await discoverSmartConfiguration(ISSUER);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No doubled slash before the well-known path.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ehr.example.org/fhir/.well-known/smart-configuration",
    );
  });

  it("names the issuer and the status when the server refuses", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 404));

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /https:\/\/ehr\.example\.org\/fhir.*404/s,
    );
  });

  it("names the issuer when the server is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /https:\/\/ehr\.example\.org\/fhir/,
    );
    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("names the issuer when the document is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>not here</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /https:\/\/ehr\.example\.org\/fhir/,
    );
  });

  it("rejects a document with no token endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        authorization_endpoint: WELL_FORMED.authorization_endpoint,
      }),
    );

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /token_endpoint/,
    );
  });

  it("rejects a document with no authorization endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ token_endpoint: WELL_FORMED.token_endpoint }),
    );

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /authorization_endpoint/,
    );
  });

  it("rejects an endpoint that is not https", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        authorization_endpoint: "http://ehr.example.org/auth/authorize",
        token_endpoint: WELL_FORMED.token_endpoint,
      }),
    );

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /https:\/\/ehr\.example\.org\/fhir.*https/s,
    );
  });

  it("rejects an endpoint that is not a URL at all", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        authorization_endpoint: "/auth/authorize",
        token_endpoint: WELL_FORMED.token_endpoint,
      }),
    );

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow(
      /authorization_endpoint/,
    );
  });

  it("does not cache a failure, so a transient outage recovers", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    fetchMock.mockResolvedValue(jsonResponse(WELL_FORMED));

    await expect(discoverSmartConfiguration(ISSUER)).rejects.toThrow();
    const recovered = await discoverSmartConfiguration(ISSUER);

    expect(recovered.tokenEndpoint).toBe("https://ehr.example.org/auth/token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
