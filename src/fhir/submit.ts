import type {
  Meta,
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

import {
  classifyProxyResponse,
  isSessionEnded,
  sessionEndedError,
} from "@/lib/session";

/**
 * Write a reviewed QuestionnaireResponse to the requester's own FHIR server.
 *
 * This is the step that makes the whole design stay within spec. SMART Health Links define no
 * submission channel, so nothing is ever *pushed* to us — a filler publishes, this app pulls,
 * a human reviews, and only then does this run. The write is an ordinary FHIR `create` performed by
 * the requester against its own server, which is precisely SDC's Form Receiver model.
 *
 * Destination resolution, in order:
 *   1. `sdc-questionnaire-endpoint` on the Questionnaire — the standard, form-authored answer
 *   2. `responseServerUrl` from config
 *
 * There is no third step. `formsServerUrl` is a read-only catalogue and is never a write target.
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
  responseServerUrl?: string | null;
}

/**
 * Work out where the response should go. Empty means "not configured".
 *
 * Returns every declared endpoint when the Questionnaire names them, because the SDC extension says
 * the response goes to all of them, not just the first.
 *
 * There is deliberately **no fallback to the forms server**. That server is a read-only catalogue:
 * smart-forms only ever reads Questionnaires from it and writes responses to its SMART launch server
 * instead. Defaulting here would quietly push patient data into a shared reference library, so an
 * unset destination is an error the user sees rather than a guess.
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
  "No destination is configured for completed responses. Set `responseServerUrl` in config.json, " +
  "or give the Questionnaire an sdc-questionnaire-endpoint extension. It deliberately does not " +
  "default to the forms server, which is a read-only catalogue.";

export interface SubmitResult {
  serverUrl: string;
  /** Server-assigned id of the created QuestionnaireResponse. */
  responseId?: string;
  /** Server-assigned id of the created Task, when one was submitted. */
  taskId?: string;
  /** Server-assigned id of the created Provenance, when one accompanied the response. */
  provenanceId?: string;
  error?: string;
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
function describeFailure(response: Response, body: unknown): string {
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
  resource: QuestionnaireResponse | Task | Provenance,
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
        `Could not save the ${resource.resourceType} - ${describeFailure(response, body)}`,
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
  /** Round-tripped from the request; its `output` is rewired to the real response id. */
  task?: Task;
  /** Who asserted the answers, when the filler said. Its `target` is rewired like the Task's. */
  provenance?: Provenance;
  questionnaire?: Questionnaire;
  responseServerUrl?: string | null;
}

/**
 * Submit a reviewed response, plus its correlating Task and any attribution that came with it.
 *
 * Order matters: the QuestionnaireResponse is created first so the Task's `output` and the
 * Provenance's `target` can reference its real server id rather than the `urn:uuid` that was only
 * meaningful inside the transported Bundle.
 *
 * Neither companion resource failing fails the submission. The clinical content is the response;
 * losing the correlation or attribution record is a reporting problem, not a data-loss one, and
 * re-submitting the response to fix it would duplicate it. They are reported rather than swallowed so
 * the gap is visible.
 *
 * A lost session is the one failure that is not reported as a per-destination error but raised.
 * Nothing was written and nothing will be until there is a session again, so the caller has to be
 * able to offer a re-launch rather than paint a red box beside the answers - and that decision is
 * made on the error's kind, which a `SubmitResult.error` string would have thrown away.
 * @param options the answers, their companions, and where to write them
 * @returns one result per destination
 * @throws {SessionEndedError} when the session behind the proxy has gone
 * @throws {Error} when no destination is configured
 * @example
 * const results = await submitResponse({ response, responseServerUrl: FHIR_PROXY_BASE });
 */
export async function submitResponse(
  options: SubmitOptions,
): Promise<SubmitResult[]> {
  const destinations = resolveDestinations(options);

  if (destinations.length === 0) {
    throw new Error(NO_DESTINATION_MESSAGE);
  }

  return Promise.all(
    destinations.map(async (serverUrl): Promise<SubmitResult> => {
      try {
        const responseId = await createResource(
          serverUrl,
          asNewResource(options.response),
        );
        const responseReference = `QuestionnaireResponse/${responseId}`;

        let taskId: string | undefined;
        if (options.task) {
          try {
            const task = asNewResource<Task>({
              ...options.task,
              output: [
                {
                  type: { text: "questionnaire-response" },
                  valueReference: { reference: responseReference },
                },
              ],
            });
            taskId = await createResource(serverUrl, task);
          } catch (error) {
            console.warn(
              `Saved the response but could not save its Task to ${serverUrl}`,
              error,
            );
          }
        }

        let provenanceId: string | undefined;
        if (options.provenance) {
          try {
            const provenance = asNewResource<Provenance>({
              ...options.provenance,
              // Targeted the response's `urn:uuid` inside the Bundle; that entry is gone, so point it
              // at what was actually created.
              target: [{ reference: responseReference }],
            });
            provenanceId = await createResource(serverUrl, provenance);
          } catch (error) {
            console.warn(
              `Saved the response but could not save its Provenance to ${serverUrl}`,
              error,
            );
          }
        }

        return { serverUrl, responseId, taskId, provenanceId };
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
}

/**
 * Whether a reference resolves on the server the response is about to be written to.
 *
 * Worth checking before offering to save. A response from a third-party filler names a patient in
 * that* app's terms — Platypus sends its own vault key — and a server enforcing referential integrity
 * rejects the whole write with `HAPI-1094`. Finding that out before the reviewer clicks Accept turns a
 * confusing failure into a question they can answer.
 *
 * `true` on any non-404: a server that does not enforce integrity, or that refuses the probe, is not
 * evidence of a missing subject, and blocking the write on that would be worse than attempting it.
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
 * Add `sdc-questionnaire-endpoint` to a copy of a Questionnaire — the outbound half of channel B.
 *
 * This is the SDC-standard way to say "send answers here", and the same extension
 * {@link declaredEndpoints} already honours on the way back in. Using it rather than inventing a field
 * means any SDC-aware filler already knows where to look.
 *
 * Only ever applied to the embedded copy inside a request payload. The catalogue Questionnaire on the
 * forms server is never modified — that server is read-only.
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
