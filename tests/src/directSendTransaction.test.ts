/**
 * The submission transaction: what a filler posts to the grant's destination.
 *
 * This is the interoperability boundary of the whole feature, specified entry by entry in
 * `contracts/shl-wire.md` under "Submission transaction". Its "Rules" list is what the tests
 * below are: one test per rule, because each rule exists to prevent a specific, plausible and
 * damaging mistake.
 *
 *  - **The conditional create.** Without an exact `ifNoneExist`, a patient who presses send
 *    twice - or reopens the link on a second device - lands two responses in the record and the
 *    clinic has no way to tell which is the answer (SC-002).
 *  - **The security label.** Without `PATAST`, answers typed by a patient on their own phone are
 *    indistinguishable from answers a clinician recorded.
 *  - **No filler-local identifiers.** A `QuestionnaireResponse.id` from the filler's own store,
 *    or a `subject` naming a patient on the filler's own server, is meaningless on the
 *    destination and actively misleading there.
 *  - **`subject` iff the grant named a patient.** The grant is the only authority on who the
 *    answers are about; the invitation's `Task.for.reference` points at the *requester's* server
 *    and must never be echoed as if the filler had resolved it (FR-023).
 *  - **The Task leg is conditional and optimistic.** It appears only when the published Task is
 *    on the grant's own origin and was readable immediately before the send. Anything else -
 *    unreadable, moved, already finished - drops the Task entry and sends the answers anyway
 *    (FR-022). Losing the status flip is a nuisance; losing the answers is not.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubmissionTransactionOptions } from "@/fill/directSend";
import type { ApiAccessGrant } from "@/link/apiAccess";
import type { Bundle, QuestionnaireResponse, Task } from "fhir/r4";
import type { Mock } from "vitest";

import {
  buildSubmissionTransaction,
  readDestinationTask,
} from "@/fill/directSend";

/** The stubbed destination. Hoisted so the helpers below need no closure over a describe. */
let fetchMock: Mock<typeof fetch>;

/**
 * A FHIR JSON response, as the destination would answer a Task read.
 * @param body the resource
 * @param init status and headers
 * @returns the response
 */
function fhirResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/fhir+json", ...init.headers },
  });
}

/**
 * Read the well-formed Task from the destination.
 * @param serverTaskUrl the published Task URL the invitation named
 * @returns what the pre-send read made of it
 */
async function readTask(
  serverTaskUrl = "https://ehr.example.org/fhir/Task/task-1",
) {
  return readDestinationTask({ grant: GRANT, serverTaskUrl });
}

/** The destination, and the origin the token may be presented to. */
const AUD = "https://ehr.example.org/fhir";

/** The canonical of the form that was answered, as the invitation named it. */
const CANONICAL = "http://example.org/Questionnaire/sepsis|1.2.0";

/** The invitation's durable correlation key. */
const REQUEST_IDENTIFIER = "urn:uuid:8f1c9d2e-0000-4000-8000-abcdefabcdef";

const GRANT: ApiAccessGrant = {
  access_token: "opaque-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  aud: AUD,
  patient: "pt-demo",
};

/**
 * The answers as the renderer hands them over: full of identity that belongs to this device.
 *
 * Every member here that is not clinical content is one the transaction has to remove. It is
 * written as a single fixture rather than per-test so that a rule added later cannot quietly
 * stop being tested against a realistic starting point.
 */
const ANSWERS: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  id: "filler-local-draft",
  meta: {
    versionId: "7",
    lastUpdated: "2026-08-01T00:00:00.000Z",
    source: "urn:filler-local-store",
  },
  status: "in-progress",
  questionnaire: CANONICAL,
  subject: { reference: "Patient/filler-local-patient" },
  author: { reference: "Practitioner/filler-local-user" },
  source: { reference: "Patient/filler-local-patient" },
  authored: "2026-08-22T01:02:03.000Z",
  item: [
    { linkId: "temperature", answer: [{ valueDecimal: 38.4 }] },
    { linkId: "confused", answer: [{ valueBoolean: false }] },
  ],
};

/** The Task as the destination holds it, before the send completes it. */
const DESTINATION_TASK: Task = {
  resourceType: "Task",
  id: "task-1",
  meta: { versionId: "3" },
  status: "requested",
  intent: "order",
  identifier: [{ system: "urn:ietf:rfc:3986", value: REQUEST_IDENTIFIER }],
  requester: { display: "Dr Alex Fielding" },
  for: { reference: "Patient/pt-demo", display: "Jane Citizen" },
};

/**
 * Build the transaction, with a readable Task unless told otherwise.
 * @param overrides options to differ from the well-formed case
 * @returns the transaction Bundle
 */
function transaction(
  overrides: Partial<SubmissionTransactionOptions> = {},
): Bundle {
  return buildSubmissionTransaction({
    response: ANSWERS,
    patient: GRANT.patient,
    requestIdentifier: REQUEST_IDENTIFIER,
    patientDisplay: "Jane Citizen",
    recorded: "2026-08-22T01:05:00.000Z",
    ...overrides,
  });
}

describe("the submission transaction", () => {
  describe("shape", () => {
    // A transaction, not a batch: the answers, their attribution and the task flip are one act.
    it("is a transaction Bundle", () => {
      const bundle = transaction();

      expect(bundle.resourceType).toBe("Bundle");
      expect(bundle.type).toBe("transaction");
    });

    // The response first, because everything else references its `fullUrl`.
    it("carries the response, then its provenance, then the task", () => {
      const bundle = transaction({
        task: {
          url: "Task/task-1",
          resource: DESTINATION_TASK,
          ifMatch: 'W/"3"',
        },
      });

      expect(
        bundle.entry?.map((entry) => entry.resource?.resourceType),
      ).toEqual(["QuestionnaireResponse", "Provenance", "Task"]);
    });

    // Nothing here can identify the form, so there is nothing worth sending.
    it("refuses to build when the answers name no questionnaire", () => {
      expect(() =>
        transaction({ response: { ...ANSWERS, questionnaire: undefined } }),
      ).toThrow(/questionnaire/i);
    });
  });

  describe("the response entry", () => {
    // Rule: a completed response, against the canonical the invitation named.
    it("is completed, and keeps the questionnaire canonical", () => {
      const response = transaction().entry?.[0]
        ?.resource as QuestionnaireResponse;

      expect(response.status).toBe("completed");
      expect(response.questionnaire).toBe(CANONICAL);
      expect(response.item).toEqual(ANSWERS.item);
    });

    // Rule: the identifier is the invitation's request identifier, under the RFC 3986 system.
    it("carries the request identifier under urn:ietf:rfc:3986", () => {
      const response = transaction().entry?.[0]
        ?.resource as QuestionnaireResponse;

      expect(response.identifier).toEqual({
        system: "urn:ietf:rfc:3986",
        value: REQUEST_IDENTIFIER,
      });
    });

    // Rule: the PATAST label, or the record cannot tell patient-typed answers from clinician-recorded ones.
    it("is labelled patient-asserted", () => {
      const response = transaction().entry?.[0]
        ?.resource as QuestionnaireResponse;

      expect(response.meta?.security).toEqual([
        {
          system: "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
          code: "PATAST",
          display: "patient asserted",
        },
      ]);
    });

    /*
     * Rule: `ifNoneExist` casing is exact. Aidbox matches the transaction entry's field name
     * literally, so `ifNoneexist` or `if-none-exist` is not a conditional create at all - it is
     * an unconditional one, and the second send duplicates the answers in the record.
     */
    it("is a conditional create with the exact ifNoneExist field and query", () => {
      const entry = transaction().entry?.[0];

      expect(entry?.request?.method).toBe("POST");
      expect(entry?.request?.url).toBe("QuestionnaireResponse");
      expect(Object.keys(entry?.request ?? {})).toContain("ifNoneExist");
      expect(entry?.request?.ifNoneExist).toBe(
        `identifier=urn:ietf:rfc:3986|${REQUEST_IDENTIFIER}`,
      );
    });

    // Rule: `subject` present iff the grant named a patient.
    it("attributes the answers to the patient the grant named", () => {
      const response = transaction().entry?.[0]
        ?.resource as QuestionnaireResponse;

      expect(response.subject).toEqual({
        reference: "Patient/pt-demo",
        display: "Jane Citizen",
      });
    });

    // Rule: otherwise omitted entirely - never a filler-local reference.
    it("carries no patient reference at all when no patient was named", () => {
      const response = transaction({ patient: undefined }).entry?.[0]
        ?.resource as QuestionnaireResponse;

      expect("subject" in response).toBe(false);
    });

    /*
     * Rule: no filler-local identifiers. The renderer's response carries the identity of this
     * device's draft - a local `id`, a version, a `source`, an `author` naming whoever is signed
     * in here. On the destination, every one of those is either meaningless or a lie.
     */
    it("strips every identifier and reference belonging to the filler", () => {
      const bundle = transaction();
      const response = bundle.entry?.[0]?.resource as QuestionnaireResponse;

      expect("id" in response).toBe(false);
      expect(response.meta?.versionId).toBeUndefined();
      expect(response.meta?.lastUpdated).toBeUndefined();
      expect(response.meta?.source).toBeUndefined();
      expect("author" in response).toBe(false);
      expect("source" in response).toBe(false);
      expect(JSON.stringify(bundle)).not.toContain("filler-local");
    });

    // What the patient actually typed, and when, is content and stays.
    it("keeps the authored instant", () => {
      const response = transaction().entry?.[0]
        ?.resource as QuestionnaireResponse;

      expect(response.authored).toBe("2026-08-22T01:02:03.000Z");
    });
  });

  describe("the provenance entry", () => {
    // Rule: targets the response's fullUrl - the response has no server id yet.
    it("targets the response by its fullUrl", () => {
      const bundle = transaction();
      const responseFullUrl = bundle.entry?.[0]?.fullUrl;
      const provenance = bundle.entry?.[1];

      expect(responseFullUrl).toMatch(/^urn:uuid:/);
      expect(provenance?.resource).toMatchObject({
        resourceType: "Provenance",
        target: [{ reference: responseFullUrl }],
        recorded: "2026-08-22T01:05:00.000Z",
      });
      expect(provenance?.request).toEqual({
        method: "POST",
        url: "Provenance",
      });
    });

    // Rule: the patient is the author agent.
    it("names the patient as the author agent", () => {
      const provenance = transaction().entry?.[1]?.resource as {
        agent?: unknown[];
      };

      expect(provenance.agent).toEqual([
        {
          type: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
                code: "author",
              },
            ],
          },
          who: { reference: "Patient/pt-demo", display: "Jane Citizen" },
        },
      ]);
    });

    /*
     * `Provenance.agent.who` is 1..1. With no patient named there is nobody to be the author, so
     * there is no valid Provenance to write - and inventing a filler-local `who` is precisely
     * what the rule forbids. The PATAST label still records that the content is patient-asserted.
     */
    it("is omitted entirely when no patient was named", () => {
      const bundle = transaction({ patient: undefined });

      expect(
        bundle.entry?.map((entry) => entry.resource?.resourceType),
      ).toEqual(["QuestionnaireResponse"]);
    });
  });

  describe("the task entry", () => {
    // Rule: a PUT guarded by the version read immediately before.
    it("completes the task by PUT, guarded by the version read immediately before", () => {
      const bundle = transaction({
        task: {
          url: "Task/task-1",
          resource: DESTINATION_TASK,
          ifMatch: 'W/"3"',
        },
      });
      const entry = bundle.entry?.[2];

      expect(entry?.request).toEqual({
        method: "PUT",
        url: "Task/task-1",
        ifMatch: 'W/"3"',
      });
      expect((entry?.resource as Task).status).toBe("completed");
    });

    // Rule: the response is the task's output, referenced by the fullUrl it was created under.
    it("names the response as the task's output", () => {
      const bundle = transaction({
        task: {
          url: "Task/task-1",
          resource: DESTINATION_TASK,
          ifMatch: 'W/"3"',
        },
      });
      const responseFullUrl = bundle.entry?.[0]?.fullUrl;

      expect((bundle.entry?.[2]?.resource as Task).output).toEqual([
        {
          type: { text: "questionnaire-response" },
          valueReference: { reference: responseFullUrl },
        },
      ]);
    });

    /*
     * A `PUT` replaces. Sending only `status` and `output` would silently erase the requester's
     * own identifier, `for` and `requester` from their own Task - which is why the Task is read
     * immediately before and sent back changed only in the two members the completion is about.
     */
    it("preserves what the destination already held on the task", () => {
      const bundle = transaction({
        task: {
          url: "Task/task-1",
          resource: DESTINATION_TASK,
          ifMatch: 'W/"3"',
        },
      });

      expect(bundle.entry?.[2]?.resource).toMatchObject({
        id: "task-1",
        intent: "order",
        identifier: [
          { system: "urn:ietf:rfc:3986", value: REQUEST_IDENTIFIER },
        ],
        requester: { display: "Dr Alex Fielding" },
        for: { reference: "Patient/pt-demo", display: "Jane Citizen" },
      });
    });

    // Rule: no readable task, no task entry - and the answers still go.
    it("is absent when there was no task to complete, and the answers still go", () => {
      const bundle = transaction({ task: undefined });

      expect(
        bundle.entry?.map((entry) => entry.resource?.resourceType),
      ).toEqual(["QuestionnaireResponse", "Provenance"]);
    });
  });

  describe("the pre-send task read", () => {
    beforeEach(() => {
      fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // The token authorises a read on the destination, and the read is what makes If-Match honest.
    it("reads the task from the destination with the grant's token", async () => {
      fetchMock.mockResolvedValue(
        fhirResponse(DESTINATION_TASK, { headers: { ETag: 'W/"3"' } }),
      );

      expect(await readTask()).toEqual({
        url: "Task/task-1",
        resource: DESTINATION_TASK,
        ifMatch: 'W/"3"',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer opaque-access-token",
      );
    });

    // The ETag is the destination's own statement of the version. Fall back to the resource's.
    it("falls back to the task's own versionId when no ETag came back", async () => {
      fetchMock.mockResolvedValue(fhirResponse(DESTINATION_TASK));

      const task = await readTask();

      expect(task?.ifMatch).toBe('W/"3"');
    });

    /*
     * Rule: the token is presented only to the grant's origin. A published Task URL on another
     * host is the invitation asking a filler to authenticate somewhere the grant does not
     * authorise, so nothing is requested at all - not even to see whether it would have worked.
     */
    /*
     * Rule: the address is derived from `aud`, so the origin the invitation named cannot divert
     * the token anywhere. The invitation contributes an `id` and nothing else - which is a
     * stronger guarantee than the same-origin comparison this replaced, because there is no URL
     * left that could pass a check and still be presented to.
     */
    it.for([
      "https://elsewhere.example.org/fhir/Task/task-1",
      "http://ehr.example.org/fhir/Task/task-1",
      "https://ehr.example.org/somewhere/else/Task/task-1",
    ])("reads from the grant's destination, not from %s", async (spelling) => {
      fetchMock.mockResolvedValue(
        fhirResponse(DESTINATION_TASK, { headers: { ETag: 'W/"3"' } }),
      );

      await readTask(spelling);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${AUD}/Task/task-1`);
    });

    // An `id` is all the invitation gets to contribute, so it is held to the `id` grammar - and
    // to the separate rule that a valid FHIR id may still be path traversal.
    it.for([
      "https://ehr.example.org/fhir/Task/",
      "https://ehr.example.org/fhir/Task/.",
      "https://ehr.example.org/fhir/Task/..",
      `https://ehr.example.org/fhir/Task/${"t".repeat(65)}`,
    ])("yields no task for a URL ending %s", async (spelling) => {
      await expect(readTask(spelling)).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    // A grant whose own destination is not https is one no token may be presented to at all.
    it("yields no task when the grant's destination is not https", async () => {
      const task = await readDestinationTask({
        grant: { ...GRANT, aud: "http://ehr.example.org/fhir" },
        serverTaskUrl: "https://ehr.example.org/fhir/Task/task-1",
      });

      expect(task).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // Rule: unreadable task, no task entry. The answers are what matter.
    it("yields no task when the destination refuses the read", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 403 }));

      await expect(readTask()).resolves.toBeUndefined();
    });

    // A redirect is a rewrite that would carry the token elsewhere. Not followed, not read.
    it("yields no task when the read is redirected", async () => {
      fetchMock.mockResolvedValue(
        new Response("", {
          status: 302,
          headers: { Location: "https://elsewhere.example.org/Task/task-1" },
        }),
      );

      await expect(readTask()).resolves.toBeUndefined();
    });

    /*
     * Rule: never overwrite a task the clinic has since moved to another state (FR-022). Asserted
     * as a map so a single failing status names itself in the diff.
     */
    it("yields no task when the destination has already finished with it", async () => {
      const finished = [
        "completed",
        "cancelled",
        "entered-in-error",
        "failed",
        "rejected",
      ] as const;

      const read: Record<string, unknown> = {};
      for (const status of finished) {
        fetchMock.mockResolvedValue(
          fhirResponse({ ...DESTINATION_TASK, status }),
        );
        read[status] = await readTask();
      }

      expect(read).toEqual({
        completed: undefined,
        cancelled: undefined,
        "entered-in-error": undefined,
        failed: undefined,
        rejected: undefined,
      });
    });

    // Something that is not a Task cannot be completed as one, whatever the URL promised.
    it("yields no task when what came back is not a Task", async () => {
      fetchMock.mockResolvedValue(
        fhirResponse({ resourceType: "OperationOutcome" }),
      );

      await expect(readTask()).resolves.toBeUndefined();
    });

    // A network that dropped is an unreadable task, not a failed send.
    it("yields no task when the read could not be made at all", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

      await expect(readTask()).resolves.toBeUndefined();
    });
  });
});
