import type { Meta, Patient, Provenance, Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { buildRequestBundle } from '@/link/exchange';
import type { Amendment } from './amend';
import { buildPatient, type NewPatientDetails } from './newPatient';

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
  /** Server-assigned id of the created Provenance, when one accompanied the response. */
  provenanceId?: string;
  /**
   * The response was written but its Provenance was not.
   *
   * Separate from {@link error}, which means the response itself failed. For an *amendment* this is
   * the serious half: the Provenance is the only thing joining the new resource to the one it
   * revises, so without it the server holds two responses and no record that one supersedes the
   * other.
   */
  provenanceError?: string;
  error?: string;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
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
  const { id: _id, meta, ...rest } = resource;

  if (!meta) {
    return rest as T;
  }

  const { versionId: _versionId, lastUpdated: _lastUpdated, source: _source, ...keptMeta } = meta;

  return (Object.keys(keptMeta).length > 0 ? { ...rest, meta: keptMeta } : rest) as T;
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

/**
 * The union is the point: it enumerates what this app is allowed to bring into existence. Widen it
 * deliberately rather than making it generic.
 */
async function createResource(
  serverUrl: string,
  resource: QuestionnaireResponse | Task | Provenance | Patient
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
        const responseReference = `QuestionnaireResponse/${responseId}`;

        let taskId: string | undefined;
        if (options.task) {
          try {
            const task = asNewResource<Task>({
              ...options.task,
              output: [
                {
                  type: { text: 'questionnaire-response' },
                  valueReference: { reference: responseReference }
                }
              ]
            });
            taskId = await createResource(serverUrl, task);
          } catch (cause) {
            console.warn(`Saved the response but could not save its Task to ${serverUrl}`, cause);
          }
        }

        let provenanceId: string | undefined;
        if (options.provenance) {
          try {
            const provenance = asNewResource<Provenance>({
              ...options.provenance,
              // Targeted the response's `urn:uuid` inside the Bundle; that entry is gone, so point it
              // at what was actually created.
              target: [{ reference: responseReference }]
            });
            provenanceId = await createResource(serverUrl, provenance);
          } catch (cause) {
            console.warn(
              `Saved the response but could not save its Provenance to ${serverUrl}`,
              cause
            );
          }
        }

        return { serverUrl, responseId, taskId, provenanceId };
      } catch (cause) {
        return {
          serverUrl,
          error: cause instanceof Error ? cause.message : String(cause)
        };
      }
    })
  );
}

export interface SavedResponse {
  serverUrl: string;
  /** Id the server gave the original. What the amendment's `entity.what` points back at. */
  responseId: string;
}

export interface SubmitAmendmentOptions {
  /**
   * Where the original landed. Only a server that stored it can hold a revision of it, and each one
   * assigned its own id — hence a list of pairs rather than a destination list.
   */
  saved: SavedResponse[];
  /** Builds the amendment against one server's id for the original. */
  amend: (originalResponseId: string) => Amendment;
}

export const NO_AMENDMENT_TARGET_MESSAGE =
  'There is nothing to amend: the original response was not stored on any server, so there is no ' +
  'resource for an amendment to revise.';

/**
 * Write an amendment: a second QuestionnaireResponse, plus the Provenance saying what it revises.
 *
 * Deliberately *not* an update of the original. See `src/fhir/amend.ts` for why — the short version is
 * that the original carries claims about who asserted it, and editing it in place would make those
 * claims describe a document that no longer exists.
 *
 * The Provenance is built per destination, because the original's id differs between them. Unlike the
 * inbound path, a failed Provenance is reported rather than shrugged off: there it is attribution
 * accompanying the clinical content, here it is the only link between two otherwise unrelated
 * responses, and a reviewer needs to know they now have an orphan to fix by hand.
 */
export async function submitAmendment(options: SubmitAmendmentOptions): Promise<SubmitResult[]> {
  if (options.saved.length === 0) {
    throw new Error(NO_AMENDMENT_TARGET_MESSAGE);
  }

  return Promise.all(
    options.saved.map(async ({ serverUrl, responseId }): Promise<SubmitResult> => {
      try {
        const { response, provenance } = options.amend(responseId);
        const amendedId = await createResource(serverUrl, asNewResource(response));

        try {
          const provenanceId = await createResource(
            serverUrl,
            asNewResource<Provenance>({
              ...provenance,
              // Built against a placeholder, because the id did not exist until the line above.
              target: [{ reference: `QuestionnaireResponse/${amendedId}` }]
            })
          );
          return { serverUrl, responseId: amendedId, provenanceId };
        } catch (cause) {
          return {
            serverUrl,
            responseId: amendedId,
            provenanceError: cause instanceof Error ? cause.message : String(cause)
          };
        }
      } catch (cause) {
        return { serverUrl, error: cause instanceof Error ? cause.message : String(cause) };
      }
    })
  );
}

export interface CreatedPatient {
  /** Relative, e.g. `Patient/123` — it only means anything against the server it was created on. */
  reference: string;
  /** What was sent, plus the id the server assigned. See below for why this is not a re-read. */
  patient: Patient;
}

/**
 * Create a Patient, so answers about somebody the server has never heard of can still be filed.
 *
 * The reference this returns is only valid on `serverUrl`, which is why the caller passes the
 * *destination* server rather than the configured one — a questionnaire declaring its own
 * `sdc-questionnaire-endpoint` sends the write somewhere else entirely.
 *
 * Two decisions worth knowing about:
 *
 *  - **The empty-family guard is here, not only in the form.** A Patient with no family name cannot
 *    be found again by the very picker that would have to find it, so the primitive refuses rather
 *    than trusting every future caller to validate first.
 *  - **The returned `patient` is what was sent plus the id, not the server's echo.** `createResource`
 *    already reads only `created.id`, and re-reading would spend a round trip on metadata nothing
 *    here uses. Everything the UI needs — `patientDisplay`, `describePatient` — is in what was sent.
 *
 * Deliberately returns a plain shape rather than the picker's `ChosenPatient`: that type lives in a
 * component, and the FHIR layer does not depend on components.
 */
export async function createPatient(
  serverUrl: string,
  details: NewPatientDetails
): Promise<CreatedPatient> {
  if (details.family.trim() === '') {
    throw new Error('A patient cannot be created without a family name.');
  }

  const patient = buildPatient(details);
  const id = await createResource(serverUrl, patient);

  return { reference: `Patient/${id}`, patient: { ...patient, id } };
}

/**
 * Whether a reference resolves on the server the response is about to be written to.
 *
 * Worth checking before offering to save. A response from a third-party filler names a patient in
 * *that* app's terms — Platypus sends its own vault key — and a server enforcing referential integrity
 * rejects the whole write with `HAPI-1094`. Finding that out before the reviewer clicks Accept turns a
 * confusing failure into a question they can answer.
 *
 * `true` on any non-404: a server that does not enforce integrity, or that refuses the probe, is not
 * evidence of a missing subject, and blocking the write on that would be worse than attempting it.
 */
export async function referenceResolves(serverUrl: string, reference: string): Promise<boolean> {
  if (/^https?:\/\//i.test(reference) || !/^[A-Za-z]+\/[^/]+$/.test(reference)) {
    // Absolute or contained/logical references are not ours to resolve against this server.
    return true;
  }

  try {
    const response = await fetch(`${trimTrailingSlash(serverUrl)}/${reference}`, {
      headers: { Accept: FHIR_JSON }
    });
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
  endpoint: string
): Questionnaire {
  if (declaredEndpoints(questionnaire).includes(endpoint)) {
    return questionnaire;
  }

  return {
    ...questionnaire,
    extension: [
      ...(questionnaire.extension ?? []),
      { url: SDC_QUESTIONNAIRE_ENDPOINT, valueUri: endpoint }
    ]
  };
}

/**
 * Marks a Task on the EHR as a request this app sent, so sent requests can be listed back.
 *
 * A tag rather than a naming convention because it is searchable: `Task?_tag=…|shl-form-request`
 * returns exactly our requests and nothing else on a server we share with other tools.
 */
export const SHL_REQUEST_TAG = {
  system: 'http://smartforms.csiro.au/CodeSystem/shl-request',
  code: 'shl-form-request',
  display: 'Form request sent as a SMART Health Link'
} as const;

/**
 * Publish a request's Task to the EHR, and return its absolute URL.
 *
 * Two jobs, and they are worth separating in your head: it makes a sent request **discoverable** —
 * `/requests` lists these, so a request is visible even from a browser that did not create it — and,
 * when channel B is enabled, it gives a filler something to write against.
 *
 * Three deliberate differences from the Task inside the invitation:
 *
 *  - **No extensions.** The invitation's copy holds the reply descriptor, including any token
 *    authorising a write to the reply slot. Putting that on a server whose purpose is to be read would
 *    hand the capability to anyone who can read a Task.
 *  - **No `focus`.** The invitation names the Questionnaire by canonical, because that is the only
 *    form of the reference that still means something to a filler once the Bundle is taken apart. FHIR
 *    servers will not store that as a `Reference`:
 *
 *      HAPI-0506: Invalid resource reference found at path[Task.focus] — Resource type is unknown or
 *                 not supported on this server — http://example.org/Q/probe|1.0
 *
 *    So the server copy drops it and relies on `input[].valueCanonical`, which is a `canonical` rather
 *    than a `Reference` and stores fine. This is the same split the return leg already makes.
 *  - **A tracking tag**, so these can be searched back out.
 *
 * `buildRequestBundle` is reused with the same `requestId` so both copies share one business
 * identifier — that identifier is what joins a listed Task to the locally-held reply key.
 */
export async function publishRequestTask(
  serverUrl: string,
  questionnaire: Questionnaire,
  options: { subjectReference?: string; subjectDisplay?: string; requestId?: string } = {}
): Promise<string> {
  const { task } = buildRequestBundle(questionnaire, {
    subjectReference: options.subjectReference,
    subjectDisplay: options.subjectDisplay,
    requestId: options.requestId
  });

  const id = await createResource(serverUrl, asPublishedTask(task));
  return `${trimTrailingSlash(serverUrl)}/Task/${id}`;
}

/** The server-storable form of a request Task. Exported so `check:roundtrip` can assert its shape. */
export function asPublishedTask(task: Task): Task {
  const { focus: _focus, extension: _extension, ...rest } = task;

  return {
    ...rest,
    meta: { ...task.meta, tag: [...(task.meta?.tag ?? []), { ...SHL_REQUEST_TAG }] }
  };
}
