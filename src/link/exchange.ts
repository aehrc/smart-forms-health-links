import { collectionBundle, findInBundle } from "./codec";
import {
  buildReplyDescriptorExtension,
  buildServerTaskUrlExtension,
  isServerTaskUrlExtension,
  type ReplyDescriptor,
} from "./replyDescriptor";

import type {
  Bundle,
  Extension,
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

/**
 * The two payloads that travel between a requester and a form filler.
 *
 * **Request**  `Bundle{Questionnaire, Task}` - "please fill this in"
 * **Response** `Bundle{QuestionnaireResponse, Task}` - "here are the answers"
 *
 * ## Why the Task, and why it points the way it does
 *
 * R4 gives QuestionnaireResponse no way to reference a Task: `basedOn` accepts only
 * `CarePlan|ServiceRequest`, `partOf` only `Observation|Procedure`, and `identifier` is `0..1`.
 * Correlation therefore has to run from the Task outward (`Task.focus` at the Questionnaire and
 * `Task.output.valueReference` at the QuestionnaireResponse) with the Task itself round-tripping
 * inside the Bundle. No extensions needed.
 *
 * Within a Bundle those references use `urn:uuid:` against sibling `fullUrl`s, which is why
 * `collectionBundle` sets them.
 *
 * The Task's `identifier` is the durable correlation key: it survives the round trip even though the
 * `urn:uuid` values do not, so a requester with several outstanding requests for the same form can
 * still tell the answers apart.
 */

/** `Task.input`/`output` slot describing which questionnaire the task concerns. */
const QUESTIONNAIRE_INPUT_TYPE = { text: "questionnaire" } as const;
const RESPONSE_OUTPUT_TYPE = { text: "questionnaire-response" } as const;

/** RFC 3986 URI namespace, the conventional system for a UUID-based business identifier. */
const URI_IDENTIFIER_SYSTEM = "urn:ietf:rfc:3986";

/**
 * "This content was asserted by the patient, not by a clinician."
 *
 * From US Core's Writing Clinical Notes guidance, and the same coding Platypus stamps on a reply
 * (`apps/mobile/lib/write-engine/attribution.ts`). It is the single most important thing on a
 * third-party response: without it, answers typed by a patient on their own phone are
 * indistinguishable in the record from answers recorded by a clinician.
 */
export const PATIENT_ASSERTED_SECURITY = {
  system: "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
  code: "PATAST",
  display: "patient asserted",
} as const;

export const PROVENANCE_PARTICIPANT_TYPE =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";

export interface RequestPayload {
  questionnaire: Questionnaire;
  task: Task;
  /**
   * Answers filled in from the record before the request was sent, when it carried any.
   *
   * Dropped rather than rendered when it cites a different form than the request does - see
   * {@link parseRequestBundle}.
   */
  prePopulated?: QuestionnaireResponse;
}

export interface ResponsePayload {
  response: QuestionnaireResponse;
  /** Absent when the filler dropped it, which is legal but loses correlation. */
  task?: Task;
  /**
   * Who asserted the answers, when the filler said.
   *
   * Present on encrypted-channel replies and absent from a plain link. It is attribution rather than
   * clinical content, so nothing depends on it - but it must be written when it is there, because it is
   * the record of the answers having come from outside.
   */
  provenance?: Provenance;
}

export interface BuildRequestOptions {
  /** Who the form is for, e.g. `Patient/123`. */
  subjectReference?: string;
  /**
   * Who the form is for, in words.
   *
   * Carried separately because a filler generally cannot resolve `subjectReference` - it references a
   * server the filler has no access to. A name is the only part of "who is this for" that survives the
   * trip, and it is what lets a filler warn that a form names someone other than the person holding
   * the device.
   */
  subjectDisplay?: string;
  /** Who is asking, e.g. a practice name. Shown to the filler before anything is stored. */
  requesterDisplay?: string;
  /** Correlation key. Generated when omitted. */
  requestId?: string;
  /** ISO instant; defaults to now. */
  authoredOn?: string;
  /** Channel C: where an encrypted reply may be parked, and the key to encrypt it to. */
  replyDescriptor?: ReplyDescriptor;
  /** Channel B: absolute URL of this Task on the requester's own server. */
  serverTaskUrl?: string;
  /**
   * Answers filled in from the record before sending, already pruned to what the clinician kept.
   *
   * Normalised by {@link buildRequestBundle} rather than by the caller, and stripped of anything
   * that would outlive the trip - see `seedResponse`.
   */
  prePopulated?: QuestionnaireResponse;
}

function newUuid(): string {
  return crypto.randomUUID();
}

/**
 * Build the "please fill this in" payload.
 *
 * The Questionnaire is embedded in full rather than referenced, so the filler needs no access to the
 * forms server. That is what makes the payload large enough to require a hosted SHL rather than a
 * bare QR code.
 * @param questionnaire
 * @param options
 */
export function buildRequestBundle(
  questionnaire: Questionnaire,
  options: BuildRequestOptions = {},
): { bundle: Bundle; task: Task } {
  const questionnaireUuid = `urn:uuid:${newUuid()}`;
  const requestId = options.requestId ?? newUuid();

  const task: Task = {
    resourceType: "Task",
    status: "requested",
    intent: "order",
    identifier: [
      { system: URI_IDENTIFIER_SYSTEM, value: `urn:uuid:${requestId}` },
    ],
    authoredOn: options.authoredOn ?? new Date().toISOString(),
    description: `Complete "${questionnaire.title ?? questionnaire.name ?? "questionnaire"}"`,
    /*
     * `focus` names the Questionnaire by **canonical**, not by the `urn:uuid` of its Bundle entry.
     *
     * A urn:uuid would be the more obviously correct FHIR for a bundled resource, and it is what this
     * built before. It is the wrong choice here for a reason worth recording, because reverting it
     * silently breaks third parties: a filler holding only the Task has to decide *which form* this
     * is, and the canonical is the only answer that still means something once the Bundle has been
     * taken apart. Platypus resolves exactly this way, and a urn:uuid focus reads to it as a Task it
     * cannot match, degrading a full invitation to a bare form with no return path.
     *
     * `type` must be set together with this. Some readers short-circuit on
     * `focus.type === 'Questionnaire'` and stop looking at `input`, so a `type` alongside a urn:uuid
     * reference is worse than neither.
     */
    focus: questionnaire.url
      ? {
          reference: canonicalOf(questionnaire),
          type: "Questionnaire",
          display: questionnaire.title ?? questionnaire.name,
        }
      : {
          reference: questionnaireUuid,
          display: questionnaire.title ?? questionnaire.name,
        },
    /*
     * The canonical is duplicated into `input` deliberately, and stays duplicated even now that
     * `focus` carries it: `focus` is dropped on the return leg (it would dangle once the Questionnaire
     * is gone), so `input` is what survives to record which form was answered.
     */
    input: questionnaire.url
      ? [
          {
            type: QUESTIONNAIRE_INPUT_TYPE,
            valueCanonical: canonicalOf(questionnaire),
          },
        ]
      : undefined,
  };

  if (options.requesterDisplay) {
    task.requester = { display: options.requesterDisplay };
  }

  if (options.subjectReference || options.subjectDisplay) {
    task.for = {
      ...(options.subjectReference
        ? { reference: options.subjectReference }
        : {}),
      ...(options.subjectDisplay ? { display: options.subjectDisplay } : {}),
    };
  }

  const extensions: Extension[] = [];
  if (options.replyDescriptor) {
    extensions.push(buildReplyDescriptorExtension(options.replyDescriptor));
  }
  if (options.serverTaskUrl) {
    extensions.push(buildServerTaskUrlExtension(options.serverTaskUrl));
  }
  if (extensions.length > 0) {
    task.extension = extensions;
  }

  /*
   * Ordering keeps the Questionnaire first: `buildReplyBundle` already depends on entry order on the
   * return leg, and a reader treating the first entry as "the point of this payload" should still
   * find the form.
   */
  const seedUuid = `urn:uuid:${newUuid()}`;
  const seed =
    options.prePopulated === undefined
      ? undefined
      : seedResponse(options.prePopulated, questionnaire, task);

  if (seed !== undefined) {
    task.input = [
      ...(task.input ?? []),
      { type: RESPONSE_OUTPUT_TYPE, valueReference: { reference: seedUuid } },
    ];
  }

  const bundle = collectionBundle([
    { fullUrl: questionnaireUuid, resource: questionnaire },
    ...(seed === undefined ? [] : [{ fullUrl: seedUuid, resource: seed }]),
    { fullUrl: `urn:uuid:${newUuid()}`, resource: task },
  ]);

  return { bundle, task };
}

/**
 * Normalise answers filled in from the record into something safe to send.
 *
 * Everything stripped here is something that would otherwise outlive the trip and mean the wrong
 * thing at the other end. `id` names a resource on the requester's server; `author` and `authored`
 * would credit the clinician with answers the *patient* is about to be asked to confirm; and
 * `meta.security` would carry the record's own labels onto a document that is not the record.
 *
 * The status is forced to `in-progress`, which is load bearing rather than tidy: it is what
 * {@link isRequestBundle} reads to tell a seeded invitation from somebody's finished answers.
 * @param response the populated response, already pruned to what the clinician kept
 * @param questionnaire the form being requested
 * @param task the request Task, for the subject
 * @returns the response as it should travel inside the invitation
 */
function seedResponse(
  response: QuestionnaireResponse,
  questionnaire: Questionnaire,
  task: Task,
): QuestionnaireResponse {
  const {
    id: _id,
    author: _author,
    authored: _authored,
    meta,
    ...rest
  } = response;
  const { security: _security, ...restOfMeta } = meta ?? {};

  return {
    ...rest,
    ...(Object.keys(restOfMeta).length > 0 && { meta: restOfMeta }),
    resourceType: "QuestionnaireResponse",
    status: "in-progress",
    questionnaire:
      questionnaireCanonicalOf(questionnaire) ?? response.questionnaire,
    ...(task.for && { subject: task.for }),
  };
}

/**
 *
 * @param bundle
 */
export function parseRequestBundle(bundle: Bundle): RequestPayload {
  const questionnaire = findInBundle<Questionnaire>(bundle, "Questionnaire");
  if (!questionnaire) {
    throw new Error(
      "This link does not contain a Questionnaire, so there is no form to fill in. " +
        "It may be a completed response rather than a request.",
    );
  }

  const task = findInBundle<Task>(bundle, "Task");
  if (!task) {
    throw new Error(
      "This request is missing its Task, so the answers could not be matched back.",
    );
  }

  const prePopulated = findInBundle<QuestionnaireResponse>(
    bundle,
    "QuestionnaireResponse",
  );

  /*
   * A seed citing a different form than the request does is dropped rather than rendered. Seeding a
   * form with another form's answers puts values against `linkId`s that happen to collide, which is
   * a worse outcome than sending it blank and a far worse one than saying so - and this is
   * reachable from a payload somebody else wrote, not only from a bug here.
   *
   * Not `canonicalFromRequest`, which throws for a Questionnaire with no `url`. That is legal FHIR
   * and it already parses today, so raising here would fail a link over a seed rather than dropping
   * the seed. Where neither side names a canonical there is nothing to disagree about.
   */
  const seedCanonical = prePopulated?.questionnaire?.split("|", 1)[0];
  const requestCanonical = (
    task.input?.find((input) => input.valueCanonical)?.valueCanonical ??
    questionnaireCanonicalOf(questionnaire)
  )?.split("|", 1)[0];
  const seedMatches =
    seedCanonical === undefined ||
    requestCanonical === undefined ||
    seedCanonical === requestCanonical;

  return {
    questionnaire,
    task,
    ...(prePopulated && seedMatches && { prePopulated }),
  };
}

/**
 * Build the "here are the answers" payload.
 *
 * The Questionnaire is intentionally *not* included - the requester already has it, and re-sending
 * hundreds of kilobytes would push the payload past what a QR code can carry on the return leg.
 * @param response
 * @param requestTask
 */
export function buildResponseBundle(
  response: QuestionnaireResponse,
  requestTask?: Task,
): { bundle: Bundle; task?: Task } {
  const responseUuid = `urn:uuid:${newUuid()}`;

  if (!requestTask) {
    return {
      bundle: collectionBundle([{ fullUrl: responseUuid, resource: response }]),
    };
  }

  const serverTaskAddress = (requestTask.extension ?? []).filter((candidate) =>
    isServerTaskUrlExtension(candidate),
  );

  const task: Task = {
    ...requestTask,
    status: "completed",
    lastModified: new Date().toISOString(),
    /*
     * `focus` named the Questionnaire in the request Bundle. That entry is gone here, so the canonical
     * in `input` carries the same information without a reference to a resource the payload no longer
     * contains.
     */
    focus: undefined,
    /*
     * The request's extensions are sorted rather than dropped wholesale, because the two kinds
     * are not alike.
     *
     * A reply descriptor is a *capability*: a slot URL and possibly a token authorising a write
     * to it. Echoing that back serves no purpose and would copy a capability into whatever
     * transport the answers travel on, including an unencrypted QR.
     *
     * `invitation-server-task-url` is an *address* - the request's own Task on the requester's
     * server, which the requester published and already knows. It comes back because it is how
     * the requester finds the Task to complete when the answers return as a link rather than
     * through a direct send (FR-011). Without it the request stays "awaiting answers" forever
     * on a list that derives entirely from those Tasks. Nothing is disclosed by returning it:
     * reaching that URL takes the requester's own session, which whoever is reviewing has.
     */
    extension: serverTaskAddress.length > 0 ? serverTaskAddress : undefined,
    output: [
      {
        type: RESPONSE_OUTPUT_TYPE,
        valueReference: { reference: responseUuid },
      },
    ],
  };

  return {
    bundle: collectionBundle([
      { fullUrl: responseUuid, resource: response },
      { fullUrl: `urn:uuid:${newUuid()}`, resource: task },
    ]),
    task,
  };
}

/**
 * Which Questionnaire a set of answers belongs to, preferring what the answers themselves say.
 *
 * The fallback matters because the response is the only thing that crosses back, and a filler that
 * dropped the canonical has still answered a form whose identity the requester recorded when it
 * sent the invitation. Refusing to render answers we are holding, over a field we can supply
 * ourselves, would be unhelpful.
 *
 * Returns `undefined` when neither knows - the caller decides whether that is fatal, because it is
 * not always: answers can still be reviewed as a raw table without their form definition.
 * @param response
 * @param fallback
 */
export function responseCanonical(
  response: QuestionnaireResponse,
  fallback?: string,
): string | undefined {
  return response.questionnaire ?? fallback;
}

/**
 *
 * @param bundle
 */
export function parseResponseBundle(bundle: Bundle): ResponsePayload {
  const response = findInBundle<QuestionnaireResponse>(
    bundle,
    "QuestionnaireResponse",
  );
  if (!response) {
    throw new Error(
      "This link does not contain a QuestionnaireResponse, so there are no answers to review.",
    );
  }

  return {
    response,
    task: findInBundle<Task>(bundle, "Task"),
    provenance: findInBundle<Provenance>(bundle, "Provenance"),
  };
}

export interface BuildReplyOptions {
  /** The Task that arrived with the request, so the answers can be matched to what was asked. */
  requestTask?: Task;
  /**
   * Who is asserting the answers, e.g. `Patient/123`.
   *
   * Defaults to the response's own `author` or `subject`. Without any of them there is nobody to
   * attribute the Provenance to, so it is omitted rather than fabricated.
   */
  patientReference?: string;
  /** ISO instant; defaults to now. */
  recorded?: string;
}

/**
 * Build the encrypted-channel reply payload: the answers, plus who says so.
 *
 * The difference from {@link buildResponseBundle} is entirely about attribution, and it matters
 * because this is the channel third-party fillers use. A response arriving from a patient's own phone
 * must not be indistinguishable from one a clinician recorded, so it carries:
 *
 *  - `meta.security` = `PATAST`, "patient asserted"; and
 *  - a `Provenance` naming the patient as author.
 *
 * The local `id` is dropped: it is identity assigned by the filler's own store and means nothing on the
 * requester's server. Wire shapes follow Platypus's `lib/shl-reply.ts` so both apps' replies read
 * identically to a receiver.
 * @param response
 * @param options
 */
export function buildReplyBundle(
  response: QuestionnaireResponse,
  options: BuildReplyOptions = {},
): { bundle: Bundle; provenance?: Provenance } {
  const withoutLocalId = { ...response };
  delete withoutLocalId.id;

  const attributed: QuestionnaireResponse = {
    ...withoutLocalId,
    status: "completed",
    meta: {
      ...response.meta,
      security: [
        ...(response.meta?.security ?? []),
        { ...PATIENT_ASSERTED_SECURITY },
      ],
    },
  };

  const { bundle } = buildResponseBundle(attributed, options.requestTask);
  // `buildResponseBundle` always puts the response first, and its `fullUrl` is what a Provenance has
  // to target - the response has no server id yet.
  const responseUuid = bundle.entry?.[0]?.fullUrl;

  const patientReference =
    options.patientReference ??
    response.author?.reference ??
    response.subject?.reference;

  if (!patientReference || !responseUuid) {
    // `Provenance.agent.who` is 1..1, so there is no valid Provenance to write without someone to
    // name. The security label already records that the content is patient-asserted.
    return { bundle };
  }

  const provenance: Provenance = {
    resourceType: "Provenance",
    target: [{ reference: responseUuid }],
    recorded: options.recorded ?? new Date().toISOString(),
    agent: [
      {
        type: {
          coding: [
            {
              system: PROVENANCE_PARTICIPANT_TYPE,
              code: "author",
              display: "Author",
            },
          ],
        },
        who: { reference: patientReference },
      },
    ],
  };

  return {
    bundle: collectionBundle([
      ...(bundle.entry ?? []).map((entry) => ({
        fullUrl: entry.fullUrl,
        resource: entry.resource!,
      })),
      { fullUrl: `urn:uuid:${newUuid()}`, resource: provenance },
    ]),
    provenance,
  };
}

/**
 * Whether a decoded payload is a request to fill rather than a completed response.
 * @param bundle
 */
export function isRequestBundle(bundle: Bundle): boolean {
  if (findInBundle<Questionnaire>(bundle, "Questionnaire") === undefined) {
    return false;
  }

  /*
   * A request may now legitimately *carry* a QuestionnaireResponse, so the old test - a
   * Questionnaire present and a response absent - would classify a pre-populated invitation as
   * somebody's answers and refuse to open it. What separates the two is the status: a seeded
   * response is `in-progress` and is the starting point for filling the form in, while anything
   * further along is a reply to be reviewed.
   */
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter(
      (resource): resource is QuestionnaireResponse =>
        resource?.resourceType === "QuestionnaireResponse",
    )
    .every((response) => UNANSWERED_STATUSES.has(response.status));
}

/** Statuses a QuestionnaireResponse carries when nobody has finished answering it. */
const UNANSWERED_STATUSES = new Set<QuestionnaireResponse["status"]>([
  "in-progress",
]);

/**
 * The Task's business identifier - the key a requester matches a returned response against.
 * @param task
 */
export function taskCorrelationId(task: Task | undefined): string | undefined {
  return task?.identifier?.find((identifier) => identifier.value)?.value;
}

/**
 * Which form a Task was asking for, as a canonical URL.
 *
 * `input[].valueCanonical` first, because that is the copy built to survive: {@link
 * buildResponseBundle} drops `focus` on the return leg - it would dangle once the Questionnaire is
 * gone from the Bundle - so a returned Task carries the canonical in `input` and nowhere else. The
 * `focus` fallback is for a Task on the outbound leg, or one another producer built. A producer
 * that put a Bundle-relative `urn:uuid` there yields exactly that, which resolves against no
 * server - the honest outcome, and reported as one rather than guessed at.
 * @param task the Task, in either direction, or undefined
 * @returns the canonical, or undefined when the Task names no form
 * @example
 * taskQuestionnaireCanonical(returned); // "http://example.org/Questionnaire/q-715|1.0.0"
 */
export function taskQuestionnaireCanonical(
  task: Task | undefined,
): string | undefined {
  return (
    task?.input?.find((input) => input.valueCanonical)?.valueCanonical ??
    task?.focus?.reference
  );
}

/**
 * The form a Task was asking for, as something to show a person.
 *
 * {@link buildRequestBundle} writes `Complete "<title>"` into `description`, so the title is
 * recovered from it rather than showing the instruction as though it were a form name. Failing
 * that, the canonical's last path segment is a worse name but still a name.
 *
 * `undefined` rather than a placeholder when the Task says nothing, because what to show instead
 * differs by surface: a list row needs a label, and a review screen already has the questionnaire's
 * own title to fall back on.
 * @param task the request Task, in either direction
 * @returns the best label the Task itself supports, or undefined when it supports none
 * @example
 * taskFormLabel({ description: 'Complete "Adult sepsis screening"' }); // "Adult sepsis screening"
 */
export function taskFormLabel(task: Task | undefined): string | undefined {
  const description = task?.description;
  if (description) {
    return /"([^"]+)"/.exec(description)?.[1] ?? description;
  }

  const canonical = taskQuestionnaireCanonical(task);
  if (canonical === undefined) {
    return undefined;
  }

  return canonical.split("|", 1)[0].split("/").findLast(Boolean) ?? canonical;
}

/**
 * Canonical URL with version suffix, matching how QuestionnaireResponse.questionnaire is written.
 *
 * `undefined` for a Questionnaire with no `url` - legal FHIR, and not something callers can fix, so
 * they get to decide whether it matters. {@link canonicalOf} is the variant for callers that cannot
 * proceed without one.
 * @param questionnaire
 */
export function questionnaireCanonicalOf(
  questionnaire: Questionnaire,
): string | undefined {
  if (!questionnaire.url) {
    return undefined;
  }

  return questionnaire.version
    ? `${questionnaire.url}|${questionnaire.version}`
    : questionnaire.url;
}

function canonicalOf(questionnaire: Questionnaire): string {
  const canonical = questionnaireCanonicalOf(questionnaire);
  if (!canonical) {
    throw new Error("Questionnaire has no canonical url.");
  }

  return canonical;
}

export { questionnaireCanonical } from "./codec";

/**
 * The questionnaire a request is *about*, preferring what the Task says over what the form says.
 *
 * The Task's `input` is the request's own statement of which form it is asking for, and it survives
 * a Questionnaire that arrived without a `url` - which happens, because a form assembled from
 * modules need not carry one. Falling back to the Questionnaire keeps an older invitation, minted
 * before the input was written, readable.
 * @param payload the parsed request
 * @returns the questionnaire canonical
 * @example
 * const canonical = canonicalFromRequest(parseRequestBundle(bundle));
 */
export function canonicalFromRequest(payload: RequestPayload): string {
  const fromInput = payload.task.input?.find(
    (input) => input.valueCanonical,
  )?.valueCanonical;
  return fromInput ?? canonicalOf(payload.questionnaire);
}

/**
 * The answers as they should be written into a channel D slot.
 *
 * Three things are stripped and three are added, and each pairing is the same idea: what the filler
 * knows about itself must not travel, and what the *record* will need must.
 *
 * `id` goes because the slot's own id is the address being written to, and
 * `putResponseToSlot` puts it back; `subject` and `author` go because a reference minted on the
 * filler's device names nothing on the requester's server and would be a dangling pointer at best.
 * The subject's *display* is kept when the request named one, because a human collecting the
 * answers needs to know whose they are.
 *
 * The request's identifier is copied on so that the collected answers can be matched back to the
 * request they answer rather than to whichever browser happened to fetch them, and
 * {@link PATIENT_ASSERTED_SECURITY} is added because a record has to be able to tell an assertion
 * from a link-holder apart from a clinician's entry. Neither is something the reviewer should have
 * to add by hand.
 * @param response the completed answers
 * @param options the request Task, when one is known
 * @param options.requestTask the invitation's Task, for the subject display and identifier
 * @returns the resource to `PUT` into the slot
 * @example
 * const body = buildWriteResponse(answers, { requestTask: payload.task });
 */
export function buildWriteResponse(
  response: QuestionnaireResponse,
  options: { requestTask?: Task } = {},
): QuestionnaireResponse {
  const { id: _id, subject: _subject, author: _author, ...rest } = response;

  const subjectDisplay =
    options.requestTask?.for?.display ?? response.subject?.display;
  const requestIdentifier = options.requestTask?.identifier?.[0];

  return {
    ...rest,
    status: "completed",
    ...(subjectDisplay && { subject: { display: subjectDisplay } }),
    ...(requestIdentifier && { identifier: requestIdentifier }),
    meta: {
      ...response.meta,
      security: [
        ...(response.meta?.security ?? []),
        { ...PATIENT_ASSERTED_SECURITY },
      ],
    },
  };
}
