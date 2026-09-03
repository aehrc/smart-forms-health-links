/**
 * Tests for `src/lib/session.ts`: the browser's side of the BFF contract.
 *
 * Everything asserted here is a plain function. Per `~/.claude/reference/react.md` the hooks in
 * that module are thin compositions over these functions - `useSession` is `useQuery` plus
 * {@link sessionState}, and `useLogout` is `useMutation` plus {@link logout} - so the logic is
 * tested without a query client, a DOM or `act()`.
 *
 * Four properties matter, and they map onto the four groups below.
 *
 *  1. **The session query has exactly three ordinary states.** Loading, no session, active
 *     session. A fourth exists for the case where `/api/session` itself cannot be reached,
 *     because a blank screen is not an option (Nielsen heuristic 1) and pretending the user is
 *     signed out when the truth is unknown would be a lie.
 *  2. **The gate is a decision, not a rendering.** One pure function says whether a requester
 *     surface may render or must offer a launch, so every surface makes the same call.
 *  3. **A dead session is not an error.** `401 { "error": "session-expired" }` from a proxied
 *     FHIR call has to be distinguishable from an upstream `401`, a `404` or a network failure,
 *     because it is the only one that means "offer a re-launch" rather than "explain the
 *     failure" (spec US1 acceptance scenario 4).
 *  4. **The standalone start is a server navigation.** `/launch?iss=…` is a BFF route, so the
 *     URL is built rather than routed to, and the issuer is encoded.
 * @author John Grimes
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@/lib/session";

import {
  FHIR_PROXY_BASE,
  ISSUERS_ENDPOINT,
  LOGOUT_ENDPOINT,
  SESSION_ENDPOINT,
  classifyProxyResponse,
  fetchIssuers,
  fetchProxiedFhir,
  fetchSession,
  isSessionEnded,
  logout,
  requesterGate,
  sessionState,
  standaloneLaunchUrl,
} from "@/lib/session";

/** A representative active session, shaped exactly as `GET /api/session` answers. */
const ACTIVE: Session = {
  issuer: "https://ehr.example.org/fhir",
  issuerLabel: "Example Health",
  patientId: "pt-1",
  userDisplay: "Dr Jane Smith",
  fhirUser: "Practitioner/pr-1",
  grantedScopes: "openid fhirUser launch launch/patient user/*.cruds",
  requestedScopes: "openid fhirUser launch launch/patient user/*.cruds",
  expiresAt: 1_766_300_000,
};

/**
 * Install a `fetch` stub answering one request.
 * @param status the HTTP status to answer with
 * @param body the response body, serialised as JSON unless it is a string
 * @returns the mock, so callers can assert the URL and init it was called with
 */
function stubFetch(status: number, body?: unknown) {
  const payload =
    typeof body === "string" || body === undefined
      ? body
      : JSON.stringify(body);
  const mock = vi.fn<(...args: Parameters<typeof fetch>) => Response>(
    () =>
      new Response(payload ?? null, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the session query", () => {
  // The loading state is reported while the first fetch is outstanding, and must not be
  // conflated with "no session": the requester surfaces gate on this, and treating an unresolved
  // query as signed out would flash a launch prompt at every signed-in user on every load.
  it("reports loading while the first fetch is outstanding", () => {
    expect(
      sessionState({ isPending: true, data: undefined, error: null }),
    ).toEqual({ kind: "loading" });
  });

  // `fetchSession` resolves to null for a 401, which is an answer rather than a failure.
  it("reports no session when the server says there is none", () => {
    expect(sessionState({ isPending: false, data: null, error: null })).toEqual(
      {
        kind: "none",
      },
    );
  });

  it("reports the active session when there is one", () => {
    expect(
      sessionState({ isPending: false, data: ACTIVE, error: null }),
    ).toEqual({ kind: "active", session: ACTIVE });
  });

  // Distinct from "none". The user may well be signed in; we simply cannot tell, and saying so is
  // the only honest option.
  it("reports unavailable when the session endpoint itself failed", () => {
    const state = sessionState({
      isPending: false,
      data: undefined,
      error: new Error("network down"),
    });

    expect(state.kind).toBe("unavailable");
    expect(state.kind === "unavailable" && state.message).toContain(
      "network down",
    );
  });

  it("resolves the session from a 200 body", async () => {
    const mock = stubFetch(200, ACTIVE);

    await expect(fetchSession()).resolves.toEqual(ACTIVE);
    expect(mock.mock.calls[0]?.[0]).toBe(SESSION_ENDPOINT);
  });

  it("resolves to null when there is no session", async () => {
    stubFetch(401, { error: "no-session" });

    await expect(fetchSession()).resolves.toBeNull();
  });

  // A 500 is neither "signed in" nor "signed out". It has to reach the query's error channel so
  // the unavailable state is reported rather than a launch prompt.
  it("rejects when the session endpoint fails", async () => {
    stubFetch(500, { error: "internal-error" });

    await expect(fetchSession()).rejects.toThrow(/500/);
  });

  // A 200 carrying something other than a session is a broken deployment, not a session.
  it("rejects a malformed session body", async () => {
    stubFetch(200, { issuer: "https://ehr.example.org/fhir" });

    await expect(fetchSession()).rejects.toThrow(/session/i);
  });

  it("posts to the logout endpoint", async () => {
    const mock = stubFetch(204);

    await logout();

    expect(mock.mock.calls[0]?.[0]).toBe(LOGOUT_ENDPOINT);
    expect(mock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("rejects when logging out fails, so the UI can say the session may still stand", async () => {
    stubFetch(500, { error: "internal-error" });

    await expect(logout()).rejects.toThrow(/500/);
  });
});

describe("the issuer list", () => {
  it("reads the registry entries the picker needs", async () => {
    const entries = [
      { issuer: "https://ehr.example.org/fhir", label: "Example Health" },
    ];
    const mock = stubFetch(200, entries);

    await expect(fetchIssuers()).resolves.toEqual(entries);
    expect(mock.mock.calls[0]?.[0]).toBe(ISSUERS_ENDPOINT);
  });

  // An empty registry is a legitimate answer, and the picker renders it as an empty state rather
  // than as a failure.
  it("accepts an empty registry", async () => {
    stubFetch(200, []);

    await expect(fetchIssuers()).resolves.toEqual([]);
  });

  it("rejects a body that is not a registry", async () => {
    stubFetch(200, { issuers: [] });

    await expect(fetchIssuers()).rejects.toThrow(/issuer/i);
  });
});

describe("the requester gate", () => {
  it("waits while the session is loading", () => {
    expect(requesterGate({ kind: "loading" })).toEqual({ kind: "loading" });
  });

  it("lets a requester surface render when there is a session", () => {
    expect(requesterGate({ kind: "active", session: ACTIVE })).toEqual({
      kind: "ready",
      session: ACTIVE,
    });
  });

  it("asks for a launch when there is no session", () => {
    expect(requesterGate({ kind: "none" })).toMatchObject({
      kind: "launch-required",
      reason: "no-session",
    });
  });

  // Unknown is not the same as absent, so the prompt says something different - but it is still a
  // prompt, never a blank screen and never a raw error.
  it("asks for a launch when the session cannot be determined", () => {
    expect(
      requesterGate({ kind: "unavailable", message: "network down" }),
    ).toMatchObject({
      kind: "launch-required",
      reason: "session-unavailable",
    });
  });

  /*
   * The interesting case. The session query's cached answer still says active, because it was
   * true when it was fetched, but the surface's own proxied read has just been told the session
   * is gone. The gate must believe the fresher evidence and offer a re-launch (US1 scenario 4).
   */
  it("asks for a re-launch when a proxied read reports the session ended", async () => {
    const error = await expiredProxyError();

    expect(
      requesterGate({ kind: "active", session: ACTIVE }, error),
    ).toMatchObject({ kind: "launch-required", reason: "session-expired" });
  });

  // And the converse: an ordinary failure is the surface's business, not the gate's. Replacing a
  // FHIR error with a launch prompt would tell the user to sign in again for no reason.
  it("still renders the surface when its read failed for any other reason", () => {
    expect(
      requesterGate(
        { kind: "active", session: ACTIVE },
        new Error("FHIR request failed (404 Not Found)"),
      ),
    ).toEqual({ kind: "ready", session: ACTIVE });
  });
});

describe("classifying a proxied response", () => {
  it("passes a success through", () => {
    expect(classifyProxyResponse(200, { resourceType: "Bundle" })).toBe("ok");
    expect(classifyProxyResponse(201)).toBe("ok");
  });

  it("recognises an expired session", () => {
    expect(classifyProxyResponse(401, { error: "session-expired" })).toBe(
      "session-ended",
    );
  });

  it("recognises a missing session", () => {
    expect(classifyProxyResponse(401, { error: "no-session" })).toBe(
      "session-ended",
    );
  });

  /*
   * The proxy passes upstream responses through verbatim, so a 401 may be the *FHIR server*
   * refusing the request with an OperationOutcome. That is an ordinary failure: the session is
   * intact and a re-launch would not help.
   */
  it("treats an upstream 401 as an ordinary failure", () => {
    expect(
      classifyProxyResponse(401, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "security" }],
      }),
    ).toBe("failed");
  });

  it("treats every other status as an ordinary failure", () => {
    expect(classifyProxyResponse(404, { error: "not-found" })).toBe("failed");
    expect(classifyProxyResponse(500)).toBe("failed");
    // A 403 is a permissions answer from the launched server, not a dead session.
    expect(classifyProxyResponse(403, { error: "session-expired" })).toBe(
      "failed",
    );
  });
});

describe("reading through the proxy", () => {
  it("addresses the proxy base and asks for FHIR JSON", async () => {
    const mock = stubFetch(200, { resourceType: "Bundle", total: 0 });

    await expect(
      fetchProxiedFhir(`${FHIR_PROXY_BASE}/Questionnaire`),
    ).resolves.toEqual({
      resourceType: "Bundle",
      total: 0,
    });

    expect(mock.mock.calls[0]?.[0]).toBe("/api/fhir/Questionnaire");
    expect(mock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: "application/fhir+json" },
    });
  });

  it("marks a lost session on the error it throws", async () => {
    stubFetch(401, { error: "session-expired" });

    const error = await fetchProxiedFhir(`${FHIR_PROXY_BASE}/Patient`).catch(
      (error_: unknown) => error_,
    );

    expect(isSessionEnded(error)).toBe(true);
  });

  // The same marker for a request made with no cookie at all: from the surface's point of view
  // both mean "launch again".
  it("marks an absent session the same way", async () => {
    stubFetch(401, { error: "no-session" });

    const error = await fetchProxiedFhir(`${FHIR_PROXY_BASE}/Patient`).catch(
      (error_: unknown) => error_,
    );

    expect(isSessionEnded(error)).toBe(true);
  });

  it("does not mark an ordinary failure", async () => {
    stubFetch(404, { resourceType: "OperationOutcome" });

    const error = await fetchProxiedFhir(
      `${FHIR_PROXY_BASE}/Patient/nope`,
    ).catch((error_: unknown) => error_);

    expect(isSessionEnded(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("404");
  });

  it("does not mistake an arbitrary value for a lost session", () => {
    expect(isSessionEnded(new Error("nope"))).toBe(false);
    expect(isSessionEnded(null)).toBe(false);
    expect(isSessionEnded({ sessionEnded: true })).toBe(false);
  });
});

describe("starting a standalone launch", () => {
  it("builds the launch URL for an issuer", () => {
    expect(standaloneLaunchUrl("https://ehr.example.org/fhir")).toBe(
      "/launch?iss=https%3A%2F%2Fehr.example.org%2Ffhir",
    );
  });

  // The issuer arrives from the registry, but it is still going into a query string: anything
  // that would end the parameter early has to be encoded, not trusted.
  it("encodes an issuer carrying query syntax", () => {
    expect(standaloneLaunchUrl("https://ehr.example.org/fhir?a=1&b=2")).toBe(
      "/launch?iss=https%3A%2F%2Fehr.example.org%2Ffhir%3Fa%3D1%26b%3D2",
    );
  });
});

/**
 * The error a proxied read throws when the BFF reports the session is gone.
 *
 * Built by driving the real code path rather than by hand-rolling an object, so the test cannot
 * pass against a marker the implementation does not actually set.
 * @returns the thrown value
 */
async function expiredProxyError(): Promise<unknown> {
  stubFetch(401, { error: "session-expired" });
  return fetchProxiedFhir(`${FHIR_PROXY_BASE}/Patient`).catch(
    (error: unknown) => error,
  );
}
