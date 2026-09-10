/**
 * Tests for `src/link/invitationBundle.ts`: the payload a filler actually receives.
 *
 * This Bundle is an interoperability boundary (`contracts/shl-wire.md`), so the tests are
 * written as statements about the wire rather than about the code that produces it. Three
 * groups:
 *
 *  1. **The existing invitation contract is preserved.** The canonical in `Task.focus` *and*
 *     `Task.input[].valueCanonical`, a durable `urn:uuid` business identifier,
 *     `requester.display`, and a `for` carrying both a reference and a display. Every one of
 *     these was already load-bearing for a third-party filler before this feature, and
 *     extracting the builder out of `src/link/createLink.ts` must not have moved any of it.
 *  2. **The one addition.** `invitation-server-task-url` names the Task published on the
 *     issuer. It is what entitles a filler to complete the Task on the destination, so it must
 *     appear when - and only when - a Task has actually been published there.
 *  3. **Who is asking.** The signed-in user's display name is the truth; the configured
 *     `senderName` is a fallback for a launch that disclosed nobody. An invitation that can
 *     say neither says nothing rather than inventing a requester.
 * @author John Grimes
 */

import { describe, expect, it } from "vitest";

import type { Bundle, Questionnaire, Task } from "fhir/r4";

import {
  buildInvitationBundle,
  invitationRequesterDisplay,
} from "@/link/invitationBundle";
import { PLATYPUS_SERVER_TASK_URL_EXTENSION } from "@/link/replyDescriptor";

/** The Task published on the issuer for these fixtures. */
const PUBLISHED_TASK_URL = "https://ehr.example.org/fhir/Task/task-1";

/** A questionnaire with a canonical URL and a version, as a real catalogue entry has. */
const QUESTIONNAIRE: Questionnaire = {
  resourceType: "Questionnaire",
  id: "q-715",
  url: "http://example.org/Questionnaire/715",
  version: "1.2.0",
  name: "ChronicConditionPlan",
  title: "Chronic Condition Management Plan",
  status: "active",
  item: [{ linkId: "1", text: "How are you feeling?", type: "string" }],
};

/**
 * The Task carried inside an invitation Bundle.
 * @param bundle the invitation Bundle
 * @returns the Task entry's resource
 */
function taskOf(bundle: Bundle): Task {
  const task = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is Task => resource?.resourceType === "Task");
  if (task === undefined) {
    throw new Error("the invitation Bundle carries no Task");
  }
  return task;
}

describe("the invitation Bundle", () => {
  describe("the existing invitation contract", () => {
    // The whole Questionnaire travels, so a filler needs no access to the forms catalogue.
    it("embeds the questionnaire whole rather than by reference", () => {
      const { bundle } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      const questionnaire = (bundle.entry ?? [])
        .map((entry) => entry.resource)
        .find(
          (resource): resource is Questionnaire =>
            resource?.resourceType === "Questionnaire",
        );
      expect(bundle.type).toBe("collection");
      expect(questionnaire).toEqual(QUESTIONNAIRE);
    });

    /*
     * A `urn:uuid` focus reads to a third-party filler as a Task it cannot match, degrading a
     * full invitation to a bare form with no return path. The canonical is the only answer that
     * survives the Bundle being taken apart.
     */
    it("names the questionnaire in Task.focus by canonical, not by urn:uuid", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.focus).toEqual({
        reference: "http://example.org/Questionnaire/715|1.2.0",
        type: "Questionnaire",
        display: "Chronic Condition Management Plan",
      });
    });

    // `focus` is dropped on the return leg, so `input` is what records which form was answered.
    it("duplicates the canonical into Task.input[].valueCanonical", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.input).toEqual([
        {
          type: { text: "questionnaire" },
          valueCanonical: "http://example.org/Questionnaire/715|1.2.0",
        },
      ]);
    });

    // The only correlation key that survives the round trip, and the conditional-create key.
    it("carries a durable urn:uuid business identifier", () => {
      const { task, requestIdentifier } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(requestIdentifier).toMatch(
        /^urn:uuid:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
      );
      expect(task.identifier).toEqual([
        { system: "urn:ietf:rfc:3986", value: requestIdentifier },
      ]);
    });

    // Given the same request id, the published copy and the embedded copy must agree.
    it("uses the supplied request id so the published and embedded copies agree", () => {
      const requestId = "2f1a0e6c-8c1f-4a2f-9b64-8f0a1c3d5e7b";

      const first = buildInvitationBundle(QUESTIONNAIRE, { requestId });
      const second = buildInvitationBundle(QUESTIONNAIRE, {
        requestId,
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(first.requestIdentifier).toBe(`urn:uuid:${requestId}`);
      expect(second.requestIdentifier).toBe(first.requestIdentifier);
    });

    it("records who is asking in Task.requester.display", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        requesterDisplay: "Dr Jane Smith",
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.requester).toEqual({ display: "Dr Jane Smith" });
    });

    /*
     * A filler generally cannot resolve the reference - it names a server it has no access to -
     * so the display is the only part of "who is this for" that survives. Both travel.
     */
    it("carries both the reference and the display in Task.for", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        subjectReference: "Patient/pt-1",
        subjectDisplay: "Jane Citizen",
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.for).toEqual({
        reference: "Patient/pt-1",
        display: "Jane Citizen",
      });
    });

    it("omits Task.for entirely when the request names nobody", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.for).toBeUndefined();
    });

    it("asks for the form to be filled in", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.status).toBe("requested");
      expect(task.intent).toBe("order");
      expect(task.description).toBe(
        'Complete "Chronic Condition Management Plan"',
      );
    });
  });

  describe("the published Task", () => {
    // `valueUrl` on the issuer's origin is what entitles a filler to complete the Task there.
    it("names the published Task's absolute URL in the invitation-server-task-url extension", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(task.extension).toEqual([
        {
          url: PLATYPUS_SERVER_TASK_URL_EXTENSION,
          valueUrl: PUBLISHED_TASK_URL,
        },
      ]);
    });

    // The wire identifier is Platypus's, because that is the interoperability boundary.
    it("uses the extension URL the filler contract defines", () => {
      expect(PLATYPUS_SERVER_TASK_URL_EXTENSION).toBe(
        "https://platypushealth.app/StructureDefinition/invitation-server-task-url",
      );
    });

    /*
     * The copy that gets published must not claim a URL for itself: it is built before the
     * write, and a Task that pointed at itself would be a claim nothing had yet established.
     */
    it("carries no extension on the copy built before publishing", () => {
      const { task } = buildInvitationBundle(QUESTIONNAIRE);

      expect(task.extension).toBeUndefined();
    });

    // Nothing but the extension may differ, or the filler is completing a different request.
    it("differs from the pre-publish copy by the extension alone", () => {
      const requestId = "6b0f8a1d-2c3e-4f5a-8b7c-9d0e1f2a3b4c";
      const authoredOn = "2026-08-22T01:02:03.000Z";

      const published = buildInvitationBundle(QUESTIONNAIRE, {
        requestId,
        authoredOn,
      }).task;
      const embedded = buildInvitationBundle(QUESTIONNAIRE, {
        requestId,
        authoredOn,
        publishedTaskUrl: PUBLISHED_TASK_URL,
      }).task;

      const { extension, ...withoutExtension } = embedded;
      expect(extension).toHaveLength(1);
      expect(withoutExtension).toEqual(published);
    });
  });

  describe("who the invitation says it is from", () => {
    it("prefers the signed-in user's display name", () => {
      expect(
        invitationRequesterDisplay("Dr Jane Smith", "Parkview Medical Centre"),
      ).toBe("Dr Jane Smith");
    });

    it("falls back to the configured sender name when the launch disclosed no user", () => {
      expect(invitationRequesterDisplay(null, "Parkview Medical Centre")).toBe(
        "Parkview Medical Centre",
      );
    });

    // An empty display is not a name; it would put `requester: { display: "" }` on the wire.
    it("treats a blank user display as no user at all", () => {
      expect(
        invitationRequesterDisplay(" ".repeat(3), "Parkview Medical Centre"),
      ).toBe("Parkview Medical Centre");
    });

    /*
     * An invitation that cannot say who sent it is one a patient has every reason to decline -
     * which is a better outcome than one that names a requester nobody configured.
     */
    it("says nothing when neither a user nor a sender name is known", () => {
      expect(invitationRequesterDisplay(null, null)).toBeUndefined();
      expect(
        buildInvitationBundle(QUESTIONNAIRE, {
          publishedTaskUrl: PUBLISHED_TASK_URL,
        }).task.requester,
      ).toBeUndefined();
    });
  });

  describe("the Bundle as a whole", () => {
    // Both entries need a `fullUrl` or intra-Bundle references cannot be resolved at all.
    it("gives every entry a urn:uuid fullUrl", () => {
      const { bundle } = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(bundle.entry).toHaveLength(2);
      for (const entry of bundle.entry ?? []) {
        expect(entry.fullUrl).toMatch(/^urn:uuid:/);
      }
    });

    // The Task in the Bundle is the Task returned, not a copy that drifted from it.
    it("returns the same Task it embedded", () => {
      const built = buildInvitationBundle(QUESTIONNAIRE, {
        publishedTaskUrl: PUBLISHED_TASK_URL,
      });

      expect(taskOf(built.bundle)).toEqual(built.task);
    });

    /*
     * A Questionnaire with no canonical cannot be resolved by anyone who receives it, and the
     * Task's `focus` and `input` would both be empty. Refusing is better than minting an
     * invitation that opens as a form nobody can identify.
     */
    it("refuses a questionnaire with no canonical url", () => {
      expect(() =>
        buildInvitationBundle({
          resourceType: "Questionnaire",
          id: "q-no-url",
          status: "active",
          item: [{ linkId: "1", text: "?", type: "string" }],
        }),
      ).toThrow(/canonical/i);
    });
  });
});
