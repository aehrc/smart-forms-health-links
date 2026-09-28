/**
 * The invitation payload: what a filler receives when a link is opened.
 *
 * This is the plaintext of the manifest's `application/fhir+json` file - a `collection` Bundle
 * carrying the whole Questionnaire and the request Task (`contracts/shl-wire.md`). It lived
 * inside `src/link/createLink.ts` while the browser did the minting. It is here now because the
 * component that mints is the server (FR-013), and the server needs the same builder the
 * browser used, unchanged: a Platypus build must consume these invitations without adaptation,
 * so any drift in this Bundle is an interoperability break rather than a refactor.
 *
 * Two things are worth stating about the shape.
 *
 * **The contract is inherited, not restated.** {@link buildInvitationBundle} delegates to
 * `buildRequestBundle` in `src/link/exchange.ts`, which is where the canonical-in-`focus`,
 * canonical-in-`input`, durable-`urn:uuid`-identifier rules already live and are already
 * exercised by the round-trip checks. Restating them here would be two places to get wrong.
 *
 * **The Task is built twice, on purpose.** The embedded copy names the published Task's
 * absolute URL, which cannot be known until the Task has been written to the issuer. So the
 * caller builds once with no `publishedTaskUrl` to get the copy to publish, then again with the
 * URL the issuer returned. Both calls are given the same `requestId` and `authoredOn`, so the
 * two Tasks differ by exactly one extension - which is what lets a filler complete the very
 * Task the requester is tracking.
 * @author John Grimes
 */

import { buildRequestBundle } from "./exchange";
import { buildWriteDescriptorExtension } from "./replyDescriptor";

import type { WriteDescriptor } from "./replyDescriptor";
import type {
  Bundle,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

/** Details of the request the invitation is asking someone to answer. */
export interface InvitationBundleOptions {
  /**
   * Correlation key, as a bare UUID. Generated when omitted.
   *
   * Supply it when building the second copy, or the embedded Task will carry a different
   * business identifier from the one published on the issuer and the answers will not match
   * back.
   */
  readonly requestId?: string;
  /** Who is asking, for `Task.requester.display`. See {@link invitationRequesterDisplay}. */
  readonly requesterDisplay?: string;
  /** Who the form is for, e.g. `Patient/pt-1`. */
  readonly subjectReference?: string;
  /** Who the form is for, in words - the part a filler can actually read. */
  readonly subjectDisplay?: string;
  /** ISO instant the request was authored. Defaults to now; pin it across both copies. */
  readonly authoredOn?: string;
  /**
   * Absolute URL of the Task published on the issuer.
   *
   * Omitted for the copy that is about to be published; supplied for the copy that travels
   * inside the invitation.
   */
  readonly publishedTaskUrl?: string;
  /**
   * Channel D's slot, when this deployment offers one.
   *
   * Added to the Task the invitation carries, so a filler whose direct-send window has closed - or
   * whose destination never had Backend Services to open one with - still has somewhere to put the
   * answers. The descriptor names a slot that must already exist: nothing can be added to a link
   * once it is sealed, so the slot is minted before the payload is encrypted.
   */
  readonly writeDescriptor?: WriteDescriptor;
  /**
   * Answers filled in from the record before sending, already pruned to what the clinician kept.
   *
   * Travels only in the copy that is sealed into the link. The published Task must not carry it:
   * it is record content, and the point of publishing is to record *that* a request was sent, not
   * to put an extract of a chart on the server a second time.
   */
  readonly prePopulated?: QuestionnaireResponse;
}

/** A built invitation. */
export interface InvitationBundle {
  /** The `collection` Bundle: the whole Questionnaire, then the Task. */
  readonly bundle: Bundle;
  /** The Task, as embedded in the Bundle. */
  readonly task: Task;
  /** The durable `urn:uuid:` business identifier the Task carries. */
  readonly requestIdentifier: string;
}

/**
 * Build the invitation Bundle for a questionnaire.
 * @param questionnaire the form being requested, embedded whole so the filler needs no
 *   catalogue access
 * @param options the request details, including the published Task's URL when there is one
 * @returns the Bundle, the Task inside it, and the Task's business identifier
 * @throws {Error} when the questionnaire has no canonical `url`, since neither `Task.focus` nor
 *   `Task.input` could then identify the form to anyone receiving it
 * @example
 * const requestId = randomUUID();
 * const toPublish = buildInvitationBundle(questionnaire, { requestId, requesterDisplay });
 * const taskUrl = await publish(toPublish.task);
 * const invitation = buildInvitationBundle(questionnaire, {
 *   requestId,
 *   requesterDisplay,
 *   publishedTaskUrl: taskUrl,
 * });
 */
export function buildInvitationBundle(
  questionnaire: Questionnaire,
  options: InvitationBundleOptions = {},
): InvitationBundle {
  if (
    questionnaire.url === undefined ||
    questionnaire.url.trim().length === 0
  ) {
    throw new Error(
      `"${questionnaire.title ?? questionnaire.name ?? questionnaire.id ?? "This questionnaire"}" ` +
        "has no canonical url, so an invitation to it could not name which form to fill in.",
    );
  }

  const requestId = options.requestId ?? crypto.randomUUID();
  const { bundle, task } = buildRequestBundle(questionnaire, {
    requestId,
    requesterDisplay: options.requesterDisplay,
    subjectReference: options.subjectReference,
    subjectDisplay: options.subjectDisplay,
    authoredOn: options.authoredOn,
    serverTaskUrl: options.publishedTaskUrl,
    prePopulated: options.prePopulated,
  });

  if (options.writeDescriptor !== undefined) {
    // Mutated after the build rather than threaded through `buildRequestBundle`, because the
    // descriptor is this app's offer about its own hosting rather than part of the request's
    // meaning. `task` is the same object the bundle holds, so one push reaches both.
    task.extension = [
      ...(task.extension ?? []),
      buildWriteDescriptorExtension(options.writeDescriptor),
    ];
  }

  return { bundle, task, requestIdentifier: `urn:uuid:${requestId}` };
}

/**
 * Decide what an invitation says about who sent it.
 *
 * The signed-in user is the truth and wins. The configured sender name covers the case where
 * the launch disclosed nobody, which is legal. When neither is known the invitation says
 * nothing: an invitation that cannot name its requester is one a patient has every reason to
 * decline, and that is a better outcome than one naming a requester nobody configured.
 * @param userDisplay display name for the signed-in user, from the session
 * @param senderName the deployment's configured fallback
 * @returns the display name to write to `Task.requester.display`, or undefined for neither
 * @example
 * invitationRequesterDisplay(session.userDisplay, config.senderName);
 */
export function invitationRequesterDisplay(
  userDisplay?: string | null,
  senderName?: string | null,
): string | undefined {
  for (const candidate of [userDisplay, senderName]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

/**
 * Marks a Task on the EHR as a request this app sent, so sent requests can be listed back.
 *
 * A tag rather than a naming convention because it is searchable:
 * `Task?_tag=…|shl-form-request` returns exactly our requests and nothing else on a server shared
 * with other tools. `/requests` is built entirely on that search, so a Task published without this
 * tag lands on the server and never appears as sent.
 */
export const SHL_REQUEST_TAG = {
  system: "http://smartforms.csiro.au/CodeSystem/shl-request",
  code: "shl-form-request",
  display: "Form request sent as a SMART Health Link",
} as const;

/**
 * Marks a request Task as the standing one behind a printed code, rather than a request sent to
 * one person.
 *
 * It sits *beside* {@link SHL_REQUEST_TAG} rather than instead of it, so the practice still sees
 * the walk-in code in the same place as everything else this app has asked for. What it adds is
 * the fact `/requests` needs to tell the truth about the row: a standing request is never
 * answered, because no walk-in completes it, so labelling it "awaiting answers" for the life of
 * the poster would be wrong.
 */
export const SHL_STANDING_REQUEST_TAG = {
  system: "http://smartforms.csiro.au/CodeSystem/shl-request",
  code: "shl-standing-request",
  display: "Standing form request behind a printed code",
} as const;

/**
 * Marks answers that arrived from a printed code, so staff can find them before anyone files them.
 *
 * Stamped by the facade on the forwarded QuestionnaireResponse, never by a filler: whether a set
 * of answers came from a walk-in is a property of the invitation they were written against, not a
 * claim the sender gets to make. The review queue is one search on it
 * (`QuestionnaireResponse?_tag=…|shl-walk-in`), and accepting an item removes it, which is what
 * takes the item out of the queue.
 */
export const SHL_WALK_IN_TAG = {
  system: "http://smartforms.csiro.au/CodeSystem/shl-request",
  code: "shl-walk-in",
  display: "Answers given by someone who scanned a printed code",
} as const;

/**
 * The server-storable form of a request Task.
 *
 * Two deliberate differences from the copy inside the invitation, and both are about what a
 * reference means once the Bundle is taken apart.
 *
 *  - **No `focus`.** The invitation names the Questionnaire by canonical, which is the only form
 *    that still means anything to a filler holding the Bundle. FHIR servers will not store that as
 *    a `Reference`:
 *
 *      HAPI-0506: Invalid resource reference found at path[Task.focus] - Resource type is unknown
 *                 or not supported on this server - http://example.org/Q/probe|1.0
 *
 *    So the published copy drops it and relies on `input[].valueCanonical`, which is a `canonical`
 *    rather than a `Reference` and stores fine. The return leg makes the same split.
 *  - **No extensions.** The invitation's copy carries the published Task's own URL, and any
 *    return-channel descriptor a third-party producer declared. A Task cannot cite its own address
 *    before that address exists, and a capability on a resource whose purpose is to be read is a
 *    capability handed to every reader.
 *
 * It lives beside {@link buildInvitationBundle} because it is the same Task in its other form, and
 * because both the browser and the server need it: the server publishes through it when minting an
 * invitation, and `check:roundtrip` asserts its shape.
 * @param task the request Task as the invitation carries it
 * @param standing whether this is the standing request behind a printed code
 * @returns the copy to write to the launched server
 * @example
 * await publishTask(session, JSON.stringify(asPublishedTask(task)));
 */
export function asPublishedTask(task: Task, standing = false): Task {
  const rest = { ...task };
  delete rest.focus;
  delete rest.extension;

  return {
    ...rest,
    meta: {
      ...task.meta,
      tag: [
        ...(task.meta?.tag ?? []),
        { ...SHL_REQUEST_TAG },
        ...(standing ? [{ ...SHL_STANDING_REQUEST_TAG }] : []),
      ],
    },
  };
}
