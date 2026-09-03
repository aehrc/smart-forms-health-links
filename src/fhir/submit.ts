import type { Amendment } from "@/fhir/amend";
import type {
  Meta,
  Patient,
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

import { buildPatient, type NewPatientDetails } from "@/fhir/newPatient";
import {
  completedTask,
  isFinishedTaskStatus,
  taskIfMatch,
} from "@/fhir/taskCompletion";
import {
  classifyProxyResponse,
  isSessionEnded,
  sessionEndedError,
} from "@/lib/session";
import { parseServerTaskUrl } from "@/link/replyDescriptor";

/**
 * Write a reviewed QuestionnaireResponse to the requester's own FHIR server.
 *
 * This is the step that makes the whole design stay within spec. SMART Health Links define no
 * submission channel, so nothing is ever *pushed* to us - a filler publishes, this app pulls,
 * a human reviews, and only then does this run. The write is an ordinary FHIR `create` performed by
 * the requester against its own server, which is precisely SDC's Form Receiver model.
 *
 * Destination resolution, in order:
 *   1. `sdc-questionnaire-endpoint` on the Questionnaire - the standard, form-authored answer
 *   2. the server the requester launched from, reached through the BFF proxy
 *
 * There is no third step, and no configuration in either: a destination is either declared by the
 * form or it is the clinical system the reviewer is signed in to. It used to come from a
 * `responseServerUrl` key in `config.json`, chosen alongside a separate read-only forms catalogue
 * that was deliberately never a write target. Both are gone. There is one server now, and the
 * session decides which one it is (FR-004).
 * @author John Grimes
 */

/**
 * "Where to send answers", from the SDC IG:
 * "the base URL for the server(s) to which questionnaire response associated with this questionnaire
 * should be submitted. If multiple repetitions are present, the completed form should be sent to all
 * listed endpoints."*
 *
 * smart-forms lists this extension as unsupported in its Conformance statement, so honouring it here
 * is new ground rather than a reimplementation.
 */
export const SDC_QUESTIONNAIRE_ENDPOINT =
  "http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint";

const FHIR_JSON = "application/fhir+json";

/**
 * Endpoints declared by the Questionnaire itself, if any.
 * @param questionnaire
 */
export function declaredEndpoints(
  questionnaire: Questionnaire | undefined,
): string[] {
  return (questionnaire?.extension ?? [])
    .filter((extension) => extension.url === SDC_QUESTIONNAIRE_ENDPOINT)
    .map((extension) => extension.valueUri)
    .filter((url): url is string => typeof url === "string" && url !== "");
}

export interface ResolveDestinationsOptions {
  questionnaire?: Questionnaire;
  /**
   * Base URL to write to when the form declares no endpoint of its own.
   *
   * Still named for the configuration key it used to come from, because that is what it still
   * means to a caller: "the server that receives responses". Every caller in the app now passes
   * `FHIR_PROXY_BASE`, so the value is the launched server rather than anything a browser could be
   * pointed at.
   */
  responseServerUrl?: string | null;
}

/**
 * Work out where the response should go. Empty means the caller nominated nowhere.
 *
 * Returns every declared endpoint when the Questionnaire names them, because the SDC extension says
 * the response goes to all of them, not just the first.
 *
 * A form-declared endpoint outranks the launched server deliberately: the form's author has said
 * where its answers belong, and that instruction travels with the form to whoever fills it. The
 * launched server is the fallback, and there is no fallback after it - guessing a destination would
 * mean pushing patient data at a server nobody nominated.
 * @param options
 */
export function resolveDestinations(
  options: ResolveDestinationsOptions,
): string[] {
  const declared = declaredEndpoints(options.questionnaire);
  if (declared.length > 0) {
    return declared;
  }

  return options.responseServerUrl ? [options.responseServerUrl] : [];
}

export const NO_DESTINATION_MESSAGE =
  "There is nowhere to write these answers. The Questionnaire declares no " +
  "sdc-questionnaire-endpoint extension, and no launched server was supplied to fall back on. " +
  "Re-launching from the clinical system supplies one.";

/** The launched server the reviewer is signed in to, as `GET /api/session` describes it. */
export interface LaunchedServer {
  /** Its FHIR base URL. */
  readonly issuer: string;
  /** Its human-readable name, from the deployment's registry. */
  readonly label: string;
}

/** What happened to the request's own Task on the launched server. */
export interface PublishedTaskOutcome {
  /**
   * Which of the four things happened.
   *
   * `completed` - the published Task was read and moved to `completed`, with these answers as its
   * output, so `/requests` now shows the request as answered.
   * `skipped` - there was no Task on the launched server for these answers to complete, which is
   * the ordinary case for a link this deployment did not mint. Not a failure.
   * `unchanged` - the Task exists but the clinic has already decided it. Left exactly as it was.
   * `failed` - the completion was attempted and refused. The answers are still stored.
   */
  readonly kind: "completed" | "skipped" | "unchanged" | "failed";
  /** What happened, in words a reviewer can act on. Always populated. */
  readonly detail: string;
  /** Id of the Task that was completed, when one was. */
  readonly taskId?: string;
}

export interface SubmitResult {
  serverUrl: string;
  /** Server-assigned id of the created QuestionnaireResponse. */
  responseId?: string;
  /** Server-assigned id of the created Provenance, when one accompanied the response. */
  provenanceId?: string;
  /**
   * Why the Provenance failed, when the response itself landed.
   *
   * Separate from {@link error} because the outcomes differ: `error` means the answers are not
   * saved, this means they are saved but unattributed. Collapsing the two would either hide a lost
   * attribution or claim a lost response.
   */
  provenanceError?: string;
  /** Server-assigned id of the request Task, when this write completed one. */
  taskId?: string;
  error?: string;
}

/** Everything an acceptance did: the answers written, and what became of the request. */
export interface SubmitOutcome {
  /** One result per destination the answers were written to. */
  readonly results: SubmitResult[];
  /**
   * What became of the request Task on the launched server.
   *
   * One outcome rather than one per destination, because there is one Task: it lives on the server
   * the reviewer launched from, whatever the answers' destinations turn out to be.
   */
  readonly task: PublishedTaskOutcome;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Strip identity a foreign server assigned, and **only** that.
 *
 * A response arriving from another app carries an `id` and version metadata from *its* server. Those
 * mean nothing here, and keeping them risks colliding with, or overwriting, an unrelated local
 * resource. Creating a fresh resource is the only safe interpretation of "accept these answers".
 *
 * What must survive is the rest of `meta`. This used to drop `meta` wholesale, which was wrong in a
 * way that only shows up with third-party fillers: `meta.security` is where a patient-asserted
 * (`PATAST`) label lives, and discarding it files answers a patient typed on their own phone as though
 * a clinician had recorded them. `profile` and `tag` are likewise the sender's claims about the
 * content, not the sender's server's bookkeeping.
 * @param resource
 */
function asNewResource<T extends { id?: string; meta?: Meta }>(resource: T): T {
  const rest = { ...resource };
  delete rest.id;
  delete rest.meta;

  const { meta } = resource;
  if (!meta) {
    return rest;
  }

  const keptMeta = { ...meta };
  delete keptMeta.versionId;
  delete keptMeta.lastUpdated;
  delete keptMeta.source;

  return Object.keys(keptMeta).length > 0 ? { ...rest, meta: keptMeta } : rest;
}

interface OperationOutcome {
  resourceType: "OperationOutcome";
  issue?: { severity?: string; code?: string; diagnostics?: string }[];
}

/**
 * Pull the human-readable reason out of a FHIR error response.
 *
 * Worth the effort: a rejected write is usually rejected for a reason the reviewer can act on - a
 * subject that does not resolve on this server, say - and `400 Bad Request` alone tells them
 * nothing.
 * @param response the refused response, for its status
 * @param body its parsed body, or undefined when it had none this app could read
 * @returns the status, with any diagnostics the server supplied appended
 */
function describeOutcome(response: Response, body: unknown): string {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const outcome = body as OperationOutcome | undefined;
  const diagnostics = (outcome?.issue ?? [])
    .map((issue) => issue.diagnostics)
    .filter((text): text is string => !!text);

  return diagnostics.length > 0
    ? `${status}: ${diagnostics.join("; ")}`
    : status;
}

/**
 * Create one resource on the destination, distinguishing a lost session from a refused write.
 *
 * Every requester write goes through the BFF proxy, which holds the session's authority, and a
 * session can die between opening a set of answers and accepting them - a review is a person
 * reading, and people take as long as they take. So the proxy's own `401` is separated from
 * everything else and raised as a session-ended error, which is what turns the surface into a
 * re-launch prompt rather than a FHIR error nobody can act on. An upstream `401` or `403` the
 * proxy passed through verbatim is *not* that: the session is intact and the launched server is
 * refusing the write, which signing in again would not change.
 * @param serverUrl the destination base, normally {@link FHIR_PROXY_BASE}
 * @param resource the resource to create
 * @returns the server-assigned id
 * @throws {SessionEndedError} when the session behind the proxy has gone
 * @throws {Error} when the destination refused the write, or accepted it without an id
 */
async function createResource(
  serverUrl: string,
  resource: QuestionnaireResponse | Provenance | Patient,
): Promise<string> {
  const response = await fetch(
    `${trimTrailingSlash(serverUrl)}/${resource.resourceType}`,
    {
      method: "POST",
      headers: { "Content-Type": FHIR_JSON, Accept: FHIR_JSON },
      body: JSON.stringify(resource),
    },
  );

  /*
   * Read once: the body is both the diagnosis of a failure and the evidence of a lost session.
   * A response with no JSON body at all is not exceptional - a bare 401 from a proxy has none.
   */
  const body: unknown = await response.json().catch(() => {
    return;
  });

  switch (classifyProxyResponse(response.status, body)) {
    case "session-ended": {
      throw sessionEndedError(
        `The session has ended, so the ${resource.resourceType} was not saved.`,
      );
    }
    case "failed": {
      throw new Error(
        `Could not save the ${resource.resourceType} - ${describeOutcome(response, body)}`,
      );
    }
    case "ok": {
      break;
    }
  }

  const created = body as { id?: string; resourceType?: string } | undefined;
  if (created?.resourceType === "OperationOutcome" || !created?.id) {
    throw new Error(`The server rejected the ${resource.resourceType}.`);
  }

  return created.id;
}

export interface SubmitOptions {
  response: QuestionnaireResponse;
  /**
   * The Task that came back with the answers.
   *
   * Read, never copied. Its `invitation-server-task-url` extension is the address of the
   * request's own* Task on the launched server, and completing that one is what closes the
   * request on `/requests`. Creating a second Task here would leave the published one waiting
   * for answers forever, which is exactly the bug FR-011 describes.
   */
  task?: Task;
  /** Who asserted the answers, when the filler said. Its `target` is rewired to the real id. */
  provenance?: Provenance;
  questionnaire?: Questionnaire;
  /** Fallback destination when the form declares none. See {@link ResolveDestinationsOptions}. */
  responseServerUrl?: string | null;
  /**
   * The server the reviewer launched from, when there is a session.
   *
   * The requester's own session authority is what completes the request Task - this is the
   * fallback channel, so there is no grant involved: the clinician has scanned the link and
   * pressed accept. Absent it, the Task leg is skipped and said to be skipped.
   */
  launchedServer?: LaunchedServer | null;
}

/**
 * A Task path within a FHIR base: the only suffix this app will address through the proxy.
 *
 * Narrow on purpose. The URL comes off a link that anybody may have produced, and the proxy
 * presents the session's authority to whatever it is given, so "somewhere inside the launched
 * server's FHIR base" is not a tight enough constraint to spend that authority on.
 */
const TASK_PATH = /^Task\/[\w.-]{1,64}$/;

/**
 * What to call the launched server when telling the reviewer what happened to their request.
 * @param launched the server, as the session describes it
 * @returns its registry label, or its host when the deployment gave it no label
 */
function serverName(launched: LaunchedServer): string {
  if (launched.label.trim() !== "") {
    return launched.label;
  }

  try {
    return new URL(launched.issuer).host;
  } catch {
    return launched.issuer;
  }
}

/**
 * The Task's path relative to the launched server's FHIR base, when it is inside it.
 *
 * Containment within the base rather than a bare origin comparison, because the path is about to
 * be sent through the proxy, which resolves suffixes against exactly that base and refuses
 * anything outside it. Requiring the same thing here means a URL that passes is a URL the proxy
 * will accept, and a URL that fails is reported to the reviewer rather than turned into a 400.
 * @param serverTaskUrl the absolute URL the returned Task named
 * @param issuer the launched server's FHIR base
 * @returns the suffix, e.g. `Task/t-1`, or undefined when the URL is not a Task inside that base
 * @example
 * taskPathOnLaunchedServer("https://ehr.test/fhir/Task/t-1", "https://ehr.test/fhir"); // "Task/t-1"
 */
function taskPathOnLaunchedServer(
  serverTaskUrl: string,
  issuer: string,
): string | undefined {
  const base = `${trimTrailingSlash(issuer)}/`;
  if (!serverTaskUrl.startsWith(base)) {
    return undefined;
  }

  const suffix = serverTaskUrl.slice(base.length);
  return TASK_PATH.test(suffix) ? suffix : undefined;
}

/** Either a Task this acceptance may complete, or the reason it is completing none. */
type TaskPlan =
  | {
      readonly kind: "complete";
      readonly taskPath: string;
      readonly launchedServer: LaunchedServer;
    }
  | { readonly kind: "skip"; readonly outcome: PublishedTaskOutcome };

/**
 * Decide whether these answers name a request Task this session may complete.
 *
 * Every "no" is an ordinary outcome rather than a failure. A link this deployment did not mint
 * names no Task, or names one on somebody else's server, and the answers are still worth storing -
 * the reviewer is simply told that no request was closed.
 * @param options the submission, for its Task and its session
 * @returns the Task to complete, or the outcome to report instead
 */
function planTaskCompletion(options: SubmitOptions): TaskPlan {
  if (!options.task) {
    return {
      kind: "skip",
      outcome: {
        kind: "skipped",
        detail:
          "No request Task came back with these answers, so there was no request to mark " +
          "completed.",
      },
    };
  }

  const serverTaskUrl = parseServerTaskUrl(options.task);
  if (serverTaskUrl === undefined) {
    return {
      kind: "skip",
      outcome: {
        kind: "skipped",
        detail:
          "These answers name no request on any server, so no request was marked completed. " +
          "That is normal for a link this deployment did not mint.",
      },
    };
  }

  const launchedServer = options.launchedServer ?? undefined;
  if (launchedServer === undefined) {
    return {
      kind: "skip",
      outcome: {
        kind: "skipped",
        detail:
          `These answers name a request at ${serverTaskUrl}, but this session has no launched ` +
          "server to reach it through, so no request was marked completed.",
      },
    };
  }

  const taskPath = taskPathOnLaunchedServer(
    serverTaskUrl,
    launchedServer.issuer,
  );
  if (taskPath === undefined) {
    return {
      kind: "skip",
      outcome: {
        kind: "skipped",
        detail:
          `The request these answers came back for is at ${serverTaskUrl}, which is not on ` +
          `${serverName(launchedServer)}, so no request was marked completed there.`,
      },
    };
  }

  return { kind: "complete", taskPath, launchedServer };
}

/**
 * Complete the request's published Task: read it, then `PUT` the version just read.
 *
 * Conditional on that version, and never over a Task the clinic has already decided (FR-022).
 * Both are the same rule the direct send follows, and the write is the same shape, so a request
 * answered by link and a request answered by direct send leave the same trace.
 *
 * No outcome here is thrown, including a lost session: the answers are already stored by the time
 * this runs, so a re-launch prompt would replace a report of a successful write with a login
 * screen. Everything that can go wrong is reported as what it is.
 * @param options the proxy base, the server, the Task's path and the answers to point at
 * @param options.proxyBase the session proxy's FHIR base
 * @param options.launchedServer the server the reviewer launched from
 * @param options.taskPath the Task's path within that server's FHIR base
 * @param options.responseReference reference to the answers as they were stored
 * @returns what happened to the Task
 */
async function completeRequestTask(options: {
  readonly proxyBase: string;
  readonly launchedServer: LaunchedServer;
  readonly taskPath: string;
  readonly responseReference: string;
}): Promise<PublishedTaskOutcome> {
  const { proxyBase, launchedServer, taskPath, responseReference } = options;
  const name = serverName(launchedServer);
  const base = trimTrailingSlash(proxyBase);

  /*
   * `no-store`, because the `If-Match` below is derived from *this* read. Left to the browser's
   * HTTP cache, a second visit to the same Task URL becomes a revalidation, and then the body in
   * hand describes a version the server may have moved past - which turns a conditional update
   * into a guess. Aidbox makes it worse than stale: it answers any conditional GET with a 500
   * while still sending an ETag and `Cache-Control: no-cache`, so the read fails outright.
   */
  let read: Response;
  try {
    read = await fetch(`${base}/${taskPath}`, {
      headers: { Accept: FHIR_JSON },
      cache: "no-store",
    });
  } catch {
    return {
      kind: "failed",
      detail: `${name} could not be reached, so the request there was left as it is.`,
    };
  }

  const readBody: unknown = await read.json().catch(() => {
    return;
  });
  const readOutcome = classifyProxyResponse(read.status, readBody);
  if (readOutcome === "session-ended") {
    return {
      kind: "failed",
      detail:
        "The session ended before the request could be marked completed, so it was left as it " +
        "is. The answers are stored.",
    };
  }
  if (readOutcome === "failed") {
    return {
      kind: "failed",
      detail:
        `The request could not be read on ${name} - ${describeOutcome(read, readBody)} - so it ` +
        "was left as it is.",
    };
  }

  const task = readBody as Task | undefined;
  if (task?.resourceType !== "Task" || typeof task.id !== "string") {
    return {
      kind: "failed",
      detail: `${name} returned no Task at ${taskPath}, so no request was marked completed.`,
    };
  }

  if (isFinishedTaskStatus(task.status)) {
    return {
      kind: "unchanged",
      taskId: task.id,
      detail:
        `The request on ${name} is already ${task.status}, so it was left exactly as it is - ` +
        "these answers did not change it.",
    };
  }

  const ifMatch = taskIfMatch(task, read.headers.get("ETag"));
  if (ifMatch === undefined) {
    return {
      kind: "failed",
      detail:
        `${name} did not say which version of the request it returned, so the request was left ` +
        "as it is rather than overwritten blindly.",
    };
  }

  let written: Response;
  try {
    written = await fetch(`${base}/Task/${task.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": FHIR_JSON,
        Accept: FHIR_JSON,
        "If-Match": ifMatch,
      },
      body: JSON.stringify(completedTask(task, responseReference)),
    });
  } catch {
    return {
      kind: "failed",
      detail: `${name} could not be reached, so the request there was left as it is.`,
    };
  }

  /*
   * The conditional lost. Somebody else changed the Task between the read and the write, and
   * whatever they did is more recent than this decision - so the honest report is that nothing
   * here changed it.
   */
  if (written.status === 409 || written.status === 412) {
    return {
      kind: "unchanged",
      taskId: task.id,
      detail:
        `The request on ${name} changed while these answers were being reviewed, so it was left ` +
        "as it is. Check its state there.",
    };
  }

  const writtenBody: unknown = await written.json().catch(() => {
    return;
  });
  if (classifyProxyResponse(written.status, writtenBody) !== "ok") {
    return {
      kind: "failed",
      detail:
        `The request on ${name} could not be marked completed - ` +
        `${describeOutcome(written, writtenBody)}. The answers are stored.`,
    };
  }

  return {
    kind: "completed",
    taskId: task.id,
    detail: `The request on ${name} is now marked completed, with these answers as its output.`,
  };
}

/**
 * Close the request these answers came back for, or say why none was closed.
 *
 * Runs after the response writes, because the Task's `output` has to name the answers by the id
 * the server actually assigned. Only the copy written to the launched server will do: a response
 * that went to an endpoint the form declared is not addressable from a Task on the launched
 * server, and pointing at it would leave a dangling reference where a completion should be.
 * @param options the submission
 * @param results what the response writes produced
 * @returns what happened to the request Task
 */
async function settleRequestTask(
  options: SubmitOptions,
  results: SubmitResult[],
): Promise<PublishedTaskOutcome> {
  const plan = planTaskCompletion(options);
  if (plan.kind === "skip") {
    return plan.outcome;
  }

  const name = serverName(plan.launchedServer);
  const proxyBase = options.responseServerUrl ?? undefined;
  const written =
    proxyBase === undefined
      ? undefined
      : results.find((result) => result.serverUrl === proxyBase);

  if (proxyBase === undefined || written === undefined) {
    return {
      kind: "skipped",
      detail:
        `These answers went to the endpoint this form declares rather than to ${name}, so the ` +
        `request on ${name} was left as it is.`,
    };
  }
  if (written.responseId === undefined) {
    return {
      kind: "skipped",
      detail: `The answers were not saved to ${name}, so the request there was left as it is.`,
    };
  }

  return completeRequestTask({
    proxyBase,
    launchedServer: plan.launchedServer,
    taskPath: plan.taskPath,
    responseReference: `QuestionnaireResponse/${written.responseId}`,
  });
}

/**
 * Submit a reviewed response, its attribution, and the completion of the request it answers.
 *
 * Order matters: the QuestionnaireResponse is created first so the Provenance's `target` and the
 * request Task's `output` can reference its real server id rather than the `urn:uuid` that was
 * only meaningful inside the transported Bundle.
 *
 * Neither the attribution nor the completion failing fails the submission. The clinical content is
 * the response; losing the attribution record or leaving the request open is a reporting problem,
 * not a data-loss one, and re-submitting the response to fix it would duplicate it. Both are
 * reported rather than swallowed so the gap is visible to the person who accepted the answers.
 *
 * A lost session during the *response* write is the one failure that is not reported but raised.
 * Nothing was written and nothing will be until there is a session again, so the caller has to be
 * able to offer a re-launch rather than paint a red box beside the answers - and that decision is
 * made on the error's kind, which a `SubmitResult.error` string would have thrown away.
 * @param options the answers, their companions, where to write them and which server this is
 * @returns one result per destination, plus what became of the request Task
 * @throws {SessionEndedError} when the session behind the proxy has gone
 * @throws {Error} when no destination is configured
 * @example
 * const outcome = await submitResponse({
 *   response,
 *   task,
 *   responseServerUrl: FHIR_PROXY_BASE,
 *   launchedServer: { issuer: session.issuer, label: session.issuerLabel },
 * });
 */
export async function submitResponse(
  options: SubmitOptions,
): Promise<SubmitOutcome> {
  const destinations = resolveDestinations(options);

  if (destinations.length === 0) {
    throw new Error(NO_DESTINATION_MESSAGE);
  }

  const results = await Promise.all(
    destinations.map(async (serverUrl): Promise<SubmitResult> => {
      try {
        const responseId = await createResource(
          serverUrl,
          asNewResource(options.response),
        );

        let provenanceId: string | undefined;
        if (options.provenance) {
          try {
            const provenance = asNewResource<Provenance>({
              ...options.provenance,
              // Targeted the response's `urn:uuid` inside the Bundle; that entry is gone, so point it
              // at what was actually created.
              target: [{ reference: `QuestionnaireResponse/${responseId}` }],
            });
            provenanceId = await createResource(serverUrl, provenance);
          } catch (error) {
            console.warn(
              `Saved the response but could not save its Provenance to ${serverUrl}`,
              error,
            );
          }
        }

        return { serverUrl, responseId, provenanceId };
      } catch (error) {
        if (isSessionEnded(error)) {
          throw error;
        }

        return {
          serverUrl,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return { results, task: await settleRequestTask(options, results) };
}

/**
 * Whether a reference resolves on the server the response is about to be written to.
 *
 * Worth checking before offering to save. A response from a third-party filler names a patient in
 * that* app's terms (Platypus sends its own vault key) and a server enforcing referential integrity
 * rejects the whole write with `HAPI-1094`. Finding that out before the reviewer clicks Accept turns a
 * confusing failure into a question they can answer.
 *
 * `true` on any non-404: a server that does not enforce integrity, or that refuses the probe, is not
 * evidence of a missing subject, and blocking the write on that would be worse than attempting it.
 * @param serverUrl
 * @param reference
 */
export async function referenceResolves(
  serverUrl: string,
  reference: string,
): Promise<boolean> {
  if (
    /^https?:\/\//i.test(reference) ||
    !/^[A-Za-z]+\/[^/]+$/.test(reference)
  ) {
    // Absolute or contained/logical references are not ours to resolve against this server.
    return true;
  }

  try {
    const response = await fetch(
      `${trimTrailingSlash(serverUrl)}/${reference}`,
      {
        headers: { Accept: FHIR_JSON },
      },
    );
    return response.status !== 404;
  } catch {
    return true;
  }
}

/**
 * Add `sdc-questionnaire-endpoint` to a copy of a Questionnaire - the outbound half of channel B.
 *
 * This is the SDC-standard way to say "send answers here", and the same extension
 * {@link declaredEndpoints} already honours on the way back in. Using it rather than inventing a field
 * means any SDC-aware filler already knows where to look.
 *
 * Only ever applied to the embedded copy inside a request payload. The Questionnaire held by the
 * launched server is never modified: this app reads that catalogue and never writes to it. Nothing
 * in the app calls this now that a manifest carries the grant instead; `check:roundtrip` asserts
 * its shape, because the extension is still the interop-standard way for a third-party producer to
 * tell us where its answers go.
 * @param questionnaire
 * @param endpoint
 */
export function declareResponseEndpoint(
  questionnaire: Questionnaire,
  endpoint: string,
): Questionnaire {
  if (declaredEndpoints(questionnaire).includes(endpoint)) {
    return questionnaire;
  }

  return {
    ...questionnaire,
    extension: [
      ...(questionnaire.extension ?? []),
      { url: SDC_QUESTIONNAIRE_ENDPOINT, valueUri: endpoint },
    ],
  };
}

/**
 * Pull the human-readable reason out of a FHIR error response.
 *
 * Worth the effort: a rejected write is usually rejected for a reason the reviewer can act on - a
 * subject that does not resolve on this server, say - and `400 Bad Request` alone tells them
 * nothing.
 *
 * The async variant, for callers holding a `Response` whose body they have not read. Everything
 * inside this module reads the body once and calls {@link describeOutcome} directly, because there
 * the body is needed twice: to diagnose the failure and to tell a dead session from a live refusal.
 * @param response the failed response
 * @returns the status, plus any diagnostics the server supplied
 * @example
 * throw new Error(`Could not write - ${await describeFailure(response)}`);
 */
export async function describeFailure(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return describeOutcome(response, body);
}

export interface SavedResponse {
  serverUrl: string;
  /** Id the server gave the original. What the amendment's `entity.what` points back at. */
  responseId: string;
}

export interface SubmitAmendmentOptions {
  /**
   * Where the original landed. Only a server that stored it can hold a revision of it, and each
   * one assigned its own id - hence a list of pairs rather than a destination list.
   */
  saved: SavedResponse[];
  /** Builds the amendment against one server's id for the original. */
  amend: (originalResponseId: string) => Amendment;
}

export const NO_AMENDMENT_TARGET_MESSAGE =
  "There is nothing to amend: the original response was not stored on any server, so there is no " +
  "resource for an amendment to revise.";

/**
 * Write an amendment: a second QuestionnaireResponse, plus the Provenance saying what it revises.
 *
 * Deliberately *not* an update of the original. See `src/fhir/amend.ts` for why - the short version
 * is that the original carries claims about who asserted it, and editing it in place would make
 * those claims describe a document that no longer exists.
 *
 * The Provenance is built per destination, because the original's id differs between them. Unlike
 * the inbound path, a failed Provenance is reported rather than shrugged off: there it is
 * attribution accompanying the clinical content, here it is the only link between two otherwise
 * unrelated responses, and a reviewer needs to know they now have an orphan to fix by hand.
 * @param options the saved originals and how to build an amendment for each
 * @returns one result per server the original was stored on
 * @throws {Error} when the original was never stored anywhere
 * @example
 * const results = await submitAmendment({ saved, amend });
 */
export async function submitAmendment(
  options: SubmitAmendmentOptions,
): Promise<SubmitResult[]> {
  if (options.saved.length === 0) {
    throw new Error(NO_AMENDMENT_TARGET_MESSAGE);
  }

  return Promise.all(
    options.saved.map(
      async ({ serverUrl, responseId }): Promise<SubmitResult> => {
        try {
          const { response, provenance } = options.amend(responseId);
          const amendedId = await createResource(
            serverUrl,
            asNewResource(response),
          );

          try {
            const provenanceId = await createResource(
              serverUrl,
              asNewResource<Provenance>({
                ...provenance,
                // Built against a placeholder, because the id did not exist until the line above.
                target: [{ reference: `QuestionnaireResponse/${amendedId}` }],
              }),
            );
            return { serverUrl, responseId: amendedId, provenanceId };
          } catch (error) {
            return {
              serverUrl,
              responseId: amendedId,
              provenanceError:
                error instanceof Error ? error.message : String(error),
            };
          }
        } catch (error) {
          return {
            serverUrl,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
  );
}

export interface CreatedPatient {
  /** Relative, e.g. `Patient/123` - it only means anything against the server it was created on. */
  reference: string;
  /** What was sent, plus the id the server assigned. See below for why this is not a re-read. */
  patient: Patient;
}

/**
 * Create a Patient, so answers about somebody the server has never heard of can still be filed.
 *
 * Two decisions worth knowing about:
 *
 *  - **The empty-family guard is here, not only in the form.** A Patient with no family name cannot
 *    be found again by the very picker that would have to find it, so the primitive refuses rather
 *    than trusting every future caller to validate first.
 *  - **The returned `patient` is what was sent plus the id, not the server's echo.**
 *    `createResource` already reads only `created.id`, and re-reading would spend a round trip on
 *    metadata nothing here uses. Everything the UI needs is in what was sent.
 *
 * Deliberately returns a plain shape rather than the picker's `ChosenPatient`: that type lives in a
 * component, and the FHIR layer does not depend on components.
 * @param serverUrl the FHIR base to create on
 * @param details the name and demographics collected from the form
 * @returns the new patient's reference and the resource as created
 * @throws {Error} when the family name is blank, or the server refuses the write
 * @example
 * const created = await createPatient(ehrServerUrl, details);
 */
export async function createPatient(
  serverUrl: string,
  details: NewPatientDetails,
): Promise<CreatedPatient> {
  if (details.family.trim() === "") {
    throw new Error("A patient cannot be created without a family name.");
  }

  const patient = buildPatient(details);
  const id = await createResource(serverUrl, patient);

  return { reference: `Patient/${id}`, patient: { ...patient, id } };
}
