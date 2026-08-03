import type { Bundle, Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { collectionBundle, findInBundle, questionnaireCanonical } from './codec';

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

export interface RequestPayload {
  questionnaire: Questionnaire;
  task: Task;
}

export interface ResponsePayload {
  response: QuestionnaireResponse;
  /** Absent when the filler dropped it, which is legal but loses correlation. */
  task?: Task;
}

export interface BuildRequestOptions {
  /** Who the form is for, e.g. `Patient/123`. */
  subjectReference?: string;
  /** Correlation key. Generated when omitted. */
  requestId?: string;
  /** ISO instant; defaults to now. */
  authoredOn?: string;
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
    focus: {
      reference: questionnaireUuid,
      display: questionnaire.title ?? questionnaire.name
    },
    /*
     * The canonical is duplicated into `input` deliberately. `focus` is a urn:uuid that only resolves
     * inside this Bundle, so once the filler drops the Questionnaire from the return payload the
     * canonical in `input` is the only surviving record of which form was answered.
     */
    input: questionnaire.url
      ? [{ type: QUESTIONNAIRE_INPUT_TYPE, valueCanonical: canonicalOf(questionnaire) }]
      : undefined
  };

  if (options.subjectReference) {
    task.for = { reference: options.subjectReference };
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
     * `focus` pointed at the Questionnaire's urn:uuid in the request Bundle. That entry is gone here,
     * so leaving it would be a dangling reference. The canonical in `input` carries the same
     * information without lying about resolvability.
     */
    focus: undefined,
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

export function parseResponseBundle(bundle: Bundle): ResponsePayload {
  const response = findInBundle<QuestionnaireResponse>(bundle, 'QuestionnaireResponse');
  if (!response) {
    throw new Error(
      'This link does not contain a QuestionnaireResponse, so there are no answers to review.'
    );
  }

  return { response, task: findInBundle<Task>(bundle, 'Task') };
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

/** Canonical URL with version suffix, matching how QuestionnaireResponse.questionnaire is written. */
function canonicalOf(questionnaire: Questionnaire): string {
  if (!questionnaire.url) {
    throw new Error('Questionnaire has no canonical url.');
  }

  return questionnaire.version ? `${questionnaire.url}|${questionnaire.version}` : questionnaire.url;
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
