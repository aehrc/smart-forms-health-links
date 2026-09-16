/**
 * Tests for `server/shl/facade.ts`: the write target a grant points at.
 *
 * The facade is what makes a minted token bound to its invitation, so the properties below are
 * the ones that binding consists of. They divide into four groups.
 *
 *  1. **Authorisation.** The row is read before the token, so a retired invitation refuses a
 *     structurally valid token; and a `404` for unknown, expired and deleted alike keeps this
 *     route as little of an existence oracle as the manifest is.
 *  2. **Stamping.** The identifier that makes a second send a no-op, and the `subject` that says
 *     whose answers these are, come from the invitation row. A filler cannot write for another
 *     patient or choose its own idempotency key, because neither value comes from the request.
 *  3. **Two shapes, one write.** A transaction Bundle and a bare `QuestionnaireResponse` produce
 *     byte-identical upstream writes, which is how Platypus inherits this app's idempotency
 *     without implementing it.
 *  4. **At most once.** A replay answers from what was stored; a genuine race gets the only
 *     `409` the facade issues; and an upstream failure releases the claim so a retry can work.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_ORIGIN,
  COOKIE_SECRET,
  ISSUER,
  SMART_CONFIGURATION,
  closeHarness,
  createHarness,
  jsonResponse,
  urlOf,
} from "./support/testHarness";
import {
  deriveGrantTokenKey,
  mintGrantToken,
} from "../../server/shl/grantToken";
import { insertInvitation } from "../../server/shl/invitationStore";
import { cachedAccessToken } from "../../server/smart/backendServices";
import { decodeUtf8, encodeUtf8 } from "../../src/link/binary";
import {
  decryptJwe,
  encryptJwe,
  generateKey,
  keyToBase64Url,
} from "../../src/link/jwe";

import type { TestHarness } from "./support/testHarness";
import type { InjectOptions } from "fastify";
import type { Bundle, QuestionnaireResponse } from "fhir/r4";
import type { Mock } from "vitest";

/*
 * The harness registers a deliberately fake signing key, so a real `client_credentials` mint
 * cannot happen here. `cachedAccessToken` is mocked for the same reason the manifest tests mock
 * it: what is under test is what the facade does with the practice's credential, not how it
 * obtains one.
 */
vi.mock("../../server/smart/backendServices", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../server/smart/backendServices")>();
  return { ...actual, cachedAccessToken: vi.fn() };
});

/** The questionnaire the invitation asks for. */
const CANONICAL = "http://example.org/Questionnaire/ccm";

/** The invitation's durable correlation key, and its conditional-create key. */
const REQUEST_IDENTIFIER = "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** The identifier system a URI-shaped business identifier is stamped under. */
const URI_SYSTEM = "urn:ietf:rfc:3986";

/** The practice's own system credential, which must never reach a filler. */
const UPSTREAM_TOKEN = "upstream-system-token";

/** The Task the invitation published on the practice. */
const TASK_URL = `${ISSUER}/Task/task-1`;

/**
 * A capability token for an invitation, as the manifest mints one.
 * @param invitationId the invitation it authorises
 * @param expiresIn seconds until it stops being accepted
 * @returns the token
 */
function grantToken(invitationId: string, expiresIn = 3600): string {
  return mintGrantToken({
    key: deriveGrantTokenKey(COOKIE_SECRET),
    invitationId,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  });
}

/** Answers as a filler would offer them. */
const ANSWERS: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: CANONICAL,
  item: [{ linkId: "1", answer: [{ valueString: "yes" }] }],
};

/**
 * A transaction Bundle in the shape this app's own filler posts.
 * @param answers the answers to carry
 * @returns the Bundle
 */
function transaction(answers: QuestionnaireResponse = ANSWERS): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: answers,
        request: { method: "POST", url: "QuestionnaireResponse" },
      },
    ],
  };
}

/**
 * A filler's transaction that offers a Task version, which is what asks for the Task leg.
 *
 * The plain {@link transaction} carries no Task entry, so a case that used it to assert the leg
 * was *not* taken would pass whatever the code did. This one makes that assertion mean something.
 * @returns the transaction Bundle
 */
function transactionWithTaskEntry(): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        resource: ANSWERS,
        request: { method: "POST", url: "QuestionnaireResponse" },
      },
      {
        resource: {
          resourceType: "Task",
          id: "task-1",
          status: "completed",
          intent: "order",
        },
        request: { method: "PUT", url: "Task/task-1", ifMatch: 'W/"3"' },
      },
    ],
  };
}

/**
 * Fetch a manifest and decrypt the grant out of it, the way a filler does.
 * @param harness the running server and its database
 * @param id the invitation to fetch the manifest for
 * @param linkKey the key the manifest's files are sealed under
 * @returns the grant as a filler would read it
 */
async function openGrant(
  harness: TestHarness,
  id: string,
  linkKey: Uint8Array,
): Promise<{ access_token: string; aud: string }> {
  const response = await harness.server.inject({
    method: "POST",
    url: `/shl/${id}`,
    payload: { recipient: "Platypus Health" },
  });
  const files = response.json<{
    files: { contentType: string; embedded: string }[];
  }>().files;
  const grantFile = files.find(
    (file) => file.contentType === "application/smart-api-access",
  );
  expect(grantFile, "the manifest carried no grant file").toBeDefined();
  return JSON.parse(
    decodeUtf8(await decryptJwe(grantFile!.embedded, linkKey)),
  ) as { access_token: string; aud: string };
}

describe("the facade", () => {
  let harness: TestHarness;
  let fetchMock: Mock<typeof fetch>;
  let mint: Mock<typeof cachedAccessToken>;
  /** Upstream requests, in the order they were made. */
  let calls: { url: string; method: string; body: unknown }[];

  beforeEach(() => {
    harness = createHarness();
    calls = [];
    mint = vi.mocked(cachedAccessToken);
    mint.mockReset();
    mint.mockResolvedValue({
      access_token: UPSTREAM_TOKEN,
      token_type: "Bearer",
      expires_in: 300,
    });
    fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith("/.well-known/smart-configuration")) {
        return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
      }
      calls.push({
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url === TASK_URL) {
        return Promise.resolve(
          jsonResponse({
            resourceType: "Task",
            id: "task-1",
            status: "requested",
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [
            {
              resource: {
                resourceType: "QuestionnaireResponse",
                id: "qr-77",
                status: "completed",
              },
              response: {
                status: "201 Created",
                location: "QuestionnaireResponse/qr-77",
              },
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeHarness(harness);
  });

  /**
   * Store an invitation for the facade to write against.
   * @param overrides fields to differ from the default
   * @param overrides.patientId
   * @param overrides.expiresAt
   * @param overrides.questionnaireCanonical
   * @param overrides.publishedTaskUrl
   * @param overrides.standingId
   * @returns the stored id
   */
  function storeInvitation(
    overrides: {
      patientId?: string | null;
      expiresAt?: number | null;
      questionnaireCanonical?: string | null;
      publishedTaskUrl?: string;
      standingId?: string;
    } = {},
  ): string {
    return insertInvitation(harness.db, {
      linkKey: "a".repeat(43),
      payloadCiphertext: "ciphertext",
      label: "Chronic Condition Management Plan",
      expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 86_400,
      issuer: ISSUER,
      patientId:
        overrides.patientId === undefined ? "pt-1" : overrides.patientId,
      requestIdentifier: REQUEST_IDENTIFIER,
      publishedTaskUrl: overrides.publishedTaskUrl ?? TASK_URL,
      questionnaireCanonical:
        overrides.questionnaireCanonical === undefined
          ? CANONICAL
          : overrides.questionnaireCanonical,
      ...(overrides.standingId === undefined
        ? {}
        : { standingId: overrides.standingId }),
    }).id;
  }

  /**
   * Write to the facade the way a filler does.
   * @param options the invitation, the token, the path and the body
   * @param options.id
   * @param options.token
   * @param options.path
   * @param options.body
   * @param options.method
   * @returns the injected response
   */
  async function write(options: {
    id: string;
    token?: string;
    path?: string;
    body?: unknown;
    method?: "POST" | "GET" | "PUT";
  }) {
    const { id } = options;
    const injected: InjectOptions = {
      method: options.method ?? "POST",
      url: `/shl/${id}/fhir${options.path ?? ""}`,
      headers: {
        authorization: `Bearer ${options.token ?? grantToken(id)}`,
        "content-type": "application/fhir+json",
      },
    };
    if (options.body !== undefined && options.body !== null) {
      injected.payload = options.body;
    }
    return await harness.server.inject(injected);
  }

  /**
   * Answer discovery, then hand every upstream request to a stand-in.
   * @param upstream what to answer an upstream request with
   */
  function upstreamRepliesWith(
    upstream: (url: string, method: string) => Response | Promise<Response>,
  ): void {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith("/.well-known/smart-configuration")) {
        return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
      }
      calls.push({ url, method: init?.method ?? "GET", body: undefined });
      return Promise.resolve(upstream(url, init?.method ?? "GET"));
    });
  }

  /** The transaction the facade sent upstream. */
  function upstreamWrite(): Bundle {
    return calls.find((call) => call.method === "POST")?.body as Bundle;
  }

  /** The QuestionnaireResponse inside that transaction. */
  function upstreamAnswers(): QuestionnaireResponse {
    return upstreamWrite().entry?.[0]?.resource as QuestionnaireResponse;
  }

  describe("authorisation", () => {
    it("accepts a token minted for this invitation", async () => {
      const id = storeInvitation();

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(201);
    });

    it("refuses a token minted for another invitation", async () => {
      const id = storeInvitation();
      const other = storeInvitation();

      const response = await write({
        id,
        token: grantToken(other),
        body: transaction(),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "invalid-token" });
      expect(calls).toEqual([]);
    });

    it.for([
      ["no authorization header at all", ""],
      ["a token that is not one of ours", "Bearer not-a-token"],
      ["an empty bearer", "Bearer "],
    ] as const)("refuses %s", async ([, header]) => {
      const id = storeInvitation();

      const response = await harness.server.inject({
        method: "POST",
        url: `/shl/${id}/fhir`,
        headers: {
          "content-type": "application/fhir+json",
          ...(header === "" ? {} : { authorization: header }),
        },
        payload: transaction(),
      });

      expect(response.statusCode).toBe(401);
      expect(calls).toEqual([]);
    });

    /*
     * The reason the token can be stateless. Nothing is stored to revoke, so revocation is the
     * row: an invitation that has expired or been deleted refuses every token ever minted for it.
     */
    it("refuses a valid token once the invitation has expired", async () => {
      const id = storeInvitation();
      const token = grantToken(id);
      harness.db
        .prepare("UPDATE invitations SET expiresAt = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) - 1, id);

      const response = await write({ id, token, body: transaction() });

      expect(response.statusCode).toBe(404);
      expect(calls).toEqual([]);
    });

    it("refuses a valid token once the invitation is deleted", async () => {
      const id = storeInvitation();
      const token = grantToken(id);
      harness.db.prepare("DELETE FROM invitations WHERE id = ?").run(id);

      const response = await write({ id, token, body: transaction() });

      expect(response.statusCode).toBe(404);
    });

    // Identical to an unknown id, so the facade is no more an oracle than the manifest is.
    it("answers unknown, expired and deleted invitations identically", async () => {
      const expired = storeInvitation({
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });
      const deleted = storeInvitation();
      const deletedToken = grantToken(deleted);
      harness.db.prepare("DELETE FROM invitations WHERE id = ?").run(deleted);

      const answers = await Promise.all([
        write({ id: "never-existed", body: transaction() }),
        write({ id: expired, body: transaction() }),
        write({ id: deleted, token: deletedToken, body: transaction() }),
      ]);

      for (const answer of answers) {
        expect(answer.statusCode).toBe(answers[0].statusCode);
        expect(answer.body).toBe(answers[0].body);
      }
    });

    it("refuses a token whose window has closed", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        token: grantToken(id, -1),
        body: transaction(),
      });

      expect(response.statusCode).toBe(401);
      expect(calls).toEqual([]);
    });
  });

  describe("what the facade stamps", () => {
    /*
     * The identifier is the conditional-create key, so a filler that could choose it could write
     * twice. It comes from the row.
     */
    it("stamps the invitation's identifier over whatever the filler sent", async () => {
      const id = storeInvitation();

      await write({
        id,
        body: transaction({
          ...ANSWERS,
          identifier: {
            system: URI_SYSTEM,
            value: "urn:uuid:chosen-by-filler",
          },
        }),
      });

      expect(upstreamAnswers().identifier).toEqual({
        system: URI_SYSTEM,
        value: REQUEST_IDENTIFIER,
      });
      expect(upstreamWrite().entry?.[0]?.request?.ifNoneExist).toBe(
        `identifier=${URI_SYSTEM}|${REQUEST_IDENTIFIER}`,
      );
    });

    // The one that would otherwise let a link write into somebody else's chart.
    it("stamps the invitation's patient over whatever the filler sent", async () => {
      const id = storeInvitation();

      await write({
        id,
        body: transaction({
          ...ANSWERS,
          subject: { reference: "Patient/somebody-else" },
        }),
      });

      expect(upstreamAnswers().subject).toEqual({
        reference: "Patient/pt-1",
      });
    });

    it("carries no subject at all when the invitation named no patient", async () => {
      const id = storeInvitation({ patientId: null });

      await write({
        id,
        body: transaction({
          ...ANSWERS,
          subject: { reference: "Patient/somebody-else" },
        }),
      });

      expect("subject" in upstreamAnswers()).toBe(false);
    });

    /*
     * A display is not an authorisation, but a display attached to a reference the filler chose
     * would read as one - so it survives only when the request already agrees which patient.
     */
    it("keeps a display that agrees about the patient", async () => {
      const id = storeInvitation();

      await write({
        id,
        body: transaction({
          ...ANSWERS,
          subject: { reference: "Patient/pt-1", display: "Jane Citizen" },
        }),
      });

      expect(upstreamAnswers().subject).toEqual({
        reference: "Patient/pt-1",
        display: "Jane Citizen",
      });
    });

    it("drops a display attached to a different patient", async () => {
      const id = storeInvitation();

      await write({
        id,
        body: transaction({
          ...ANSWERS,
          subject: { reference: "Patient/somebody-else", display: "Not Jane" },
        }),
      });

      expect(upstreamAnswers().subject).toEqual({ reference: "Patient/pt-1" });
    });
  });

  describe("the questionnaire it will accept", () => {
    it("refuses answers to a different questionnaire", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        body: transaction({
          ...ANSWERS,
          questionnaire: "http://example.org/Questionnaire/something-else",
        }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "wrong-questionnaire" });
      expect(calls).toEqual([]);
    });

    // A pinned version answers the same form; refusing it would refuse a conformant filler.
    it("accepts a canonical that pins a version", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        body: transaction({ ...ANSWERS, questionnaire: `${CANONICAL}|1.2.0` }),
      });

      expect(response.statusCode).toBe(201);
    });

    it("refuses answers naming no questionnaire", async () => {
      const id = storeInvitation();
      const { questionnaire: _dropped, ...noCanonical } = ANSWERS;

      const response = await write({
        id,
        body: transaction(noCanonical),
      });

      expect(response.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });

    // A row written before the column existed falls back to accepting what it is given.
    it("accepts any questionnaire when the invitation recorded none", async () => {
      const id = storeInvitation({ questionnaireCanonical: null });

      const response = await write({
        id,
        body: transaction({
          ...ANSWERS,
          questionnaire: "http://example.org/Questionnaire/anything",
        }),
      });

      expect(response.statusCode).toBe(201);
    });

    it("refuses a body carrying no QuestionnaireResponse", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        body: { resourceType: "Bundle", type: "transaction", entry: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "no-questionnaire-response",
      });
    });
  });

  describe("two wire shapes, one upstream write", () => {
    /*
     * The property that lets Platypus inherit this app's idempotency without doing anything: what
     * the filler wrapped its answers in never reaches the practice.
     */
    it("sends the same bytes for a bare resource as for a transaction", async () => {
      const first = storeInvitation();
      await write({ id: first, body: transaction() });
      const fromTransaction = upstreamWrite();

      calls = [];
      const second = storeInvitation();
      await write({
        id: second,
        path: "/QuestionnaireResponse",
        body: ANSWERS,
      });
      const fromResource = upstreamWrite();

      expect(normalise(fromResource)).toEqual(normalise(fromTransaction));
    });

    it("answers a bare create with the created resource", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        path: "/QuestionnaireResponse",
        body: ANSWERS,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        resourceType: "QuestionnaireResponse",
        id: "qr-77",
      });
      expect(response.headers["content-location"]).toBe(
        "QuestionnaireResponse/qr-77",
      );
    });

    it("answers a transaction with a transaction-response", async () => {
      const id = storeInvitation();

      const response = await write({ id, body: transaction() });

      expect(response.json()).toMatchObject({
        resourceType: "Bundle",
        type: "transaction-response",
      });
    });
  });

  describe("where the forward is addressed", () => {
    /*
     * A transaction is addressed to the FHIR base itself. The filler used to post straight to
     * `aud`, and the facade rebuilding the URL put a trailing slash on it - which Aidbox reads as
     * a different endpoint, so every send came back `destination-refused` with nothing saying why.
     * The exact bytes of this URL are worth a test of their own.
     */
    it("posts the transaction to the practice's base, with no trailing slash", async () => {
      const id = storeInvitation();

      await write({ id, body: transaction() });

      expect(
        calls.filter((call) => call.method === "POST").map((call) => call.url),
      ).toEqual([ISSUER]);
    });

    it("addresses the Task under that base", async () => {
      const id = storeInvitation();

      await write({ id, path: "/Task/task-1", method: "GET" });

      expect(calls.map((call) => call.url)).toEqual([`${ISSUER}/Task/task-1`]);
    });

    // A practice registered with a trailing slash must not produce a doubled one either.
    it("tolerates an issuer registered with a trailing slash", async () => {
      const id = storeInvitation();
      harness.db
        .prepare("UPDATE invitations SET issuer = ? WHERE id = ?")
        .run(`${ISSUER}/`, id);

      await write({ id, body: transaction() });

      expect(
        calls.filter((call) => call.method === "POST").map((call) => call.url),
      ).toEqual([ISSUER]);
    });
  });

  describe("at most one response", () => {
    it("answers a replayed send from what was stored, without writing again", async () => {
      const id = storeInvitation();
      await write({ id, body: transaction() });
      const writesAfterFirst = calls.filter(
        (call) => call.method === "POST",
      ).length;

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(200);
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(
        writesAfterFirst,
      );
    });

    it("names the stored response on a replay", async () => {
      const id = storeInvitation();
      await write({ id, body: transaction() });

      const response = await write({ id, body: transaction() });

      expect(response.headers["content-location"]).toBe(
        "QuestionnaireResponse/qr-77",
      );
    });

    /*
     * The only `409` the facade issues, and it is not a duplicate: it is a send that is genuinely
     * in flight, which has no stored answer to report yet.
     */
    it("answers 409 while another send holds the claim", async () => {
      const id = storeInvitation();
      harness.db
        .prepare("UPDATE invitations SET respondedAt = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000), id);

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "send-in-flight" });
    });

    // One bad gateway must not burn an invitation permanently.
    it("releases the claim when the practice refuses the write", async () => {
      const id = storeInvitation();
      fetchMock.mockImplementation((input) => {
        const url = urlOf(input);
        if (url.endsWith("/.well-known/smart-configuration")) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        return Promise.resolve(
          jsonResponse({ resourceType: "OperationOutcome" }, 500),
        );
      });

      const refused = await write({ id, body: transaction() });

      expect(refused.statusCode).toBe(502);
      expect(
        harness.db
          .prepare<[string], { respondedAt: number | null }>(
            "SELECT respondedAt FROM invitations WHERE id = ?",
          )
          .get(id)?.respondedAt,
      ).toBeNull();
    });
  });

  describe("the Task leg", () => {
    it("reads the invitation's published Task", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        path: "/Task/task-1",
        method: "GET",
      });

      expect(response.statusCode).toBe(200);
      expect(calls.map((call) => call.url)).toContain(TASK_URL);
    });

    // The path names the Task, but the row addresses it. A different id is refused, not redirected.
    it("refuses a Task the invitation did not publish", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        path: "/Task/some-other-task",
        method: "GET",
      });

      expect(response.statusCode).toBe(404);
      expect(calls).toEqual([]);
    });

    it("refuses a PUT whose body is not that Task", async () => {
      const id = storeInvitation();

      const response = await write({
        id,
        path: "/Task/task-1",
        method: "PUT",
        body: { resourceType: "Task", id: "task-1-but-different" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "not-this-task" });
      expect(calls).toEqual([]);
    });

    // The filler's own transaction carries a Task entry, and the facade completes it upstream.
    it("completes the Task when the filler offered a version", async () => {
      const id = storeInvitation();

      await write({
        id,
        body: {
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              resource: ANSWERS,
              request: { method: "POST", url: "QuestionnaireResponse" },
            },
            {
              resource: {
                resourceType: "Task",
                id: "task-1",
                status: "completed",
              },
              request: { method: "PUT", url: "Task/task-1", ifMatch: 'W/"3"' },
            },
          ],
        },
      });

      const taskEntry = upstreamWrite().entry?.find(
        (entry) => entry.resource?.resourceType === "Task",
      );
      expect(taskEntry?.request).toEqual({
        method: "PUT",
        url: "Task/task-1",
        ifMatch: 'W/"3"',
      });
    });

    it("sends no Task entry when the filler offered no version", async () => {
      const id = storeInvitation();

      await write({ id, path: "/QuestionnaireResponse", body: ANSWERS });

      // The Provenance is there because the invitation names a patient; the Task is not.
      expect(
        upstreamWrite().entry?.map((entry) => entry.resource?.resourceType),
      ).toEqual(["QuestionnaireResponse", "Provenance"]);
    });
  });

  describe("when the practice will not cooperate", () => {
    it("answers 502 when the practice cannot be reached", async () => {
      const id = storeInvitation();
      upstreamRepliesWith(() => {
        throw new Error("ECONNREFUSED");
      });

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "destination-unreachable" });
    });

    it("answers 502 when discovery fails", async () => {
      const id = storeInvitation();
      fetchMock.mockResolvedValue(jsonResponse({ error: "not-here" }, 404));

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "destination-unavailable" });
    });

    // A refusal upstream is the filler's cue that the link will not work, not that it should retry.
    it("answers 403 when the practice refuses the credential", async () => {
      const id = storeInvitation();
      upstreamRepliesWith(() =>
        jsonResponse({ resourceType: "OperationOutcome" }, 403),
      );

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "destination-refused" });
    });

    /*
     * The practice is the authority on whether a cached token still works, and a 401 is it saying
     * no - so the cache is dropped and one fresh mint is tried before the answer is believed.
     */
    it("re-mints once when the practice rejects a cached token", async () => {
      const id = storeInvitation();
      let seen = 0;
      upstreamRepliesWith((_url, method) => {
        if (method !== "POST") {
          return jsonResponse({ resourceType: "Task", id: "task-1" });
        }
        seen += 1;
        return seen === 1
          ? jsonResponse({ resourceType: "OperationOutcome" }, 401)
          : jsonResponse({
              resourceType: "Bundle",
              type: "transaction-response",
              entry: [
                {
                  resource: {
                    resourceType: "QuestionnaireResponse",
                    id: "qr-9",
                  },
                  response: {
                    status: "201 Created",
                    location: "QuestionnaireResponse/qr-9",
                  },
                },
              ],
            });
      });

      const response = await write({ id, body: transaction() });

      expect(seen).toBe(2);
      expect(mint).toHaveBeenCalledTimes(2);
      expect(response.statusCode).toBe(201);
    });

    // A DPoP token cannot be presented in a Bearer header, and pretending otherwise fails opaquely.
    it("answers 502 for a practice issuing a non-Bearer token", async () => {
      const id = storeInvitation();
      mint.mockResolvedValue({
        access_token: UPSTREAM_TOKEN,
        token_type: "DPoP",
        expires_in: 300,
      });

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(502);
    });

    it("answers 502, and keeps the claim free, when the answer is unreadable", async () => {
      const id = storeInvitation();
      upstreamRepliesWith(() => new Response("not json", { status: 200 }));

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(502);
      expect(
        harness.db
          .prepare<[string], { respondedAt: number | null }>(
            "SELECT respondedAt FROM invitations WHERE id = ?",
          )
          .get(id)?.respondedAt,
      ).toBeNull();
    });

    /*
     * The practice took the transaction but named nothing it created, so there is no reference to
     * record. A retry is a better outcome than a link that is permanently spent.
     */
    it("releases the claim when the answer names nothing created", async () => {
      const id = storeInvitation();
      upstreamRepliesWith(() =>
        jsonResponse({
          resourceType: "Bundle",
          type: "transaction-response",
          entry: [],
        }),
      );

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(502);
      expect(
        harness.db
          .prepare<[string], { respondedAt: number | null }>(
            "SELECT respondedAt FROM invitations WHERE id = ?",
          )
          .get(id)?.respondedAt,
      ).toBeNull();
    });

    it("answers an unregistered issuer with 502 rather than a write", async () => {
      const id = storeInvitation();
      harness.db
        .prepare("UPDATE invitations SET issuer = ? WHERE id = ?")
        .run("https://not-registered.example.org/fhir", id);

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "destination-unavailable" });
      expect(calls).toEqual([]);
    });

    it("refuses a body that is not JSON at all", async () => {
      const id = storeInvitation();

      const response = await harness.server.inject({
        method: "POST",
        url: `/shl/${id}/fhir`,
        headers: {
          authorization: `Bearer ${grantToken(id)}`,
          "content-type": "application/fhir+json",
        },
        payload: "{ not json",
      });

      expect(response.statusCode).toBe(400);
    });

    // A replay whose stored response can no longer be read still says where it went.
    it("answers a replay without a body when the stored response is gone", async () => {
      const id = storeInvitation();
      await write({ id, body: transaction() });
      upstreamRepliesWith(() =>
        jsonResponse({ resourceType: "OperationOutcome" }, 404),
      );

      const response = await write({ id, body: transaction() });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-location"]).toBe(
        "QuestionnaireResponse/qr-77",
      );
    });
  });

  describe("the Task routes upstream", () => {
    it("relays the practice's ETag on a read", async () => {
      const id = storeInvitation();
      fetchMock.mockImplementation((input) => {
        const url = urlOf(input);
        if (url.endsWith("/.well-known/smart-configuration")) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        return Promise.resolve(
          Response.json(
            { resourceType: "Task", id: "task-1" },
            { status: 200, headers: { ETag: 'W/"7"' } },
          ),
        );
      });

      const response = await write({
        id,
        path: "/Task/task-1",
        method: "GET",
      });

      expect(response.headers.etag).toBe('W/"7"');
    });

    it("forwards a conditional PUT with the filler's If-Match", async () => {
      const id = storeInvitation();
      let seenIfMatch: string | undefined;
      fetchMock.mockImplementation((input, init) => {
        const url = urlOf(input);
        if (url.endsWith("/.well-known/smart-configuration")) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        seenIfMatch = new Headers(init?.headers).get("if-match") ?? undefined;
        return Promise.resolve(
          jsonResponse({ resourceType: "Task", id: "task-1" }),
        );
      });

      const response = await harness.server.inject({
        method: "PUT",
        url: `/shl/${id}/fhir/Task/task-1`,
        headers: {
          authorization: `Bearer ${grantToken(id)}`,
          "content-type": "application/fhir+json",
          "if-match": 'W/"7"',
        },
        payload: { resourceType: "Task", id: "task-1", status: "completed" },
      });

      expect(response.statusCode).toBe(200);
      expect(seenIfMatch).toBe('W/"7"');
    });

    it("answers 502 when the Task cannot be reached", async () => {
      const id = storeInvitation();
      fetchMock.mockImplementation((input) => {
        const url = urlOf(input);
        if (url.endsWith("/.well-known/smart-configuration")) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        throw new Error("ECONNREFUSED");
      });

      const response = await write({
        id,
        path: "/Task/task-1",
        method: "GET",
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "destination-unreachable" });
    });

    it("answers 404 when the invitation's stored Task URL names no id", async () => {
      const id = storeInvitation({
        publishedTaskUrl: `${ISSUER}/Task/..`,
      });

      const response = await write({
        id,
        path: "/Task/..",
        method: "GET",
      });

      expect(response.statusCode).toBe(404);
      expect(calls).toEqual([]);
    });
  });

  /*
   * The one property neither file can assert alone: a grant the manifest actually minted, used
   * against the facade it actually names. Every other test here mints its own token, which proves
   * the facade's rules and nothing about whether the two halves agree - and they are joined only
   * by a derived key and a URL convention, both of which are easy to get subtly wrong.
   */
  describe("end to end, with a grant the manifest minted", () => {
    it("accepts the grant's own token at the grant's own aud", async () => {
      const linkKey = generateKey();
      const id = insertInvitation(harness.db, {
        linkKey: keyToBase64Url(linkKey),
        payloadCiphertext: await encryptJwe(
          encodeUtf8(JSON.stringify({ resourceType: "Bundle" })),
          linkKey,
          { contentType: "application/fhir+json" },
        ),
        label: "Chronic Condition Management Plan",
        expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        issuer: ISSUER,
        patientId: "pt-1",
        requestIdentifier: REQUEST_IDENTIFIER,
        publishedTaskUrl: TASK_URL,
        questionnaireCanonical: CANONICAL,
      }).id;

      const grant = await openGrant(harness, id, linkKey);

      // The convention both halves have to agree on, asserted rather than assumed.
      expect(grant.aud).toBe(`${APP_ORIGIN}/shl/${id}/fhir`);

      const sent = await harness.server.inject({
        method: "POST",
        url: new URL(grant.aud).pathname,
        headers: {
          authorization: `Bearer ${grant.access_token}`,
          "content-type": "application/fhir+json",
        },
        payload: transaction(),
      });

      expect(sent.statusCode).toBe(201);
      expect(upstreamAnswers().identifier).toEqual({
        system: URI_SYSTEM,
        value: REQUEST_IDENTIFIER,
      });
    });
  });

  describe("the practice's credential", () => {
    // The whole of ask two: the system credential never reaches the filler.
    it("presents the practice's own token upstream, never the capability", async () => {
      const id = storeInvitation();
      const token = grantToken(id);

      await write({ id, token, body: transaction() });

      const headers = JSON.stringify(
        fetchMock.mock.calls.map(([, init]) => init?.headers),
      );
      expect(headers).not.toContain(token);
    });
  });

  describe("a walk-in", () => {
    /*
     * An invitation minted by a scan of a printed code. Nobody vouched for who is holding the
     * phone, which is the whole reason the two assertions below matter: the answers have to be
     * findable by a human, and the standing request has to survive them.
     */
    const STANDING_ID = "standing-abc";

    // The tag is the review queue. Without it a stranger's answers are one more untriaged
    // response on a busy server, indistinguishable from anything a clinician recorded.
    it("labels the stored answers as a walk-in", async () => {
      const id = storeInvitation({ patientId: null, standingId: STANDING_ID });

      await write({ id, body: transaction() });

      expect(
        (upstreamAnswers().meta?.tag ?? []).map((tag) => tag.code),
      ).toContain("shl-walk-in");
    });

    // Belonging to nobody is the correct state for answers nobody has triaged. A subject here
    // would be a claim about a person the practice has never met.
    it("stores them with no subject", async () => {
      const id = storeInvitation({ patientId: null, standingId: STANDING_ID });

      await write({ id, body: transaction() });

      expect(upstreamAnswers().subject).toBeUndefined();
    });

    /*
     * The one Task in play is the standing request behind the poster, which serves everybody else
     * who scans it, so completing it on the first walk-in's behalf would retire the code. The
     * filler here offers a Task version, which is exactly what makes an ordinary invitation
     * complete its Task - so this case would pass vacuously without it.
     */
    it("leaves the standing request alone, even when the filler offers a version", async () => {
      const id = storeInvitation({ patientId: null, standingId: STANDING_ID });

      await write({ id, body: transactionWithTaskEntry() });

      expect(
        upstreamWrite().entry?.some(
          (entry) => entry.resource?.resourceType === "Task",
        ),
      ).toBeFalsy();
      expect(calls.some((call) => call.url === TASK_URL)).toBe(false);
    });

    // The control: the same body against an ordinary invitation does complete its Task.
    it("still completes the Task of an ordinary invitation", async () => {
      const id = storeInvitation();

      await write({ id, body: transactionWithTaskEntry() });

      expect(
        upstreamWrite().entry?.some(
          (entry) => entry.resource?.resourceType === "Task",
        ),
      ).toBe(true);
    });

    // An ordinary invitation is untouched by any of this. The tag is stamped from the row, so a
    // filler cannot reach the queue by claiming to have scanned a poster.
    it("leaves an ordinary invitation untagged", async () => {
      const id = storeInvitation();

      await write({ id, body: transaction() });

      expect(
        (upstreamAnswers().meta?.tag ?? []).map((tag) => tag.code),
      ).not.toContain("shl-walk-in");
    });
  });
});

/**
 * A transaction with the values that legitimately differ per request removed.
 *
 * `fullUrl` is a fresh UUID each time, and a Provenance's `recorded` is the moment of the write.
 * Neither says anything about whether two shapes produced the same write.
 * @param bundle the transaction
 * @returns the comparable part of it
 */
function normalise(bundle: Bundle): unknown {
  return bundle.entry?.map((entry) => ({
    request: entry.request,
    resource:
      entry.resource?.resourceType === "Provenance"
        ? { ...entry.resource, recorded: "normalised", target: "normalised" }
        : entry.resource,
  }));
}
