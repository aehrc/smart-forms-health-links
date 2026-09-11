/**
 * The direct return: posting the answers straight into the clinic's system.
 *
 * A filler that holds a well-formed grant can write the answers to the destination itself, in one
 * authorised transaction, instead of minting a link for the requester to scan back. This module is
 * that transaction and the act of sending it - the wire shape is fixed by `contracts/shl-wire.md`,
 * "Submission transaction", because a Platypus build has to produce and consume the same thing.
 *
 * ## Four responsibilities, deliberately separate
 *
 * {@link buildSubmissionTransaction} is pure: answers plus patient in, Bundle out. Every rule the
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
 * {@link readPriorSubmission} is the same Task read as {@link readDestinationTask}, classified
 * the other way round, and it runs when the link is *opened* rather than before a send. It is
 * what makes reopening an invitation whose answers are already stored show the terminal sent
 * state instead of a second empty form.
 *
 * ## The token goes to exactly one origin
 *
 * A bearer token that can write to a clinical record is the most dangerous thing this app ever
 * puts in a browser. `redirect: "manual"` on both requests is what keeps it from travelling: a
 * destination that answers with a redirect has told the browser to present the request somewhere
 * else, and following that would hand the credential to whoever controls the target while
 * reporting the answers as delivered. So a redirect is a failure with no delivery claimed.
 *
 * The Task read used to be the awkward half of that rule, because the invitation names the Task
 * on the practice's server and the token belongs to `aud`. It is no longer a comparison: the
 * address is *built* from `aud` and the only thing taken from the invitation is the Task's `id`
 * ({@link destinationTaskUrl}). There is nothing left that could pass a same-origin check and
 * still be somewhere the token has no business going.
 *
 * ## Optimism about the Task, never about the answers
 *
 * Everything about the Task leg degrades: unaddressable, unreadable, unversioned, or already
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

import {
  completedTask,
  isFinishedTaskStatus,
  RESPONSE_OUTPUT_TYPE,
  taskIfMatch,
} from "@/fhir/taskCompletion";
import {
  destinationHost,
  grantExpiresAt,
  isGrantExpired,
} from "@/link/apiAccess";
import { PATIENT_ASSERTED_SECURITY, taskCorrelationId } from "@/link/exchange";
import { parseServerTaskUrl } from "@/link/replyDescriptor";

/** RFC 3986 URI namespace: the system the invitation's business identifier lives under. */
const URI_IDENTIFIER_SYSTEM = "urn:ietf:rfc:3986";

/*
 * The Task's shape and the rules about writing to it live in `@/fhir/taskCompletion`, shared with
 * the scan-back channel: both routes have to say the same thing about the same Task.
 */

const PROVENANCE_PARTICIPANT_TYPE =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";

const FHIR_JSON = "application/fhir+json";

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
  /**
   * The patient the answers are about, as a bare FHIR id, or undefined when the request named
   * none.
   *
   * The id rather than the grant it usually comes from, because the facade builds this same
   * transaction server-side and has no grant to hand - it holds the invitation row instead. One
   * builder for both callers is the point: the wire shape is decided here, so a rule cannot hold
   * on one path and not the other.
   */
  readonly patient?: string;
  /** The invitation's durable business identifier, e.g. `urn:uuid:…`. */
  readonly requestIdentifier: string;
  /** The patient's name, as the invitation gave it. */
  readonly patientDisplay?: string;
  /** The Task to complete, when one was readable on the destination. */
  readonly task?: DestinationTask;
  /** ISO instant for `Provenance.recorded`; defaults to now. */
  readonly recorded?: string;
}

/**
 * Where a direct send is up to.
 *
 * `checking` is the state while the destination is asked whether the published task already
 * carries a response, which is how a reopened invitation whose answers already landed reaches
 * `sent` without a second send. The send affordance is withheld while checking, and a task that
 * cannot be read resolves to `idle`, so a destination that will not answer never blocks the form.
 */
export type SendState =
  "idle" | "checking" | "expired" | "sending" | "sent" | "refused" | "failed";

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
  /**
   * The host to name in what the filler is told, when it is not the grant's own destination.
   *
   * Defaults to the destination, which is right for a grant that points at a practice. Under the
   * facade the caller passes the practice, so an outcome reads "the clinic accepted the answers"
   * rather than naming the relay that carried them.
   */
  readonly host?: string;
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
 * A FHIR resource id, as the `id` datatype defines it.
 *
 * The grammar permits `.`, so `.` and `..` are both valid ids *and* path traversal. They are
 * refused separately in {@link destinationTaskUrl} rather than by narrowing this pattern, because
 * the pattern is the FHIR rule and the traversal is a URL rule.
 */
const RESOURCE_ID_PATTERN = /^[\w\-.]{1,64}$/;

/** Path segments that would move the address rather than name a resource. */
const TRAVERSAL_SEGMENTS = new Set([".", ".."]);

/**
 * The practice's host, read off the Task the invitation published on it.
 *
 * The invitation is the only thing that still names the practice once `aud` points at the facade,
 * and this is the part of it a person can read. Deliberately *not* a new member on the grant: a
 * grant file is a SMART token response, which is the whole argument for `scope` belonging in it
 * and for a private member of ours not.
 * @param serverTaskUrl the published Task's absolute URL, when the invitation named one
 * @returns the host, or undefined when there is no usable `https` URL to read it from
 * @example
 * practiceHost("https://ehr.example.org/fhir/Task/t-1"); // "ehr.example.org"
 */
function practiceHost(serverTaskUrl: string | undefined): string | undefined {
  if (serverTaskUrl === undefined) {
    return undefined;
  }
  try {
    const url = new URL(serverTaskUrl);
    return url.protocol === "https:" ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where to read the invitation's published Task, given a grant.
 *
 * The invitation names the Task on the *practice's* server, and since the write target became
 * this app's facade that is no longer where the token may be presented. So only the id is taken
 * from what the invitation said, and the address is built from `aud` - which is the grant's own
 * statement about where its token belongs.
 *
 * Derivation rather than comparison is what makes the origin rule structural. There is no longer
 * a URL from the invitation that could pass a check and still be somewhere else; the only thing
 * the invitation contributes is 64 characters of `id`, matched against the FHIR `id` grammar so
 * that a traversal or an absolute URL cannot arrive through it.
 *
 * A grant pointing at a practice's FHIR base rather than a facade - a link minted by a deployment
 * that has not moved yet - resolves to exactly the URL the invitation named, because a Task lives
 * at `{base}/Task/{id}` on any conformant server.
 * @param serverTaskUrl the published Task's absolute URL, as the invitation gave it
 * @param aud the grant's destination
 * @returns the URL to read, or undefined when either half is unusable
 * @example
 * destinationTaskUrl("https://ehr/fhir/Task/t-1", "https://links/shl/inv-1/fhir");
 * // "https://links/shl/inv-1/fhir/Task/t-1"
 */
function destinationTaskUrl(
  serverTaskUrl: string,
  aud: string,
): string | undefined {
  if (httpsOrigin(aud) === undefined) {
    return undefined;
  }
  const id = serverTaskUrl.split("/").pop();
  if (
    id === undefined ||
    !RESOURCE_ID_PATTERN.test(id) ||
    TRAVERSAL_SEGMENTS.has(id)
  ) {
    return undefined;
  }
  return `${aud.replace(/\/+$/, "")}/Task/${id}`;
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
 * @param options the answers, the patient, the request identifier and the Task read
 * @returns the transaction Bundle
 * @throws {Error} when the answers do not name the questionnaire they were given against
 * @example
 * const bundle = buildSubmissionTransaction({ response, patient, requestIdentifier });
 */
export function buildSubmissionTransaction(
  options: SubmissionTransactionOptions,
): Bundle {
  const {
    response,
    patient: patientId,
    requestIdentifier,
    patientDisplay,
    task,
    recorded,
  } = options;

  const canonical = response.questionnaire;
  if (canonical === undefined || canonical.trim() === "") {
    throw new Error(
      "These answers do not name the questionnaire they were given against, so the " +
        "destination could not tell which form they answer.",
    );
  }

  const patient: Reference | undefined =
    patientId === undefined
      ? undefined
      : {
          reference: `Patient/${patientId}`,
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
  // `subject` is the named patient or nothing: whatever the filler's own store said is not it.
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
     * about - the shape the scan-back channel writes too, so a completed request reads the same
     * whichever route brought the answers.
     */
    entry.push({
      resource: completedTask(task.resource, responseFullUrl),
      request: { method: "PUT", url: task.url, ifMatch: task.ifMatch },
    });
  }

  return { resourceType: "Bundle", type: "transaction", entry };
}

/** The published Task as the destination answered for it, before any rule is applied. */
interface FetchedTask {
  /** The Task exactly as the destination holds it. */
  readonly task: Task;
  /** The `ETag` header the destination answered with, when it sent one. */
  readonly etag: string | null;
}

/**
 * `GET` the invitation's published Task from the destination, presenting the grant's token.
 *
 * The single place the token is presented to anything other than the transaction endpoint, and
 * therefore the single place the origin rule has to hold for a read: a published Task URL that is
 * not on the grant's own origin is not fetched at all, not even to see whether it would have
 * worked. Everything that could go wrong afterwards - a refusal, a redirect, a body that is not a
 * Task - is undefined, because no caller here has anything to gain from the difference.
 * @param options the grant and the published Task URL the invitation named
 * @param options.grant the grant whose token authorises the read
 * @param options.serverTaskUrl the published Task's absolute URL
 * @returns the Task and the version the destination stated, or undefined when there is no Task to
 *   be had from that URL
 */
async function fetchPublishedTask(options: {
  readonly grant: ApiAccessGrant;
  readonly serverTaskUrl: string;
}): Promise<FetchedTask | undefined> {
  const { grant, serverTaskUrl } = options;

  const target = destinationTaskUrl(serverTaskUrl, grant.aud);
  if (target === undefined) {
    return undefined;
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${grant.access_token}`,
        Accept: FHIR_JSON,
      },
      redirect: "manual",
      /*
       * Never from the cache, and never *revalidated* against it. This URL is read twice in one
       * page - once when the link is opened, once immediately before the send - and Aidbox
       * answers a conditional `GET` with a 500 while still sending a strong `ETag`, so a cached
       * first read makes the second one a revalidation the destination cannot answer. The
       * consequence would be silent and expensive: the pre-send read fails, the Task entry is
       * dropped, and the request never reads as completed. A token-authorised read of clinical
       * state has no business in a browser cache regardless.
       */
      cache: "no-store",
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

  return { task, etag: response.headers.get("ETag") };
}

/**
 * Read the invitation's published Task from the destination, immediately before the send.
 *
 * Every path out of here that is not a live, versioned, unfinished Task at the grant's own
 * destination returns undefined, and undefined means "send the answers without a Task entry".
 * Nothing about the Task is worth failing a send over.
 * @param options the grant and the published Task URL the invitation named
 * @param options.grant
 * @param options.serverTaskUrl
 * @returns the Task, or undefined when there is none this send may complete
 * @example
 * const task = await readDestinationTask({ grant, serverTaskUrl });
 */
export async function readDestinationTask(options: {
  readonly grant: ApiAccessGrant;
  readonly serverTaskUrl: string;
}): Promise<DestinationTask | undefined> {
  const fetched = await fetchPublishedTask(options);
  if (fetched === undefined) {
    return undefined;
  }

  const { task, etag } = fetched;
  if (isFinishedTaskStatus(task.status)) {
    return undefined;
  }

  // No stated version means no conditional `PUT`, and an unconditional one is the blind overwrite
  // FR-022 forbids ({@link taskIfMatch}).
  const ifMatch = taskIfMatch(task, etag);
  if (ifMatch === undefined) {
    return undefined;
  }

  return { url: `Task/${task.id ?? ""}`, resource: task, ifMatch };
}

/**
 * Whether the destination already holds this invitation's answers.
 *
 * The spec's edge case - "the same invitation opened after the response was already sent: the
 * filler shows the terminal sent state, not a fresh form" - needs an answer at open time, and the
 * published Task is the only thing a filler can ask. So this is the same read
 * {@link readDestinationTask} makes, classified the other way round: instead of "may this send
 * complete the Task", it asks "has a send already completed it".
 *
 * ## Why `completed` alone is not the evidence
 *
 * Because the clinic can produce it. The enumerated edge case "the published request task was
 * cancelled or completed by the clinic before the send" describes precisely that: a finished Task
 * with nothing ever sent. Status alone cannot tell the two apart, and getting it wrong that way
 * would hide the form from someone who has typed nothing.
 *
 * The `questionnaire-response` output is what separates them. This app's submission transaction
 * completes the Task *and* names the response it stored, in one entry
 * ({@link buildSubmissionTransaction}); the requester's scan-back acceptance does the same thing
 * with its own session. A clinic closing a request off in its own system leaves no such
 * reference. So the output is evidence that answers for this request reached the record - which
 * is the fact the surface needs, whichever channel put them there - and its absence means they
 * did not.
 *
 * A Task finished any other way is never a prior submission. `cancelled`, `rejected`, `failed`
 * and `entered-in-error` are states no send produces, so a Task in one of them is the clinic's
 * decision about the request rather than a delivery of answers, and FR-022 already says a send
 * leaves that decision alone.
 *
 * ## Unknown means "offer the send"
 *
 * Every failure returns false. The destination has been observed answering this read with a 500,
 * and withholding a send because a status read did not work would cost a patient their answers
 * over a nicety. A closed window is the one case that issues nothing at all: FR-025 forbids a
 * request from an expired grant, and that includes this one.
 * @param options the grant with the moment it arrived, the published Task URL, and the clock
 * @param options.received the grant, with the moment it arrived
 * @param options.serverTaskUrl the published Task's absolute URL
 * @param options.now epoch milliseconds to judge the window against; defaults to the current time
 * @returns true only on positive evidence that the answers are already stored
 * @example
 * const already = await readPriorSubmission({ received, serverTaskUrl });
 */
export async function readPriorSubmission(options: {
  readonly received: ReceivedGrant;
  readonly serverTaskUrl: string;
  readonly now?: number;
}): Promise<boolean> {
  const { received, serverTaskUrl } = options;

  if (isGrantExpired(received, options.now ?? Date.now())) {
    return false;
  }

  const fetched = await fetchPublishedTask({
    grant: received.grant,
    serverTaskUrl,
  });
  if (fetched === undefined || fetched.task.status !== "completed") {
    return false;
  }

  /*
   * The reference has to be there, not merely the slot: an output with the right type and no
   * value names nothing, and reading it as a stored response would claim one that does not exist.
   */
  return (fetched.task.output ?? []).some(
    (output) =>
      output.type?.text === RESPONSE_OUTPUT_TYPE.text &&
      output.valueReference?.reference !== undefined,
  );
}

/**
 * Whether there is a prior-submission check worth making for this invitation.
 *
 * Three things have to be true before the read is worth the moment it costs: there is a channel
 * at all, the invitation named a published Task to ask about, and the grant's window is still
 * open. When they are not, the surface goes straight to whatever state it belongs in rather than
 * sitting through a "checking" it will learn nothing from.
 * @param target what the invitation offers by way of a direct send, if anything
 * @param now epoch milliseconds to judge the window against; defaults to the current time
 * @returns true when {@link readPriorSubmission} could return an answer
 * @example
 * const [prior] = useState(() => (checksPriorSubmission(target) ? "checking" : "unknown"));
 */
export function checksPriorSubmission(
  target: DirectSendTarget | undefined,
  now = Date.now(),
): boolean {
  if (target?.serverTaskUrl === undefined) {
    return false;
  }

  return (
    destinationTaskUrl(target.serverTaskUrl, target.received.grant.aud) !==
      undefined && !isGrantExpired(target.received, now)
  );
}

/**
 * How long until the grant's stated window closes.
 *
 * Measured from the moment the grant arrived, which is the only clock a filler has any authority
 * over. Nothing here compares against a timestamp the token endpoint or the resource server
 * chose, so a backend running an hour fast changes none of it (spec edge case: clock skew).
 * @param received the grant and the moment it was received
 * @param now epoch milliseconds; defaults to the current time
 * @returns milliseconds remaining, or undefined when the grant stated no window or it has closed
 * @example
 * const delay = msUntilWindowCloses(received);
 * if (delay !== undefined) setTimeout(close, delay);
 */
export function msUntilWindowCloses(
  received: ReceivedGrant,
  now = Date.now(),
): number | undefined {
  const closesAt = grantExpiresAt(received);
  if (closesAt === undefined || closesAt <= now) {
    return undefined;
  }

  return closesAt - now;
}

/** What the current state of a send is derived from. */
export interface SendStatusOptions {
  /** The grant, with the moment it was received. */
  readonly received: ReceivedGrant;
  /** The state of the last attempt, when there has been one. */
  readonly attempted?: SendStatus;
  /** Epoch milliseconds to judge the window against; defaults to the current time. */
  readonly now?: number;
  /** The host to name, as {@link DirectSendOptions.host}. */
  readonly host?: string;
}

/**
 * States the clock may still close.
 *
 * The ones where nothing has yet happened *at the destination* - an untouched grant, a retry left
 * by a failed attempt, and a prior-submission check still in flight. All three are surfaces a
 * request could still be issued from, and FR-025 forbids that once the window has closed.
 * Everything else has an outcome of its own to report.
 */
const UNSTARTED_STATES: Partial<Record<SendState, true>> = {
  idle: true,
  failed: true,
  checking: true,
};

/**
 * The state a send is in right now, given what has been attempted and where the window is up to.
 *
 * Two rules, and the second is the one that is easy to get wrong. The clock may **close** a
 * channel that is still being offered - see {@link UNSTARTED_STATES} - because a request from a
 * closed window is precisely what FR-025 forbids. The clock may never **rewrite an outcome**: a
 * send the destination accepted stays accepted, and a refusal stays the more useful of the two
 * explanations. Answers already in someone's record are not un-written by a token expiring
 * afterwards, and saying "the window has closed" over a completed send would read as though
 * nothing had happened.
 * @param options the grant, the last attempt if any, and the moment to judge against
 * @returns the state to present
 * @example
 * const status = currentSendStatus({ received: target.received, attempted, now });
 */
export function currentSendStatus(options: SendStatusOptions): SendStatus {
  const { received, attempted } = options;
  const now = options.now ?? Date.now();

  if (attempted !== undefined && !UNSTARTED_STATES[attempted.state]) {
    return attempted;
  }

  if (!isGrantExpired(received, now)) {
    return attempted ?? { state: "idle" };
  }

  return {
    state: "expired",
    detail:
      "The window for sending answers straight to " +
      `${options.host ?? destinationHost(received.grant)} has closed.`,
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
 * Whether this state makes the scan-back return the primary way back.
 *
 * True for the two states that shut the direct channel with nothing delivered: an expired window
 * and a refused credential. Both are permanent for this invitation, and both leave a completed
 * set of answers on the device with exactly one way home, so that way stops being the alternative
 * and becomes the instruction (FR-025, FR-028).
 *
 * False for a retryable failure, deliberately. Its primary action is the retry, and pointing
 * someone at a QR code because a network blipped would be worse advice than saying nothing.
 * @param status where the send is up to
 * @returns true when the fallback should be presented as the primary action
 * @example
 * <FillFromRequest scanBackPromoted={promotesScanBack(status)} … />
 */
export function promotesScanBack(status: SendStatus): boolean {
  return status.state === "expired" || status.state === "refused";
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
  const host = options.host ?? destinationHost(grant);

  /*
   * Before anything else, and before anything is built. The send is reachable from a state that
   * was derived a moment ago, and a window can close in that moment - so this is the check that
   * makes "no request from an expired grant" true rather than likely (FR-025).
   */
  if (isGrantExpired(received, now)) {
    return currentSendStatus({ received, now });
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
    ...(grant.patient === undefined ? {} : { patient: grant.patient }),
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
  /**
   * The practice's host, for everything the filler is told.
   *
   * Sourced from the published Task the invitation names, not from `aud`. Since the write target
   * became this app's facade, `aud` is *our* host, and telling a patient their answers go to a
   * party they have never heard of is the outcome FR-020 exists to prevent. A grant pointing
   * straight at a practice - a link minted before the facade - names the same host either way.
   */
  readonly host: string;
  /**
   * The host the answers pass *through*, when that is not the practice itself.
   *
   * Present only when the grant's destination differs from the practice, which is exactly when
   * there is an intermediary to disclose. Undefined means the answers go straight there and
   * there is nothing extra to say.
   */
  readonly relayHost?: string;
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
 * @param options.task
 * @param options.apiAccess
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

  const serverTaskUrl = parseServerTaskUrl(task);
  const relayHost = destinationHost(apiAccess.grant);
  const host = practiceHost(serverTaskUrl) ?? relayHost;

  return {
    received: apiAccess,
    host,
    ...(host === relayHost ? {} : { relayHost }),
    requestIdentifier,
    serverTaskUrl,
    patientDisplay: task.for?.display,
  };
}
