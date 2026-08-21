/**
 * Tests for `server/api/invitations.ts`: minting a link that carries the direct-return channel.
 *
 * Minting is the one operation in this app that writes to the launched server, and it writes
 * before it stores. That ordering is the subject of most of what follows, because it is what
 * makes the failure edge honest: a filler holding a link whose Task was never published would
 * be invited to complete something that does not exist, so a failed publish must leave nothing
 * hosted at all (`contracts/http-api.md`, the `502 task-publish-failed` case).
 *
 * The other three groups are the wire shape (`shlink:/` payload with no `U` flag, per
 * `contracts/shl-wire.md`), the row that has to be there for `POST /shl/:id` to answer later,
 * and the session boundary.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_ORIGIN,
  ISSUER,
  SMART_CONFIGURATION,
  TOKEN_ENDPOINT,
  closeHarness,
  createHarness,
  jsonResponse,
  urlOf,
} from "./support/testHarness";
import { decodeUtf8, fromBase64Url } from "../../src/link/binary";
import { decryptJwe, keyFromBase64Url } from "../../src/link/jwe";
import { PLATYPUS_SERVER_TASK_URL_EXTENSION } from "../../src/link/replyDescriptor";

import type { TestHarness } from "./support/testHarness";
import type { Bundle, Questionnaire, Task } from "fhir/r4";
import type { Mock } from "vitest";

/** The session's launch access token: the authority the Task must be published with. */
const ACCESS_TOKEN = "launch-access-token-must-not-leak";

/** Id of the session row every test mints under. */
const SESSION_ID = "mint-session-id";

/** Id the issuer gives the published Task. */
const PUBLISHED_TASK_ID = "task-published-1";

/** Where that Task then lives. */
const PUBLISHED_TASK_URL = `${ISSUER}/Task/${PUBLISHED_TASK_ID}`;

/** The questionnaire the stub issuer answers a read with. */
const QUESTIONNAIRE: Questionnaire = {
  resourceType: "Questionnaire",
  id: "q-715",
  url: "http://example.org/Questionnaire/715",
  version: "1.2.0",
  title: "Chronic Condition Management Plan",
  status: "active",
  item: [{ linkId: "1", text: "How are you feeling?", type: "string" }],
};

/** What the SPA sends. */
const MINT_BODY = {
  questionnaireId: "q-715",
  patientId: "pt-1",
  patientDisplay: "Jane Citizen",
};

/** The decoded `shlink:/` payload. */
interface ShlPayload {
  url: string;
  key: string;
  exp?: number;
  label?: string;
  flag?: string;
}

/** The body `POST /api/invitations` answers with. */
interface MintResponse {
  shlink: string;
  manifestUrl: string;
  expiresAt: number;
  taskUrl: string;
  requestIdentifier: string;
}

/** The `invitations` row as stored, for asserting on what minting wrote. */
interface InvitationRow {
  id: string;
  linkKey: string;
  payloadCiphertext: string;
  label: string;
  expiresAt: number | null;
  issuer: string;
  patientId: string | null;
  requestIdentifier: string;
  publishedTaskUrl: string;
}

/**
 * Decode the base64url JSON that follows `shlink:/`.
 * @param shlink the minted link
 * @returns the payload
 */
function decodeShlink(shlink: string): ShlPayload {
  expect(shlink.startsWith("shlink:/")).toBe(true);
  return JSON.parse(
    decodeUtf8(fromBase64Url(shlink.slice("shlink:/".length))),
  ) as ShlPayload;
}

describe("minting an invitation", () => {
  let harness: TestHarness;
  let fetchMock: Mock<typeof fetch>;
  /** What the stub issuer answers a Questionnaire read with. */
  let questionnaireRead: () => Response;
  /** What the stub issuer answers a Task write with. */
  let taskWrite: () => Response;

  beforeEach(() => {
    harness = createHarness();
    questionnaireRead = () => jsonResponse(QUESTIONNAIRE);
    taskWrite = () =>
      jsonResponse({ resourceType: "Task", id: PUBLISHED_TASK_ID }, 201);
    fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url === `${ISSUER}/.well-known/smart-configuration`) {
        return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
      }
      if (url === TOKEN_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({
            access_token: "refreshed-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      }
      if (url.startsWith(`${ISSUER}/Questionnaire`)) {
        return Promise.resolve(questionnaireRead());
      }
      if (url.startsWith(`${ISSUER}/Task`) && init?.method === "POST") {
        return Promise.resolve(taskWrite());
      }
      throw new Error(`unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeHarness(harness);
  });

  /**
   * Insert the active session minting runs under.
   * @param userDisplay the display name the launch disclosed, or null for none
   */
  function insertSession(userDisplay: string | null = "Dr Jane Smith"): void {
    const now = Math.floor(Date.now() / 1000);
    harness.db
      .prepare(
        `INSERT INTO sessions (id, status, issuer, accessToken, accessTokenExpiresAt,
                               refreshToken, patientId, userDisplay, createdAt)
         VALUES (?, 'active', ?, ?, ?, NULL, 'pt-1', ?, ?)`,
      )
      .run(SESSION_ID, ISSUER, ACCESS_TOKEN, now + 3600, userDisplay, now);
  }

  /**
   * Mint an invitation through the route.
   * @param body the request body, defaulting to {@link MINT_BODY}
   * @param cookie the session cookie to present, or undefined for none
   * @returns the injected response
   */
  async function mint(
    body: Record<string, unknown> = MINT_BODY,
    cookie: string | undefined = `shl_session=${SESSION_ID}`,
  ) {
    return harness.server.inject({
      method: "POST",
      url: "/api/invitations",
      payload: body,
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  }

  /**
   * Mint and read the response body.
   * @param body the request body, defaulting to {@link MINT_BODY}
   * @returns the parsed mint response
   */
  async function mintBody(
    body: Record<string, unknown> = MINT_BODY,
  ): Promise<MintResponse> {
    const response = await mint(body);
    return response.json<MintResponse>();
  }

  /**
   * Mint and decode the `shlink:/` payload it answered with.
   * @param body the request body, defaulting to {@link MINT_BODY}
   * @returns the decoded link payload
   */
  async function mintPayload(
    body: Record<string, unknown> = MINT_BODY,
  ): Promise<ShlPayload> {
    const minted = await mintBody(body);
    return decodeShlink(minted.shlink);
  }

  /**
   * The single row in the invitations table.
   * @returns the row, or undefined when nothing was stored
   */
  function storedRow(): InvitationRow | undefined {
    return harness.db.prepare("SELECT * FROM invitations").get() as
      InvitationRow | undefined;
  }

  /**
   * The Task the route published, as the issuer received it.
   * @returns the parsed request body of the `POST .../Task` call
   */
  function publishedTask(): Task {
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        urlOf(input).startsWith(`${ISSUER}/Task`) && init?.method === "POST",
    );
    if (call === undefined) {
      throw new Error("no Task was published");
    }
    return JSON.parse(
      typeof call[1]?.body === "string" ? call[1].body : "{}",
    ) as Task;
  }

  describe("publishing the Task", () => {
    // FR-010: the Task is written with the session's authority, not the browser's.
    it("publishes the Task to the issuer with the session's bearer token", async () => {
      insertSession();

      const response = await mint();

      expect(response.statusCode).toBe(201);
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          urlOf(input) === `${ISSUER}/Task` && init?.method === "POST",
      );
      expect(call).toBeDefined();
      expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(new Headers(call?.[1]?.headers).get("content-type")).toBe(
        "application/fhir+json",
      );
    });

    // The published copy is what the filler will complete, so it must be the request itself.
    it("publishes the request Task, carrying the business identifier and the canonical", async () => {
      insertSession();

      const response = await mint();
      const body = response.json<MintResponse>();
      const task = publishedTask();

      expect(task.status).toBe("requested");
      expect(task.intent).toBe("order");
      expect(task.identifier?.[0]?.value).toBe(storedRow()?.requestIdentifier);
      expect(task.input?.[0]?.valueCanonical).toBe(
        "http://example.org/Questionnaire/715|1.2.0",
      );
      expect(body.taskUrl).toBe(PUBLISHED_TASK_URL);
    });

    /*
     * The published copy must not point at itself: it is written before its own address exists,
     * and a self-referential claim would be one nothing had established.
     */
    it("publishes a Task with no invitation-server-task-url extension", async () => {
      insertSession();

      await mint();

      expect(publishedTask().extension).toBeUndefined();
    });

    // The Task must be addressable on the issuer, whatever the server's Location header says.
    it("derives the published Task URL from the issuer base and the created id", async () => {
      insertSession();
      taskWrite = () =>
        jsonResponse({ resourceType: "Task", id: "some-other-id" }, 201);

      const response = await mint();

      expect(response.json<MintResponse>().taskUrl).toBe(
        `${ISSUER}/Task/some-other-id`,
      );
    });
  });

  describe("when the Task cannot be published", () => {
    // Nothing hosted: a link whose Task does not exist invites work that cannot be delivered.
    it("answers 502 task-publish-failed and stores no invitation", async () => {
      insertSession();
      taskWrite = () => jsonResponse({ resourceType: "OperationOutcome" }, 403);

      const response = await mint();

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: "task-publish-failed" });
      expect(storedRow()).toBeUndefined();
    });

    it("says nothing about the token in the failure detail", async () => {
      insertSession();
      taskWrite = () => jsonResponse({ resourceType: "OperationOutcome" }, 403);

      const response = await mint();

      expect(response.body).not.toContain(ACCESS_TOKEN);
      expect(harness.logLines.join("\n")).not.toContain(ACCESS_TOKEN);
    });

    // A server that accepts the write but says nothing useful leaves no address to publish.
    it("answers 502 when the issuer returns no id for the created Task", async () => {
      insertSession();
      taskWrite = () => jsonResponse({ resourceType: "Task" }, 201);

      const response = await mint();

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: "task-publish-failed" });
      expect(storedRow()).toBeUndefined();
    });
  });

  describe("the minted link", () => {
    /*
     * Platypus fixture 24 carries no `flag`: not `U` (which would mean a single file fetched by
     * GET) and not `P`. This app hosts a manifest, so the absence is the statement.
     */
    it("carries no flag, so the link resolves as a manifest", async () => {
      insertSession();

      const payload = await mintPayload();

      expect(payload.flag).toBeUndefined();
      expect(Object.keys(payload).toSorted()).toEqual([
        "exp",
        "key",
        "label",
        "url",
      ]);
    });

    it("points at this app's manifest route for the stored invitation", async () => {
      insertSession();

      const body = await mintBody();
      const payload = decodeShlink(body.shlink);

      expect(payload.url).toBe(`${APP_ORIGIN}/shl/${storedRow()?.id}`);
      expect(body.manifestUrl).toBe(payload.url);
    });

    it("carries a fresh 256-bit key, base64url, matching the stored one", async () => {
      insertSession();

      const payload = await mintPayload();

      expect(payload.key).toHaveLength(43);
      expect(keyFromBase64Url(payload.key)).toHaveLength(32);
      expect(payload.key).toBe(storedRow()?.linkKey);
    });

    // Two mints must not share a key, or one link's holder could open the other's payload.
    it("mints a different key for every invitation", async () => {
      insertSession();

      const first = await mintPayload();
      const second = await mintPayload();

      expect(second.key).not.toBe(first.key);
      expect(second.url).not.toBe(first.url);
    });

    it("labels the link with the questionnaire's title and states the expiry", async () => {
      insertSession();

      const body = await mintBody();
      const payload = decodeShlink(body.shlink);
      const thirtyDays = Math.floor(Date.now() / 1000) + 30 * 86_400;

      expect(payload.label).toBe("Chronic Condition Management Plan");
      expect(payload.exp).toBe(body.expiresAt);
      expect(Math.abs(body.expiresAt - thirtyDays)).toBeLessThan(60);
    });

    it("honours an expiry the requester chose", async () => {
      insertSession();
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;

      const body = await mintBody({ ...MINT_BODY, expiresAt });

      expect(body.expiresAt).toBe(expiresAt);
      expect(storedRow()?.expiresAt).toBe(expiresAt);
    });
  });

  describe("the stored invitation", () => {
    it("stores everything a later manifest fetch needs", async () => {
      insertSession();

      const body = await mintBody();
      const row = storedRow();

      expect(row).toMatchObject({
        label: "Chronic Condition Management Plan",
        issuer: ISSUER,
        patientId: "pt-1",
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });
      expect(row?.requestIdentifier).toMatch(/^urn:uuid:/);
      expect(row?.expiresAt).toBe(body.expiresAt);
    });

    /*
     * The identifier is the join between this request and the answers that come back, so the
     * requester has to be told it: the SPA names it back to them and matches on it later.
     */
    it("reports the request identifier it published and stored", async () => {
      insertSession();

      const body = await mintBody();

      expect(body.requestIdentifier).toBe(storedRow()?.requestIdentifier);
      expect(body.requestIdentifier).toBe(
        publishedTask().identifier?.[0]?.value,
      );
    });

    // The payload is written once at mint; only the grant file is produced per fetch.
    it("stores the invitation Bundle encrypted under the link key", async () => {
      insertSession();

      const payload = await mintPayload();
      const row = storedRow();
      const plaintext = decodeUtf8(
        await decryptJwe(
          row?.payloadCiphertext ?? "",
          keyFromBase64Url(payload.key),
        ),
      );
      const bundle = JSON.parse(plaintext) as Bundle;
      const task = (bundle.entry ?? [])
        .map((entry) => entry.resource)
        .find(
          (resource): resource is Task => resource?.resourceType === "Task",
        );

      expect(bundle.type).toBe("collection");
      expect(task?.extension).toEqual([
        {
          url: PLATYPUS_SERVER_TASK_URL_EXTENSION,
          valueUrl: PUBLISHED_TASK_URL,
        },
      ]);
      expect(task?.identifier?.[0]?.value).toBe(row?.requestIdentifier);
    });

    // The ciphertext is a manifest file, so it declares what it holds.
    it("declares the payload's content type in the JWE header", async () => {
      insertSession();

      await mint();
      const header = JSON.parse(
        decodeUtf8(
          fromBase64Url(
            (storedRow()?.payloadCiphertext ?? "").split(".", 1)[0],
          ),
        ),
      ) as Record<string, string>;

      expect(header).toEqual({
        alg: "dir",
        enc: "A256GCM",
        cty: "application/fhir+json",
      });
    });

    it("records no patient when the request named none", async () => {
      insertSession();

      await mint({ questionnaireId: "q-715" });

      expect(storedRow()?.patientId).toBeNull();
      expect(publishedTask().for).toBeUndefined();
    });
  });

  describe("who the invitation says it is from", () => {
    it("names the signed-in user", async () => {
      insertSession("Dr Jane Smith");

      await mint();

      expect(publishedTask().requester).toEqual({ display: "Dr Jane Smith" });
    });

    // The launch disclosing no user is legal; the deployment's own name covers it.
    it("falls back to the configured sender name", async () => {
      insertSession(null);

      await mint({ ...MINT_BODY, senderName: "Parkview Medical Centre" });

      expect(publishedTask().requester).toEqual({
        display: "Parkview Medical Centre",
      });
    });

    // A caller must not be able to overwrite what the session says about who is signed in.
    it("prefers the session's user over a sender name the caller supplied", async () => {
      insertSession("Dr Jane Smith");

      await mint({ ...MINT_BODY, senderName: "Someone Else Entirely" });

      expect(publishedTask().requester).toEqual({ display: "Dr Jane Smith" });
    });
  });

  describe("the session boundary", () => {
    it("refuses a request with no session cookie", async () => {
      const response = await mint(MINT_BODY);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a cookie naming a session that has gone", async () => {
      const response = await mint(MINT_BODY, "shl_session=not-a-session");

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "no-session" });
      expect(storedRow()).toBeUndefined();
    });

    // An expired token with no refresh cannot be rescued: say so, and offer a re-launch.
    it("answers session-expired when the launch token cannot be refreshed", async () => {
      const now = Math.floor(Date.now() / 1000);
      harness.db
        .prepare(
          `INSERT INTO sessions (id, status, issuer, accessToken, accessTokenExpiresAt,
                                 refreshToken, patientId, userDisplay, createdAt)
           VALUES (?, 'active', ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(SESSION_ID, ISSUER, ACCESS_TOKEN, now - 60, now);

      const response = await mint();

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "session-expired" });
      expect(storedRow()).toBeUndefined();
    });

    it("refuses a body naming no questionnaire", async () => {
      insertSession();

      const response = await mint({ patientId: "pt-1" });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid-request" });
      expect(storedRow()).toBeUndefined();
    });

    // Nothing is published for a form that cannot be read; the write would name nothing.
    it("answers 502 and publishes nothing when the questionnaire cannot be read", async () => {
      insertSession();
      questionnaireRead = () =>
        jsonResponse({ resourceType: "OperationOutcome" }, 404);

      const response = await mint();

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: "questionnaire-unreadable",
      });
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(false);
      expect(storedRow()).toBeUndefined();
    });
  });

  describe("what never leaves the server", () => {
    it("puts no launch token in the response or the log", async () => {
      insertSession();

      const response = await mint();

      expect(response.body).not.toContain(ACCESS_TOKEN);
      expect(harness.logLines.join("\n")).not.toContain(ACCESS_TOKEN);
    });

    // The link key is the one secret this route is supposed to disclose - but only in the link.
    it("puts the link key in the link and nowhere in the log", async () => {
      insertSession();

      const payload = await mintPayload();

      expect(harness.logLines.join("\n")).not.toContain(payload.key);
    });
  });
});
