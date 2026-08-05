import type {
  Bundle,
  Extension,
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task
} from 'fhir/r4';
import { collectionBundle, findInBundle, questionnaireCanonical } from './codec';
import {
  buildReplyDescriptorExtension,
  buildServerTaskUrlExtension,
  type ReplyDescriptor
} from './replyDescriptor';

/**
 * The two payloads that travel between a requester and a form filler.
 *
 * **Request**  `Bundle{Questionnaire, Task}` — "please fill this in"
 * **Response** `Bundle{QuestionnaireResponse, Task}` — "here are the answers"
 *
 * ## Why the Task, and why it points the way it does
 *
 * R4 gives QuestionnaireResponse no way to reference a Task: `basedOn` accepts only
 * `CarePlan|ServiceRequest`, `partOf` only `Observation|Procedure`, and `identifier` is `0..1`.
 * Correlation therefore has to run from the Task outward — `Task.focus` at the Questionnaire and
 * `Task.output.valueReference` at the QuestionnaireResponse — with the Task itself round-tripping
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
const QUESTIONNAIRE_INPUT_TYPE = { text: 'questionnaire' } as const;
const RESPONSE_OUTPUT_TYPE = { text: 'questionnaire-response' } as const;

/** RFC 3986 URI namespace, the conventional system for a UUID-based business identifier. */
const URI_IDENTIFIER_SYSTEM = 'urn:ietf:rfc:3986';

/**
 * "This content was asserted by the patient, not by a clinician."
 *
 * From US Core's Writing Clinical Notes guidance, and the same coding Platypus stamps on a reply
 * (`apps/mobile/lib/write-engine/attribution.ts`). It is the single most important thing on a
 * third-party response: without it, answers typed by a patient on their own phone are
 * indistinguishable in the record from answers recorded by a clinician.
 */
export const PATIENT_ASSERTED_SECURITY = {
  system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue',
  code: 'PATAST',
  display: 'patient asserted'
} as const;

const PROVENANCE_PARTICIPANT_TYPE =
  'http://terminology.hl7.org/CodeSystem/provenance-participant-type';

export interface RequestPayload {
  questionnaire: Questionnaire;
  task: Task;
}

export interface ResponsePayload {
  response: QuestionnaireResponse;
  /** Absent when the filler dropped it, which is legal but loses correlation. */
  task?: Task;
  /**
   * Who asserted the answers, when the filler said.
   *
   * Present on encrypted-channel replies and absent from a plain link. It is attribution rather than
   * clinical content, so nothing depends on it — but it must be written when it is there, because it is
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
   * Carried separately because a filler generally cannot resolve `subjectReference` — it references a
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
 */
export function buildRequestBundle(
  questionnaire: Questionnaire,
  options: BuildRequestOptions = {}
): { bundle: Bundle; task: Task } {
  const questionnaireUuid = `urn:uuid:${newUuid()}`;
  const requestId = options.requestId ?? newUuid();

  const task: Task = {
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    identifier: [{ system: URI_IDENTIFIER_SYSTEM, value: `urn:uuid:${requestId}` }],
    authoredOn: options.authoredOn ?? new Date().toISOString(),
    description: `Complete "${questionnaire.title ?? questionnaire.name ?? 'questionnaire'}"`,
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
          type: 'Questionnaire',
          display: questionnaire.title ?? questionnaire.name
        }
      : { reference: questionnaireUuid, display: questionnaire.title ?? questionnaire.name },
    /*
     * The canonical is duplicated into `input` deliberately, and stays duplicated even now that
     * `focus` carries it: `focus` is dropped on the return leg (it would dangle once the Questionnaire
     * is gone), so `input` is what survives to record which form was answered.
     */
    input: questionnaire.url
      ? [{ type: QUESTIONNAIRE_INPUT_TYPE, valueCanonical: canonicalOf(questionnaire) }]
      : undefined
  };

  if (options.requesterDisplay) {
    task.requester = { display: options.requesterDisplay };
  }

  if (options.subjectReference || options.subjectDisplay) {
    task.for = {
      ...(options.subjectReference ? { reference: options.subjectReference } : {}),
      ...(options.subjectDisplay ? { display: options.subjectDisplay } : {})
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

  const bundle = collectionBundle([
    { fullUrl: questionnaireUuid, resource: questionnaire },
    { fullUrl: `urn:uuid:${newUuid()}`, resource: task }
  ]);

  return { bundle, task };
}

export function parseRequestBundle(bundle: Bundle): RequestPayload {
  const questionnaire = findInBundle<Questionnaire>(bundle, 'Questionnaire');
  if (!questionnaire) {
    throw new Error(
      'This link does not contain a Questionnaire, so there is no form to fill in. ' +
        'It may be a completed response rather than a request.'
    );
  }

  const task = findInBundle<Task>(bundle, 'Task');
  if (!task) {
    throw new Error('This request is missing its Task, so the answers could not be matched back.');
  }

  return { questionnaire, task };
}

/**
 * Build the "here are the answers" payload.
 *
 * The Questionnaire is intentionally *not* included — the requester already has it, and re-sending
 * hundreds of kilobytes would push the payload past what a QR code can carry on the return leg.
 */
export function buildResponseBundle(
  response: QuestionnaireResponse,
  requestTask?: Task
): { bundle: Bundle; task?: Task } {
  const responseUuid = `urn:uuid:${newUuid()}`;

  if (!requestTask) {
    return { bundle: collectionBundle([{ fullUrl: responseUuid, resource: response }]) };
  }

  const task: Task = {
    ...requestTask,
    status: 'completed',
    lastModified: new Date().toISOString(),
    /*
     * `focus` named the Questionnaire in the request Bundle. That entry is gone here, so the canonical
     * in `input` carries the same information without a reference to a resource the payload no longer
     * contains.
     */
    focus: undefined,
    /*
     * The request's extensions are the *requester's* return-channel instructions — a reply slot URL,
     * and possibly a token authorising a write to it. Echoing them back serves no purpose and would
     * copy a capability into whatever transport the answers travel on, including an unencrypted QR.
     */
    extension: undefined,
    output: [{ type: RESPONSE_OUTPUT_TYPE, valueReference: { reference: responseUuid } }]
  };

  return {
    bundle: collectionBundle([
      { fullUrl: responseUuid, resource: response },
      { fullUrl: `urn:uuid:${newUuid()}`, resource: task }
    ]),
    task
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
 * Returns `undefined` when neither knows — the caller decides whether that is fatal, because it is
 * not always: answers can still be reviewed as a raw table without their form definition.
 */
export function responseCanonical(
  response: QuestionnaireResponse,
  fallback?: string
): string | undefined {
  return response.questionnaire ?? fallback;
}

export function parseResponseBundle(bundle: Bundle): ResponsePayload {
  const response = findInBundle<QuestionnaireResponse>(bundle, 'QuestionnaireResponse');
  if (!response) {
    throw new Error(
      'This link does not contain a QuestionnaireResponse, so there are no answers to review.'
    );
  }

  return {
    response,
    task: findInBundle<Task>(bundle, 'Task'),
    provenance: findInBundle<Provenance>(bundle, 'Provenance')
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
 */
export function buildReplyBundle(
  response: QuestionnaireResponse,
  options: BuildReplyOptions = {}
): { bundle: Bundle; provenance?: Provenance } {
  const { id: _id, ...withoutLocalId } = response;

  const attributed: QuestionnaireResponse = {
    ...withoutLocalId,
    status: 'completed',
    meta: {
      ...response.meta,
      security: [...(response.meta?.security ?? []), { ...PATIENT_ASSERTED_SECURITY }]
    }
  };

  const { bundle } = buildResponseBundle(attributed, options.requestTask);
  // `buildResponseBundle` always puts the response first, and its `fullUrl` is what a Provenance has
  // to target — the response has no server id yet.
  const responseUuid = bundle.entry?.[0]?.fullUrl;

  const patientReference =
    options.patientReference ?? response.author?.reference ?? response.subject?.reference;

  if (!patientReference || !responseUuid) {
    // `Provenance.agent.who` is 1..1, so there is no valid Provenance to write without someone to
    // name. The security label already records that the content is patient-asserted.
    return { bundle };
  }

  const provenance: Provenance = {
    resourceType: 'Provenance',
    target: [{ reference: responseUuid }],
    recorded: options.recorded ?? new Date().toISOString(),
    agent: [
      {
        type: {
          coding: [{ system: PROVENANCE_PARTICIPANT_TYPE, code: 'author', display: 'Author' }]
        },
        who: { reference: patientReference }
      }
    ]
  };

  return {
    bundle: collectionBundle([
      ...(bundle.entry ?? []).map((entry) => ({
        fullUrl: entry.fullUrl,
        resource: entry.resource!
      })),
      { fullUrl: `urn:uuid:${newUuid()}`, resource: provenance }
    ]),
    provenance
  };
}

/** Whether a decoded payload is a request to fill rather than a completed response. */
export function isRequestBundle(bundle: Bundle): boolean {
  return (
    findInBundle<Questionnaire>(bundle, 'Questionnaire') !== undefined &&
    findInBundle<QuestionnaireResponse>(bundle, 'QuestionnaireResponse') === undefined
  );
}

/** The Task's business identifier — the key a requester matches a returned response against. */
export function taskCorrelationId(task: Task | undefined): string | undefined {
  return task?.identifier?.find((identifier) => identifier.value)?.value;
}

/**
 * Canonical URL with version suffix, matching how QuestionnaireResponse.questionnaire is written.
 *
 * `undefined` for a Questionnaire with no `url` — legal FHIR, and not something callers can fix, so
 * they get to decide whether it matters. {@link canonicalOf} is the variant for callers that cannot
 * proceed without one.
 */
export function questionnaireCanonicalOf(questionnaire: Questionnaire): string | undefined {
  if (!questionnaire.url) {
    return undefined;
  }

  return questionnaire.version ? `${questionnaire.url}|${questionnaire.version}` : questionnaire.url;
}

function canonicalOf(questionnaire: Questionnaire): string {
  const canonical = questionnaireCanonicalOf(questionnaire);
  if (!canonical) {
    throw new Error('Questionnaire has no canonical url.');
  }

  return canonical;
}

/**
 * The canonical the filler should record on the response, preferring what the Task carried so the
 * request and the response agree even if the filler resolved the form some other way.
 */
export function canonicalFromRequest(payload: RequestPayload): string {
  const fromInput = payload.task.input?.find((input) => input.valueCanonical)?.valueCanonical;
  return fromInput ?? canonicalOf(payload.questionnaire);
}

export { questionnaireCanonical };
