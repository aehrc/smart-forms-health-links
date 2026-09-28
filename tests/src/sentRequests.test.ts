/**
 * Deriving `/requests` from the published Tasks, and from nothing else.
 *
 * The page used to be a union of these Tasks with a browser-local store holding channel C reply
 * keys. That channel is no longer minted here, so the store went and the Task is now the whole
 * answer (FR-011). These assertions pin the derivation that replaced it: which rows appear, what
 * state each one is in, and where its answers are.
 *
 * The interesting case is the one the old page got wrong. A request answered through the token
 * channel lands on the server and completes its own Task, with no involvement from the browser
 * that minted it - so `completed` has to read as answered here even though nothing local ever
 * recorded a collection.
 */

import { describe, expect, it } from "vitest";

import type { Task } from "fhir/r4";

import { RESPONSE_OUTPUT_TYPE } from "@/fhir/taskCompletion";
import {
  describeSentRequests,
  labelFromTask,
  requestState,
} from "@/lib/sentRequests";
import {
  SHL_REQUEST_TAG,
  SHL_STANDING_REQUEST_TAG,
} from "@/link/invitationBundle";

/**
 * A published request Task, as `searchPublishedRequests` returns one.
 * @param overrides the parts a case varies
 * @returns the Task
 */
function publishedTask(overrides: Partial<Task> = {}): Task {
  return {
    resourceType: "Task",
    id: "t-1",
    status: "requested",
    intent: "order",
    identifier: [{ system: "urn:ietf:rfc:3986", value: "urn:uuid:request-1" }],
    authoredOn: "2026-09-04T02:41:45.000Z",
    description: 'Complete "Adult Sepsis Primary Healthcare Screening Tool"',
    requester: { display: "Dr Alex Fielding" },
    for: { reference: "Patient/137287372", display: "Jane Citizen" },
    input: [
      {
        type: { text: "questionnaire" },
        valueCanonical: "http://example.org/Questionnaire/sepsis|1.0.0",
      },
    ],
    ...overrides,
  };
}

describe("describeSentRequests", () => {
  it("describes an unanswered request from its Task alone", () => {
    const [request] = describeSentRequests([publishedTask()]);

    expect(request).toMatchObject({
      id: "urn:uuid:request-1",
      taskId: "t-1",
      label: "Adult Sepsis Primary Healthcare Screening Tool",
      state: "awaiting",
      createdAt: "2026-09-04T02:41:45.000Z",
      subjectDisplay: "Jane Citizen",
      subjectReference: "Patient/137287372",
      requesterDisplay: "Dr Alex Fielding",
    });
    expect(request.responseReference).toBeUndefined();
  });

  it("reads a completed Task as answered, and names the answers", () => {
    const [request] = describeSentRequests([
      publishedTask({
        status: "completed",
        output: [
          {
            type: RESPONSE_OUTPUT_TYPE,
            valueReference: { reference: "QuestionnaireResponse/qr-9" },
          },
        ],
      }),
    ]);

    expect(request.state).toBe("answered");
    expect(request.responseReference).toBe("QuestionnaireResponse/qr-9");
  });

  it("takes an untyped output as the answers rather than reporting none", () => {
    // A Task completed by some other client is still a request of ours that has been answered.
    const [request] = describeSentRequests([
      publishedTask({
        status: "completed",
        output: [
          { type: { text: "note" }, valueString: "no reference here" },
          {
            type: { text: "response" },
            valueReference: { reference: "QuestionnaireResponse/qr-10" },
          },
        ],
      }),
    ]);

    expect(request.responseReference).toBe("QuestionnaireResponse/qr-10");
  });

  /*
   * The walk-in code's own request. It is published so the practice can see that a poster exists,
   * and it will never be completed, because no single walk-in may finish a request that serves
   * everybody else who scans the same code. Reporting it as awaiting answers would be true of the
   * resource and misleading about the practice.
   */
  it("marks the standing request behind a printed code as standing", () => {
    const [request] = describeSentRequests([
      publishedTask({
        meta: {
          tag: [{ ...SHL_REQUEST_TAG }, { ...SHL_STANDING_REQUEST_TAG }],
        },
        for: undefined,
      }),
    ]);

    expect(request.standing).toBe(true);
    // Still awaiting as far as the Task is concerned; the flag is what the view reads instead.
    expect(request.state).toBe("awaiting");
  });

  // An ordinary request carries only the one tag, and must not be mistaken for a poster.
  it("does not mark an ordinary request as standing", () => {
    const [request] = describeSentRequests([
      publishedTask({ meta: { tag: [{ ...SHL_REQUEST_TAG }] } }),
    ]);

    expect(request.standing).toBe(false);
  });

  // Inferred from the tag and nothing else: a per-patient request may legitimately name nobody,
  // so the absence of a subject says nothing about whether a code was printed.
  it("does not infer standing from a request that names no subject", () => {
    const [request] = describeSentRequests([publishedTask({ for: undefined })]);

    expect(request.standing).toBe(false);
  });

  it("drops a Task with no identifier, which nothing could ever answer", () => {
    expect(
      describeSentRequests([publishedTask({ identifier: undefined })]),
    ).toHaveLength(0);
  });

  it("orders newest first", () => {
    const rows = describeSentRequests([
      publishedTask({
        id: "t-old",
        identifier: [{ value: "urn:uuid:old" }],
        authoredOn: "2026-09-01T00:00:00.000Z",
      }),
      publishedTask({
        id: "t-new",
        identifier: [{ value: "urn:uuid:new" }],
        authoredOn: "2026-09-08T00:00:00.000Z",
      }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["urn:uuid:new", "urn:uuid:old"]);
  });
});

describe("requestState", () => {
  it("treats only completed as answered", () => {
    expect(requestState("completed")).toBe("answered");
  });

  it("does not report a request ended without answers as answered", () => {
    const ended: Task["status"][] = [
      "cancelled",
      "rejected",
      "failed",
      "entered-in-error",
    ];

    expect(ended.map((status) => requestState(status))).toEqual([
      "closed",
      "closed",
      "closed",
      "closed",
    ]);
  });

  it("treats every open status as still awaiting answers", () => {
    const open: Task["status"][] = [
      "draft",
      "requested",
      "received",
      "accepted",
      "ready",
      "in-progress",
      "on-hold",
    ];

    expect(new Set(open.map((status) => requestState(status)))).toEqual(
      new Set(["awaiting"]),
    );
  });
});

describe("labelFromTask", () => {
  it("recovers the form title from the description", () => {
    expect(labelFromTask(publishedTask())).toBe(
      "Adult Sepsis Primary Healthcare Screening Tool",
    );
  });

  it("falls back to the canonical's last segment", () => {
    expect(labelFromTask(publishedTask({ description: undefined }))).toBe(
      "sepsis",
    );
  });

  it("says something true when the Task names no form at all", () => {
    expect(
      labelFromTask(
        publishedTask({
          description: undefined,
          input: undefined,
          focus: undefined,
        }),
      ),
    ).toBe("Requested form");
  });
});
