/**
 * Tests for the walk-in code: `server/api/standingInvitations.ts`, and the scan that mints from it.
 *
 * Issue #21 is the case where a practice prints one QR and unrelated strangers scan it. Everything
 * that makes that safe is a property of how the row is minted and what a fetch of it does, so this
 * file is organised around four claims and asserts each of them from the outside.
 *
 * **One Task, tagged twice.** A walk-in code publishes exactly one request Task, carrying the tag
 * that puts it in `/requests` and the tag that stops it being reported there as awaiting an answer
 * that will never come. A scan publishes nothing at all, which is what keeps an anonymous camera
 * from writing to the practice's server.
 *
 * **The sealed Task names no address.** The invitation payload normally carries the published
 * Task's own URL, which is how a return leg completes it. A standing request serves every walk-in
 * who ever scans the poster, so the first one to answer must not finish it - and the test for that
 * is that the extension is absent from the ciphertext, not that some later code declines to use it.
 *
 * **A scan mints its own invitation.** Two fetches of one code produce two rows with two different
 * identifiers and two different facade addresses, which is the whole of "two walk-ins cannot be
 * confused with each other": the at-most-one-response rule in `invitationStore` then holds for each
 * of them separately, unrelaxed.
 *
 * **Three ways to stop.** Expired, withdrawn and never-minted are one answer, and a code being
 * scanned faster than a practice could plausibly be filling forms in is refused outright.
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
import { cachedAccessToken } from "../../server/smart/backendServices";
import { decodeUtf8, fromBase64Url } from "../../src/link/binary";
import {
  SHL_REQUEST_TAG,
  SHL_STANDING_REQUEST_TAG,
} from "../../src/link/invitationBundle";
import { decryptJwe, keyFromBase64Url } from "../../src/link/jwe";
import { PLATYPUS_SERVER_TASK_URL_EXTENSION } from "../../src/link/replyDescriptor";

import type { TestHarness } from "./support/testHarness";
import type { Bundle, Questionnaire, Task } from "fhir/r4";
import type { Mock } from "vitest";

/*
 * The practice's own Backend Services credential is minted on the manifest path, and it is not
 * what these tests are about: a scan's grant is signed by this app, and what matters here is which
 * invitation it names. Stubbed so the assertions are about the walk-in and not about a JWT client
 * assertion, exactly as `manifest.test.ts` stubs it.
 */
vi.mock("../../server/smart/backendServices", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../server/smart/backendServices")>();
  return { ...actual, cachedAccessToken: vi.fn() };
});

/** The session's launch access token. */
const ACCESS_TOKEN = "launch-access-token-must-not-leak";

/** Id of the session row every code is created under. */
const SESSION_ID = "walk-in-session-id";

/** Id the issuer gives the published standing Task. */
const PUBLISHED_TASK_ID = "task-standing-1";

/** Where that Task then lives. */
const PUBLISHED_TASK_URL = `${ISSUER}/Task/${PUBLISHED_TASK_ID}`;

/** The questionnaire the stub issuer answers a read with. */
const QUESTIONNAIRE: Questionnaire = {
  resourceType: "Questionnaire",
  id: "q-new-patient",
  url: "http://example.org/Questionnaire/new-patient",
  version: "1.0.0",
  title: "New patient registration",
  status: "active",
  item: [{ linkId: "1", text: "What is your name?", type: "string" }],
};

/** What the SPA sends to create a code. */
const CREATE_BODY = { questionnaireId: "q-new-patient" };

/** One walk-in code, as the route answers with it. */
interface CodeView {
  id: string;
  shlink: string;
  manifestUrl: string;
  label: string;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  taskUrl: string;
  scans: number;
  answered: number;
}

/** The decoded `shlink:/` payload. */
interface ShlPayload {
  url: string;
  key: string;
  exp?: number;
  label?: string;
}

/** One file of a manifest. */
interface ManifestFile {
  contentType: string;
  embedded: string;
}

/** The grant file's plaintext, as far as these tests read it. */
interface Grant {
  aud: string;
  access_token: string;
  patient?: string;
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

/**
 * Read the grant out of a manifest response.
 * @param files the manifest's files
 * @param key the link key, base64url
 * @returns the decrypted grant
 */
async function grantFrom(files: ManifestFile[], key: string): Promise<Grant> {
  const file = files.find(
    (candidate) => candidate.contentType === "application/smart-api-access",
  );
  expect(file).toBeDefined();
  const plaintext = await decryptJwe(file!.embedded, keyFromBase64Url(key));
  return JSON.parse(decodeUtf8(plaintext)) as Grant;
}

/**
 * The first resource of one type in a Bundle.
 * @param bundle the Bundle
 * @param type the resource type
 * @returns the resource, or undefined
 */
function entryOf<T extends "Questionnaire" | "Task">(
  bundle: Bundle,
  type: T,
): (T extends "Questionnaire" ? Questionnaire : Task) | undefined {
  return bundle.entry?.find((entry) => entry.resource?.resourceType === type)
    ?.resource as
    (T extends "Questionnaire" ? Questionnaire : Task) | undefined;
}

describe("walk-in codes", () => {
  let harness: TestHarness;
  let fetchMock: Mock<typeof fetch>;
  /** Every Task body the stub issuer was asked to store. */
  let publishedTasks: Task[];
  /** What the stub issuer answers a Questionnaire read with. */
  let questionnaireRead: () => Response;

  beforeEach(() => {
    harness = createHarness();
    vi.mocked(cachedAccessToken).mockResolvedValue({
      access_token: "practice-system-token",
      token_type: "Bearer",
      expires_in: 300,
    });
    publishedTasks = [];
    questionnaireRead = () => jsonResponse(QUESTIONNAIRE);
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
        publishedTasks.push(JSON.parse(init.body as string) as Task);
        return Promise.resolve(
          jsonResponse({ resourceType: "Task", id: PUBLISHED_TASK_ID }, 201),
        );
      }
      throw new Error(`unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeHarness(harness);
  });

  /** Insert the active session a code is created under. */
  function insertSession(): void {
    const now = Math.floor(Date.now() / 1000);
    harness.db
      .prepare(
        `INSERT INTO sessions (id, status, issuer, accessToken, accessTokenExpiresAt,
                               refreshToken, patientId, userDisplay, createdAt)
         VALUES (?, 'active', ?, ?, ?, NULL, 'pt-1', 'Dr Jane Smith', ?)`,
      )
      .run(SESSION_ID, ISSUER, ACCESS_TOKEN, now + 3600, now);
  }

  /**
   * Create a walk-in code through the route.
   * @param body the request body
   * @param cookie the session cookie to present, or undefined for none
   * @returns the injected response
   */
  async function create(
    body: Record<string, unknown> = CREATE_BODY,
    cookie?: string,
  ) {
    return harness.server.inject({
      method: "POST",
      url: "/api/standing-invitations",
      payload: body,
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  }

  /**
   * Create a code and read what came back.
   * @returns the created code
   */
  async function createdCode(): Promise<CodeView> {
    insertSession();
    const response = await create(CREATE_BODY, `shl_session=${SESSION_ID}`);
    expect(response.statusCode).toBe(201);
    return response.json<CodeView>();
  }

  /**
   * Fetch a manifest, as a scanner does.
   * @param id the id in the printed link
   * @returns the injected response
   */
  async function scan(id: string) {
    return harness.server.inject({
      method: "POST",
      url: `/shl/${id}`,
      payload: { recipient: "a phone at the counter" },
    });
  }

  /**
   * Refresh a code through the route.
   * @param id the code
   * @param cookie the session cookie to present, or null for none
   * @returns the injected response
   */
  async function refresh(
    id: string,
    cookie: string | null = `shl_session=${SESSION_ID}`,
  ) {
    return harness.server.inject({
      method: "POST",
      url: `/api/standing-invitations/${id}/refresh`,
      ...(cookie === null ? {} : { headers: { cookie } }),
    });
  }

  /**
   * List the codes, as the staff page does.
   * @returns the codes
   */
  async function listed(): Promise<CodeView[]> {
    const response = await harness.server.inject({
      method: "GET",
      url: "/api/standing-invitations",
      headers: { cookie: `shl_session=${SESSION_ID}` },
    });
    return response.json<{ standingInvitations: CodeView[] }>()
      .standingInvitations;
  }

  /**
   * Scan a code and decrypt what it serves, with the key from the printed link.
   * @param code the code, as created
   * @returns the sealed ciphertext and the Bundle inside it
   */
  async function servedBundle(
    code: CodeView,
  ): Promise<{ embedded: string; bundle: Bundle }> {
    const response = await scan(code.id);
    expect(response.statusCode).toBe(200);
    const [file] = response.json<{ files: ManifestFile[] }>().files;
    const plaintext = await decryptJwe(
      file.embedded,
      keyFromBase64Url(decodeShlink(code.shlink).key),
    );
    return {
      embedded: file.embedded,
      bundle: JSON.parse(decodeUtf8(plaintext)) as Bundle,
    };
  }

  describe("creating one", () => {
    // Without a session nobody may publish a Task, and a walk-in code is a published Task before
    // it is anything else. The refusal has to come before the upstream is touched at all.
    it("needs a session", async () => {
      const response = await create(CREATE_BODY);

      expect(response.statusCode).toBe(401);
      expect(publishedTasks).toHaveLength(0);
    });

    // One Task, not one per scan. The two tags are the contract with `/requests`: the first puts
    // the row in the list, the second stops it being labelled as awaiting an answer.
    it("publishes exactly one Task, carrying both tags", async () => {
      const code = await createdCode();

      expect(publishedTasks).toHaveLength(1);
      const codings = (publishedTasks[0].meta?.tag ?? []).map(
        (tag) => tag.code,
      );
      expect(codings).toContain(SHL_REQUEST_TAG.code);
      expect(codings).toContain(SHL_STANDING_REQUEST_TAG.code);
      expect(code.taskUrl).toBe(PUBLISHED_TASK_URL);
    });

    // Nobody has walked in yet, so the published request is addressed to nobody. A `for` here
    // would be a claim about a person the practice has never met.
    it("publishes a Task with no subject", () => {
      return createdCode().then(() => {
        expect(publishedTasks[0].for).toBeUndefined();
      });
    });

    // The subtle one. The sealed Task must not carry the published Task's address, because the
    // return leg would then complete the standing request on the first walk-in's behalf.
    it("seals a Task that names no server address", async () => {
      const code = await createdCode();
      const payload = decodeShlink(code.shlink);
      const manifest = await scan(code.id);
      const { files } = manifest.json<{ files: ManifestFile[] }>();

      const bundle = JSON.parse(
        decodeUtf8(
          await decryptJwe(files[0].embedded, keyFromBase64Url(payload.key)),
        ),
      ) as Bundle;
      const task = bundle.entry
        ?.map((entry) => entry.resource)
        .find(
          (resource): resource is Task => resource?.resourceType === "Task",
        );

      expect(task).toBeDefined();
      expect(
        (task!.extension ?? []).some(
          (extension) => extension.url === PLATYPUS_SERVER_TASK_URL_EXTENSION,
        ),
      ).toBe(false);
    });

    // The whole reason a poster works: the code outlives by a long way the credential handed to
    // anyone who scans it, and it says so in its own payload.
    it("mints a link whose expiry is its own, not the token's", async () => {
      const code = await createdCode();

      expect(code.expiresAt).toBeGreaterThan(
        Math.floor(Date.now() / 1000) + 29 * 86_400,
      );
      expect(decodeShlink(code.shlink).exp).toBe(code.expiresAt);
      expect(code.manifestUrl).toBe(`${APP_ORIGIN}/shl/${code.id}`);
    });

    // A failed publish leaves nothing hosted, exactly as the per-request mint does: a code whose
    // request was never recorded would invite strangers to answer something that does not exist.
    it("stores nothing when the Task cannot be published", async () => {
      insertSession();
      fetchMock.mockImplementation((input, init) => {
        const url = urlOf(input);
        if (url === `${ISSUER}/.well-known/smart-configuration`) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        if (url.startsWith(`${ISSUER}/Questionnaire`)) {
          return Promise.resolve(questionnaireRead());
        }
        if (url.startsWith(`${ISSUER}/Task`) && init?.method === "POST") {
          return Promise.resolve(jsonResponse({}, 500));
        }
        throw new Error(`unexpected request to ${url}`);
      });

      const response = await create(CREATE_BODY, `shl_session=${SESSION_ID}`);

      expect(response.statusCode).toBe(502);
      expect(
        harness.db
          .prepare("SELECT count(*) AS n FROM standingInvitations")
          .get(),
      ).toEqual({ n: 0 });
    });
  });

  describe("scanning one", () => {
    // The heart of it. Each scan gets its own invitation row, its own identifier and its own
    // facade address, which is what keeps one walk-in's answers out of another's.
    it("mints a fresh invitation on every scan", async () => {
      const code = await createdCode();
      const payload = decodeShlink(code.shlink);

      const first = await scan(code.id);
      const second = await scan(code.id);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const rows = harness.db
        .prepare(
          "SELECT id, requestIdentifier, patientId, standingId FROM invitations",
        )
        .all() as {
        id: string;
        requestIdentifier: string;
        patientId: string | null;
        standingId: string | null;
      }[];

      expect(rows).toHaveLength(2);
      expect(rows[0].requestIdentifier).not.toBe(rows[1].requestIdentifier);
      expect(rows.every((row) => row.standingId === code.id)).toBe(true);
      // Nobody is named, because at the moment of the scan nobody is known.
      expect(rows.every((row) => row.patientId === null)).toBe(true);

      const grants = await Promise.all([
        grantFrom(first.json<{ files: ManifestFile[] }>().files, payload.key),
        grantFrom(second.json<{ files: ManifestFile[] }>().files, payload.key),
      ]);
      expect(grants[0].aud).not.toBe(grants[1].aud);
      expect(grants[0].aud).toBe(`${APP_ORIGIN}/shl/${rows[0].id}/fhir`);
      expect(grants[0].patient).toBeUndefined();
    });

    // The invitation file is the poster's own sealed payload, unchanged. Only the grant differs
    // between scans, which is what makes one ciphertext serve an unbounded number of people.
    it("serves the same sealed payload to every scanner", async () => {
      const code = await createdCode();

      const first = await scan(code.id);
      const second = await scan(code.id);

      expect(first.json<{ files: ManifestFile[] }>().files[0].embedded).toBe(
        second.json<{ files: ManifestFile[] }>().files[0].embedded,
      );
    });

    // A withdrawn code answers exactly as one that never existed. Anything else would tell a
    // passer-by which posters a practice has printed and then taken down.
    it("answers a withdrawn code as unknown", async () => {
      const code = await createdCode();

      const revoked = await harness.server.inject({
        method: "POST",
        url: `/api/standing-invitations/${code.id}/revoke`,
        headers: { cookie: `shl_session=${SESSION_ID}` },
      });
      expect(revoked.statusCode).toBe(200);

      const scanned = await scan(code.id);
      expect(scanned.statusCode).toBe(404);
      expect(scanned.json()).toEqual({ error: "not-found" });
    });

    // Likewise for a code whose date has passed, which is the state a poster left on a wall ends
    // up in.
    it("answers an expired code as unknown", async () => {
      const code = await createdCode();
      harness.db
        .prepare("UPDATE standingInvitations SET expiresAt = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) - 60, code.id);

      const scanned = await scan(code.id);
      expect(scanned.statusCode).toBe(404);
    });

    // The only control on a photographed poster. A 429 rather than a 404: you had to hold a
    // working code to get here, so the refusal discloses nothing new, and saying so plainly is
    // better than telling a practice its own code has vanished.
    it("refuses a code being scanned faster than anyone could be filling it in", async () => {
      const code = await createdCode();
      const now = Math.floor(Date.now() / 1000);
      const insert = harness.db.prepare(
        `INSERT INTO invitations (id, linkKey, payloadCiphertext, label, expiresAt, issuer,
                                  patientId, requestIdentifier, publishedTaskUrl,
                                  questionnaireCanonical, standingId, createdAt)
         VALUES (?, 'k', 'c', 'l', NULL, ?, NULL, ?, ?, NULL, ?, ?)`,
      );
      for (let index = 0; index < 60; index += 1) {
        insert.run(
          `scan-${String(index)}`,
          ISSUER,
          `urn:uuid:scan-${String(index)}`,
          PUBLISHED_TASK_URL,
          code.id,
          now,
        );
      }

      const scanned = await scan(code.id);

      expect(scanned.statusCode).toBe(429);
      expect(scanned.json()).toEqual({ error: "too-many-scans" });
    });
  });

  describe("listing and withdrawing", () => {
    // What a practice needs off this list is how much use a poster is getting, which is a count
    // of rows this app minted rather than anything readable on the published Task.
    it("reports how many people have scanned each code", async () => {
      const code = await createdCode();
      await scan(code.id);
      await scan(code.id);

      const listed = await harness.server.inject({
        method: "GET",
        url: "/api/standing-invitations",
        headers: { cookie: `shl_session=${SESSION_ID}` },
      });

      const codes = listed.json<{ standingInvitations: CodeView[] }>()
        .standingInvitations;
      expect(codes).toHaveLength(1);
      expect(codes[0].scans).toBe(2);
      expect(codes[0].answered).toBe(0);
      expect(codes[0].revokedAt).toBeNull();
    });

    // A withdrawn code stays on the list, and says so. Hiding it would leave a poster on a wall
    // with nothing on this screen to explain why it had stopped working.
    it("keeps a withdrawn code on the list, marked", async () => {
      const code = await createdCode();
      await harness.server.inject({
        method: "POST",
        url: `/api/standing-invitations/${code.id}/revoke`,
        headers: { cookie: `shl_session=${SESSION_ID}` },
      });

      const listed = await harness.server.inject({
        method: "GET",
        url: "/api/standing-invitations",
        headers: { cookie: `shl_session=${SESSION_ID}` },
      });

      const codes = listed.json<{ standingInvitations: CodeView[] }>()
        .standingInvitations;
      expect(codes[0].revokedAt).not.toBeNull();
    });

    // Withdrawing is scoped to the issuer, so a deployment serving two practices cannot let one
    // take down the other's poster. From here, somebody else's id simply does not exist.
    it("refuses to withdraw a code belonging to another issuer", async () => {
      const code = await createdCode();
      harness.db
        .prepare("UPDATE standingInvitations SET issuer = ? WHERE id = ?")
        .run("https://another-practice.example/fhir", code.id);

      const revoked = await harness.server.inject({
        method: "POST",
        url: `/api/standing-invitations/${code.id}/revoke`,
        headers: { cookie: `shl_session=${SESSION_ID}` },
      });

      expect(revoked.statusCode).toBe(404);
    });

    // Reading the list is a staff operation, like everything else here.
    it("needs a session to list", async () => {
      const listed = await harness.server.inject({
        method: "GET",
        url: "/api/standing-invitations",
      });

      expect(listed.statusCode).toBe(401);
    });
  });

  describe("refreshing one", () => {
    /** The same form, edited upstream: same canonical and version, one more question. */
    const EDITED: Questionnaire = {
      ...QUESTIONNAIRE,
      item: [
        ...QUESTIONNAIRE.item!,
        { linkId: "2", text: "What is your date of birth?", type: "date" },
      ],
    };

    // The whole point. The printed QR is the id and the key, so both must survive untouched while
    // what a scan of them serves changes - and it must be readable with the key on the wall.
    it("serves the edited form from the same printed link", async () => {
      const code = await createdCode();
      questionnaireRead = () => jsonResponse(EDITED);

      const response = await refresh(code.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ refreshed: true });
      const [after] = await listed();
      expect(after.id).toBe(code.id);
      expect(after.shlink).toBe(code.shlink);
      expect(after.manifestUrl).toBe(code.manifestUrl);
      const served = await servedBundle(code);
      expect(entryOf(served.bundle, "Questionnaire")?.item).toEqual(
        EDITED.item,
      );
    });

    // Only the Questionnaire entry is re-sealed. The Task, and so the standing request it names,
    // is the one that was published, and no second Task is published.
    it("keeps the sealed Task and publishes nothing", async () => {
      const code = await createdCode();
      const before = await servedBundle(code);
      questionnaireRead = () => jsonResponse(EDITED);

      await refresh(code.id);

      const after = await servedBundle(code);
      expect(entryOf(after.bundle, "Task")).toEqual(
        entryOf(before.bundle, "Task"),
      );
      expect(publishedTasks).toHaveLength(1);
    });

    it("reports a form that has not changed, and writes nothing", async () => {
      const code = await createdCode();
      const before = await servedBundle(code);

      const response = await refresh(code.id);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ refreshed: false });
      const after = await servedBundle(code);
      expect(after.embedded).toBe(before.embedded);
    });

    // The sealed Task names the form as url|version. A new version is a new code.
    it("refuses a new version of the form, and writes nothing", async () => {
      const code = await createdCode();
      const before = await servedBundle(code);
      questionnaireRead = () => jsonResponse({ ...EDITED, version: "2.0.0" });

      const response = await refresh(code.id);

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toBe(
        "questionnaire-identity-changed",
      );
      const after = await servedBundle(code);
      expect(after.embedded).toBe(before.embedded);
    });

    it("refuses a form read under the same id but a different canonical", async () => {
      const code = await createdCode();
      questionnaireRead = () =>
        jsonResponse({
          ...EDITED,
          url: "http://example.org/Questionnaire/other",
        });

      const response = await refresh(code.id);

      expect(response.statusCode).toBe(409);
    });

    it("leaves a withdrawn code withdrawn", async () => {
      const code = await createdCode();
      await harness.server.inject({
        method: "POST",
        url: `/api/standing-invitations/${code.id}/revoke`,
        headers: { cookie: `shl_session=${SESSION_ID}` },
      });
      questionnaireRead = () => jsonResponse(EDITED);

      const response = await refresh(code.id);

      expect(response.statusCode).toBe(404);
      const scanned = await scan(code.id);
      expect(scanned.statusCode).toBe(404);
    });

    it("refuses to refresh a code belonging to another issuer", async () => {
      const code = await createdCode();
      harness.db
        .prepare("UPDATE standingInvitations SET issuer = ? WHERE id = ?")
        .run("https://another-practice.example/fhir", code.id);
      questionnaireRead = () => jsonResponse(EDITED);

      const response = await refresh(code.id);

      expect(response.statusCode).toBe(404);
    });

    it("needs a session", async () => {
      const code = await createdCode();

      const response = await refresh(code.id, null);

      expect(response.statusCode).toBe(401);
    });
  });
});
