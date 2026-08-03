import type { Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';

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
 * *"the base URL for the server(s) to which questionnaire response associated with this questionnaire
 * should be submitted. If multiple repetitions are present, the completed form should be sent to all
 * listed endpoints."*
 *
 * smart-forms lists this extension as unsupported in its Conformance statement, so honouring it here
 * is new ground rather than a reimplementation.
 */
export const SDC_QUESTIONNAIRE_ENDPOINT =
  'http://hl7.org/fhir/StructureDefinition/sdc-questionnaire-endpoint';

const FHIR_JSON = 'application/fhir+json';

/** Endpoints declared by the Questionnaire itself, if any. */
export function declaredEndpoints(questionnaire: Questionnaire | undefined): string[] {
  return (questionnaire?.extension ?? [])
    .filter((extension) => extension.url === SDC_QUESTIONNAIRE_ENDPOINT)
    .map((extension) => extension.valueUri)
    .filter((url): url is string => typeof url === 'string' && url !== '');
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
export function resolveDestinations(options: ResolveDestinationsOptions): string[] {
  const declared = declaredEndpoints(options.questionnaire);
  if (declared.length > 0) {
    return declared;
  }

  return options.responseServerUrl ? [options.responseServerUrl] : [];
}

export const NO_DESTINATION_MESSAGE =
  'No destination is configured for completed responses. Set `responseServerUrl` in config.json, ' +
  'or give the Questionnaire an sdc-questionnaire-endpoint extension. It deliberately does not ' +
  'default to the forms server, which is a read-only catalogue.';

export interface SubmitResult {
  serverUrl: string;
  /** Server-assigned id of the created QuestionnaireResponse. */
  responseId?: string;
  /** Server-assigned id of the created Task, when one was submitted. */
  taskId?: string;
  error?: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Strip identity a foreign server assigned.
 *
 * A response arriving from another app may carry an `id` and `meta` from *its* server. Those mean
 * nothing here, and keeping them risks colliding with, or overwriting, an unrelated local resource.
 * Creating a fresh resource is the only safe interpretation of "accept these answers".
 */
function asNewResource<T extends { id?: string; meta?: unknown }>(resource: T): T {
  const { id: _id, meta: _meta, ...rest } = resource;
  return rest as T;
}

interface OperationOutcome {
  resourceType: 'OperationOutcome';
  issue?: { severity?: string; code?: string; diagnostics?: string }[];
}

/**
 * Pull the human-readable reason out of a FHIR error response.
 *
 * Worth the effort: a rejected write is usually rejected for a reason the reviewer can act on — a
 * subject that does not resolve on this server, say — and `400 Bad Request` alone tells them
 * nothing.
 */
async function describeFailure(response: Response): Promise<string> {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;

  try {
    const body = (await response.json()) as OperationOutcome;
    const diagnostics = (body.issue ?? [])
      .map((issue) => issue.diagnostics)
      .filter((text): text is string => !!text);

    if (diagnostics.length > 0) {
      return `${status}: ${diagnostics.join('; ')}`;
    }
  } catch {
    // Not every error response carries an OperationOutcome.
  }

  return status;
}

async function createResource(
  serverUrl: string,
  resource: QuestionnaireResponse | Task
): Promise<string> {
  const response = await fetch(`${trimTrailingSlash(serverUrl)}/${resource.resourceType}`, {
    method: 'POST',
    headers: { 'Content-Type': FHIR_JSON, Accept: FHIR_JSON },
    body: JSON.stringify(resource)
  });

  if (!response.ok) {
    throw new Error(
      `Could not save the ${resource.resourceType} — ${await describeFailure(response)}`
    );
  }

  const created = (await response.json()) as { id?: string; resourceType?: string };
  if (created.resourceType === 'OperationOutcome' || !created.id) {
    throw new Error(`The server rejected the ${resource.resourceType}.`);
  }

  return created.id;
}

export interface SubmitOptions {
  response: QuestionnaireResponse;
  /** Round-tripped from the request; its `output` is rewired to the real response id. */
  task?: Task;
  questionnaire?: Questionnaire;
  responseServerUrl?: string | null;
}

/**
 * Submit a reviewed response, plus its correlating Task.
 *
 * Order matters: the QuestionnaireResponse is created first so the Task's `output` can reference its
 * real server id rather than the `urn:uuid` that was only meaningful inside the transported Bundle.
 *
 * A Task failure does not fail the submission. The clinical content is the response; losing the
 * correlation record is a reporting problem, not a data-loss one, and re-submitting the response to
 * fix it would duplicate it.
 */
export async function submitResponse(options: SubmitOptions): Promise<SubmitResult[]> {
  const destinations = resolveDestinations(options);

  if (destinations.length === 0) {
    throw new Error(NO_DESTINATION_MESSAGE);
  }

  return Promise.all(
    destinations.map(async (serverUrl): Promise<SubmitResult> => {
      try {
        const responseId = await createResource(serverUrl, asNewResource(options.response));

        let taskId: string | undefined;
        if (options.task) {
          try {
            const task = asNewResource<Task>({
              ...options.task,
              output: [
                {
                  type: { text: 'questionnaire-response' },
                  valueReference: { reference: `QuestionnaireResponse/${responseId}` }
                }
              ]
            });
            taskId = await createResource(serverUrl, task);
          } catch (cause) {
            console.warn(`Saved the response but could not save its Task to ${serverUrl}`, cause);
          }
        }

        return { serverUrl, responseId, taskId };
      } catch (cause) {
        return {
          serverUrl,
          error: cause instanceof Error ? cause.message : String(cause)
        };
      }
    })
  );
}
