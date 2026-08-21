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

import type { Bundle, Questionnaire, Task } from "fhir/r4";

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
  });

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
