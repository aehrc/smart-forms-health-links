/**
 * The direct return: posting the answers straight into the clinic's system.
 *
 * A filler that holds a well-formed grant can write the answers to the destination itself, in one
 * authorised transaction, instead of minting a link for the requester to scan back. This module is
 * that transaction and the act of sending it - the wire shape is fixed by `contracts/shl-wire.md`,
 * "Submission transaction", because a Platypus build has to produce and consume the same thing.
 *
 * ## Three responsibilities, deliberately separate
 *
 * {@link buildSubmissionTransaction} is pure: answers plus grant in, Bundle out. Every rule the
 * contract states about the shape is decided here and nowhere else, so a rule can be read off a
 * single function rather than reconstructed from a request pipeline.
 *
 * {@link readDestinationTask} is the pre-send read that makes the Task leg honest. `PUT` replaces,
 * so completing a Task requires knowing what it currently says and which version that was. It is
 * also the second place the token is presented, and therefore the second place the origin rule
 * has to be enforced.
 *
 * {@link sendDirect} presents the token and classifies the answer. It owns nothing about the
 * shape and everything about where the credential goes.
 *
 * ## The token goes to exactly one origin
 *
 * A bearer token that can write to a clinical record is the most dangerous thing this app ever
 * puts in a browser. `redirect: "manual"` on both requests is what keeps it from travelling: a
 * destination that answers with a redirect has told the browser to present the request somewhere
 * else, and following that would hand the credential to whoever controls the target while
 * reporting the answers as delivered. So a redirect is a failure with no delivery claimed, and a
 * published Task URL that is not on the grant's own origin is not fetched at all - not even to
 * see whether it would have worked.
 *
 * ## Optimism about the Task, never about the answers
 *
 * Everything about the Task leg degrades: off-origin, unreadable, unversioned, or already
 * finished all mean "no Task entry", and the answers go anyway (FR-022). Losing the status flip
 * costs the requester a tidy list; losing the answers costs a patient the time they spent typing
 * them.
 * @author John Grimes
 */

import type { ApiAccessGrant, ReceivedGrant } from "@/link/apiAccess";
import type {
  Bundle,
  BundleEntry,
  Meta,
  Provenance,
  QuestionnaireResponse,
  Reference,
  Task,
} from "fhir/r4";

import { destinationHost, isGrantExpired } from "@/link/apiAccess";
import { PATIENT_ASSERTED_SECURITY, taskCorrelationId } from "@/link/exchange";
import { parseServerTaskUrl } from "@/link/replyDescriptor";

/** RFC 3986 URI namespace: the system the invitation's business identifier lives under. */
const URI_IDENTIFIER_SYSTEM = "urn:ietf:rfc:3986";

/**
 * `Task.output` slot naming the answers.
 *
 * Restated here rather than imported from `src/link/exchange.ts`, which keeps its copy private.
 * Both are the same three words from the same contract; if one changes, both are wrong.
 */
const RESPONSE_OUTPUT_TYPE = { text: "questionnaire-response" } as const;

const PROVENANCE_PARTICIPANT_TYPE =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";

const FHIR_JSON = "application/fhir+json";

/**
 * Task states a send must leave alone.
 *
 * FR-022: the transaction must not overwrite a Task the clinic has since moved to another state.
 * A Task already completed, cancelled, rejected, failed or marked in error has been decided by
 * someone with more context than a filler has, and a `PUT` would erase that decision.
 */
const FINISHED_TASK_STATUSES: Partial<Record<Task["status"], true>> = {
  completed: true,
  cancelled: true,
  rejected: true,
  failed: true,
  "entered-in-error": true,
};

/** The Task as read from the destination immediately before the send. */
export interface DestinationTask {
  /** Relative URL for the transaction entry, e.g. `Task/task-1`. */
  readonly url: string;
  /** The Task exactly as the destination holds it. */
  readonly resource: Task;
  /** Weak ETag of the version read, for the entry's `ifMatch`. */
  readonly ifMatch: string;
}

/** What the submission transaction is built out of. */
export interface SubmissionTransactionOptions {
  /** The completed answers, as the renderer produced them. */
  readonly response: QuestionnaireResponse;
  /** The grant: the destination, its token, and the patient the answers are about. */
  readonly grant: ApiAccessGrant;
  /** The invitation's durable business identifier, e.g. `urn:uuid:…`. */
  readonly requestIdentifier: string;
  /** The patient's name, as the invitation gave it. */
  readonly patientDisplay?: string;
  /** The Task to complete, when one was readable on the destination. */
  readonly task?: DestinationTask;
  /** ISO instant for `Provenance.recorded`; defaults to now. */
  readonly recorded?: string;
}

/** Where a direct send is up to. See `data-model.md`, "Send states". */
export type SendState =
  "idle" | "expired" | "sending" | "sent" | "refused" | "failed";

/** A send state, with what to say about it. */
export interface SendStatus {
  /** The state. */
  readonly state: SendState;
  /** What happened, in words a filler can act on. */
  readonly detail?: string;
}

/** What a send needs. */
export interface DirectSendOptions {
  /** The completed answers, as the renderer produced them. */
  readonly response: QuestionnaireResponse;
  /** The grant, with the moment it was received. */
  readonly received: ReceivedGrant;
  /** The invitation's durable business identifier. */
  readonly requestIdentifier: string;
  /** The published Task's absolute URL, when the invitation named one. */
  readonly serverTaskUrl?: string;
  /** The patient's name, as the invitation gave it. */
  readonly patientDisplay?: string;
  /** Epoch milliseconds to judge the grant's window against; defaults to now. */
  readonly now?: number;
}

/**
 * The origin of an `https` URL, or nothing.
 * @param value the candidate URL
 * @returns the origin, or undefined when the value is not a syntactically valid `https` URL
 */
function httpsOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a URL is somewhere the grant's token may be presented.
 *
 * Both halves must be `https` origins *and* they must be the same one. Comparing the results of
 * {@link httpsOrigin} without the presence check would make two unusable URLs "the same origin",
 * which is the sort of equality that ends with a token on the wrong host.
 * @param candidate the URL a request is about to be made to
 * @param aud the grant's destination
 * @returns true only when the candidate is on the destination's own `https` origin
 */
function isOnDestinationOrigin(candidate: string, aud: string): boolean {
  const origin = httpsOrigin(candidate);
  return origin !== undefined && origin === httpsOrigin(aud);
}

/**
 * Whether a response is a redirect the request must not follow.
 *
 * A cross-origin redirect under `redirect: "manual"` arrives as an opaque response with status 0,
 * so the status range alone would miss it.
 * @param response the response as it arrived
 * @returns true when the destination asked for the request to be presented elsewhere
 */
function isRedirected(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  );
}

/**
 * Build the transaction a filler posts to the grant's destination.
 *
 * The response is stripped of everything that identifies it on *this* device - its local `id`,
 * its version and store, the `author` and `source` naming whoever is signed in here - and
 * re-identified by the one thing both sides agree on: the invitation's request identifier. That
 * identifier is also the conditional-create key, which is what makes a second send a no-op rather
 * than a duplicate (SC-002).
 *
 * `subject` and the Provenance's author are the grant's patient or nothing at all. The
 * invitation's `Task.for.reference` is a reference on the *requester's* server that a filler
 * never resolved, so echoing it would be asserting a resolution that did not happen.
 * @param options the answers, the grant, the request identifier and the Task read
 * @returns the transaction Bundle
 * @throws {Error} when the answers do not name the questionnaire they were given against
 * @example
 * const bundle = buildSubmissionTransaction({ response, grant, requestIdentifier });
 */
export function buildSubmissionTransaction(
  options: SubmissionTransactionOptions,
): Bundle {
  const { response, grant, requestIdentifier, patientDisplay, task, recorded } =
    options;

  const canonical = response.questionnaire;
  if (canonical === undefined || canonical.trim() === "") {
    throw new Error(
      "These answers do not name the questionnaire they were given against, so the " +
        "destination could not tell which form they answer.",
    );
  }

  const patient: Reference | undefined =
    grant.patient === undefined
      ? undefined
      : {
          reference: `Patient/${grant.patient}`,
          ...(patientDisplay ? { display: patientDisplay } : {}),
        };

  const responseFullUrl = `urn:uuid:${crypto.randomUUID()}`;

  /*
   * Filler-local identity, removed by name.
   *
   * Removal rather than an allow-list on purpose: a member the renderer starts emitting later is
   * content until someone decides otherwise, and the failure mode of the other choice is silently
   * dropping answers.
   */
  const meta: Meta = {
    ...response.meta,
    security: [
      ...(response.meta?.security ?? []),
      { ...PATIENT_ASSERTED_SECURITY },
    ],
  };
  delete meta.versionId;
  delete meta.lastUpdated;
  delete meta.source;

  const submitted: QuestionnaireResponse = {
    ...response,
    status: "completed",
    questionnaire: canonical,
    identifier: { system: URI_IDENTIFIER_SYSTEM, value: requestIdentifier },
    meta,
  };
  delete submitted.id;
  delete submitted.author;
  delete submitted.source;
  // `subject` is the grant's patient or nothing: whatever the filler's own store said is not it.
  delete submitted.subject;
  if (patient) {
    submitted.subject = patient;
  }

  const entry: BundleEntry[] = [
    {
      fullUrl: responseFullUrl,
      resource: submitted,
      request: {
        method: "POST",
        url: "QuestionnaireResponse",
        /*
         * Exact casing, exact query. Aidbox reads this field literally: `ifNoneexist` is not a
         * misspelling that gets corrected, it is an unconditional create, and the second send
         * duplicates the answers in the record.
         */
        ifNoneExist: `identifier=${URI_IDENTIFIER_SYSTEM}|${requestIdentifier}`,
      },
    },
  ];

  /*
   * `Provenance.agent.who` is 1..1. With no patient there is nobody to name as the author, and
   * inventing a filler-local reference is precisely what the contract forbids - so the attribution
   * rests on the PATAST label alone rather than on an invalid Provenance that would fail the whole
   * transaction.
   */
  if (patient) {
    const provenance: Provenance = {
      resourceType: "Provenance",
      target: [{ reference: responseFullUrl }],
      recorded: recorded ?? new Date().toISOString(),
      agent: [
        {
          type: {
            coding: [{ system: PROVENANCE_PARTICIPANT_TYPE, code: "author" }],
          },
          who: patient,
        },
      ],
    };
    entry.push({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: provenance,
      request: { method: "POST", url: "Provenance" },
    });
  }

  if (task) {
    /*
     * The Task goes back as it was read, changed in exactly the two members the completion is
     * about. Sending a minimal Task would erase the requester's own identifier, `for` and
     * `requester` from their Task, which is the opposite of completing it.
     */
    entry.push({
      resource: {
        ...task.resource,
        status: "completed",
        output: [
          ...(task.resource.output ?? []),
          {
            type: RESPONSE_OUTPUT_TYPE,
            valueReference: { reference: responseFullUrl },
          },
        ],
      },
      request: { method: "PUT", url: task.url, ifMatch: task.ifMatch },
    });
  }

  return { resourceType: "Bundle", type: "transaction", entry };
}

/**
 * Read the invitation's published Task from the destination, immediately before the send.
 *
 * Every path out of here that is not a live, versioned, unfinished Task on the grant's own origin
 * returns undefined, and undefined means "send the answers without a Task entry". Nothing about
 * the Task is worth failing a send over.
 * @param options the grant and the published Task URL the invitation named
 * @returns the Task, or undefined when there is none this send may complete
 * @example
 * const task = await readDestinationTask({ grant, serverTaskUrl });
 */
export async function readDestinationTask(options: {
  readonly grant: ApiAccessGrant;
  readonly serverTaskUrl: string;
}): Promise<DestinationTask | undefined> {
  const { grant, serverTaskUrl } = options;

  if (!isOnDestinationOrigin(serverTaskUrl, grant.aud)) {
    return undefined;
  }

  let response: Response;
  try {
    response = await fetch(serverTaskUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${grant.access_token}`,
        Accept: FHIR_JSON,
      },
      redirect: "manual",
    });
  } catch {
    return undefined;
  }

  if (isRedirected(response) || !response.ok) {
    return undefined;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const task = body as Task;
  if (task.resourceType !== "Task" || typeof task.id !== "string") {
    return undefined;
  }
  if (FINISHED_TASK_STATUSES[task.status]) {
    return undefined;
  }

  /*
   * The ETag is the destination's own statement of which version was just read, which is exactly
   * what `If-Match` needs; `meta.versionId` is the same fact from inside the resource. Without
   * either there is no way to make the completion conditional, and an unconditional `PUT` is the
   * blind overwrite FR-022 forbids.
   */
  const etag = response.headers.get("ETag");
  const versionId = task.meta?.versionId;
  const fromResource = versionId === undefined ? undefined : `W/"${versionId}"`;
  const ifMatch = etag?.startsWith("W/") ? etag : fromResource;
  if (ifMatch === undefined) {
    return undefined;
  }

  return { url: `Task/${task.id}`, resource: task, ifMatch };
}

/**
 * The state a freshly received grant starts in.
 * @param received the grant and the moment it was received
 * @param now epoch milliseconds; defaults to the current time
 * @returns `idle`, or `expired` when the grant's stated window has already closed
 * @example
 * const [status, setStatus] = useState(initialSendStatus(received));
 */
export function initialSendStatus(
  received: ReceivedGrant,
  now = Date.now(),
): SendStatus {
  if (!isGrantExpired(received, now)) {
    return { state: "idle" };
  }

  return {
    state: "expired",
    detail:
      `The window for sending answers straight to ${destinationHost(received.grant)} ` +
      "has closed.",
  };
}

/**
 * Whether a send may be started from this state.
 * @param status where the send is up to
 * @returns true only from `idle` and `failed`
 * @example
 * <Button disabled={!canSend(status)} onClick={send} />
 */
export function canSend(status: SendStatus): boolean {
  return status.state === "idle" || status.state === "failed";
}

/**
 * Whether a state closes every other return channel.
 *
 * Only `sent` does. A refusal or a failure leaves the answers on the device with somewhere else
 * to take them; presenting either as the end of the road would strand them.
 * @param status where the send is up to
 * @returns true once the answers have been accepted by the destination
 * @example
 * {suppressesOtherChannels(status) ? null : <FillFromRequest … />}
 */
export function suppressesOtherChannels(status: SendStatus): boolean {
  return status.state === "sent";
}

/**
 * Post the answers to the grant's destination.
 *
 * The classification at the end is the whole point of returning a state rather than throwing.
 * `refused` (401/403) means the credential the link carried will not be honoured, which no retry
 * fixes; `failed` means the answers are still here and trying again is reasonable. Neither is
 * ever worded as a delivery, and `sent` claims only that the destination accepted the
 * transaction - not that anyone has read it (FR-026).
 * @param options the answers, the grant, the request identifier and the published Task URL
 * @returns the terminal-or-retryable state the send ended in
 * @example
 * setStatus(await sendDirect({ response, received, requestIdentifier }));
 */
export async function sendDirect(
  options: DirectSendOptions,
): Promise<SendStatus> {
  const {
    response,
    received,
    requestIdentifier,
    serverTaskUrl,
    patientDisplay,
  } = options;
  const now = options.now ?? Date.now();
  const { grant } = received;
  const host = destinationHost(grant);

  if (isGrantExpired(received, now)) {
    return initialSendStatus(received, now);
  }

  if (httpsOrigin(grant.aud) === undefined) {
    return {
      state: "failed",
      detail:
        `${grant.aud} is not an https address, so nothing was presented to it and the ` +
        "answers have not been sent.",
    };
  }

  const task = serverTaskUrl
    ? await readDestinationTask({ grant, serverTaskUrl })
    : undefined;

  const bundle = buildSubmissionTransaction({
    response,
    grant,
    requestIdentifier,
    patientDisplay,
    task,
  });

  let answer: Response;
  try {
    answer = await fetch(grant.aud, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${grant.access_token}`,
        "Content-Type": FHIR_JSON,
        Accept: FHIR_JSON,
      },
      body: JSON.stringify(bundle),
      redirect: "manual",
    });
  } catch {
    return {
      state: "failed",
      detail:
        `${host} could not be reached. The answers have not been sent, and are still ` +
        "here to try again.",
    };
  }

  if (isRedirected(answer)) {
    return {
      state: "failed",
      detail:
        `${host} asked for the request to be made somewhere else. It was not, so the ` +
        "answers have not been sent.",
    };
  }

  if (answer.status === 401 || answer.status === 403) {
    return {
      state: "refused",
      detail:
        `${host} would not authorise this link to write the answers. Nothing was ` +
        "stored there.",
    };
  }

  if (!answer.ok) {
    const because = answer.statusText
      ? `HTTP ${answer.status} ${answer.statusText}`
      : `HTTP ${answer.status}`;
    return {
      state: "failed",
      detail:
        `${host} did not take the answers (${because}). They have not been sent, and ` +
        "are still here to try again.",
    };
  }

  return { state: "sent", detail: `${host} accepted the answers.` };
}

/** Everything a direct send needs from an opened invitation. */
export interface DirectSendTarget {
  /** The grant, with the moment it was received. */
  readonly received: ReceivedGrant;
  /** The destination's host, for everything the filler is told. */
  readonly host: string;
  /** The invitation's durable business identifier. */
  readonly requestIdentifier: string;
  /** The published Task's absolute URL, when the invitation named one. */
  readonly serverTaskUrl?: string;
  /** The patient's name, as the invitation gave it. */
  readonly patientDisplay?: string;
}

/**
 * What an opened invitation offers by way of a direct send, if anything.
 *
 * Three things have to be true, and the third is easy to overlook. There must be a grant; it must
 * have been readable, which a malformed one was not; and the invitation's Task must carry a
 * business identifier. Without that identifier there is no conditional-create key, so a second
 * send would duplicate the answers in the record rather than being absorbed - and an idempotency
 * guarantee this app cannot make is not one it should offer an affordance for (SC-002).
 *
 * Returning undefined is how "no direct channel" is expressed all the way to the surface: no
 * disclosure, no button, and the scan-back return untouched (FR-020).
 * @param options the invitation's Task and the grant its manifest carried, if any
 * @returns what a send needs, or undefined when there is no direct channel to offer
 * @example
 * const target = directSendTarget({ task, apiAccess: content.apiAccess });
 */
export function directSendTarget(options: {
  readonly task: Task;
  readonly apiAccess?: ReceivedGrant;
}): DirectSendTarget | undefined {
  const { task, apiAccess } = options;
  if (!apiAccess) {
    return undefined;
  }

  const requestIdentifier = taskCorrelationId(task);
  if (!requestIdentifier) {
    return undefined;
  }

  return {
    received: apiAccess,
    host: destinationHost(apiAccess.grant),
    requestIdentifier,
    serverTaskUrl: parseServerTaskUrl(task),
    patientDisplay: task.for?.display,
  };
}
