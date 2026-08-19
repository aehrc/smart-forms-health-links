import type { Bundle, Patient, QuestionnaireResponse, Task } from 'fhir/r4';
import { SHL_REQUEST_TAG } from './submit';

/**
 * Reading the EHR — the server that holds patient data, as distinct from the forms catalogue.
 *
 * Three servers, three jobs, and keeping them straight is most of the point of this file:
 *
 * | `formsServerUrl`    | `smartforms.csiro.au/api/fhir` | Questionnaire **definitions**. Read only. |
 * | `responseServerUrl` | `proxy.smartforms.io/fhir`     | Patients and QuestionnaireResponses — the EHR. |
 * | `blobServerUrl`     | wherever                       | Encrypted payloads and reply slots. |
 *
 * The middle one is what smart-forms calls the *patient data FHIR API* and what `sdc-populate` takes as
 * its `sourceServerUrl`. It is a plain HAPI instance behind `proxy.smartforms.io/fhir`; the sibling
 * `proxy.smartforms.io/v/r4/fhir` is the same data behind a SMART-on-FHIR launcher facade, which is the
 * right base for an app doing SMART App Launch and the wrong one here — this app has no launch context,
 * and the plain base is also the one that reports usable `Location` headers.
 *
 * Everything here is a read. Writes go through `src/fhir/submit.ts`.
 */

const FHIR_JSON = 'application/fhir+json';

/** How many rows a list fetches at once. Enough to be useful, small enough to stay responsive. */
export const DEFAULT_PAGE_SIZE = 50;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * `revalidate` forces an intermediate cache to go back to the origin.
 *
 * Not hypothetical: the default response server sits behind a caching proxy that stores search
 * responses, **including empty ones**. Search for a patient who does not exist, create them, search
 * again with the same URL, and the proxy replays the negative result (`x-cache: HIT`) — so a patient
 * just created appears not to exist. `Cache-Control: no-cache` asks for revalidation rather than a
 * replay, which is the standards-based fix and is honoured here.
 */
async function fetchFhir<T>(
  url: string,
  signal?: AbortSignal,
  options: { revalidate?: boolean } = {}
): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: FHIR_JSON,
      ...(options.revalidate ? { 'Cache-Control': 'no-cache' } : {})
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`FHIR request failed (${response.status} ${response.statusText}): ${url}`);
  }

  return (await response.json()) as T;
}

function bundleResources<T>(bundle: Bundle | undefined): T[] {
  return (bundle?.entry ?? [])
    .map((entry) => entry.resource as T | undefined)
    .filter((resource): resource is T => resource !== undefined);
}

export interface Page<T> {
  resources: T[];
  /**
   * Server-reported match count, when it gave one.
   *
   * `_total=accurate` is a request, not a guarantee — some servers decline it on large result sets, so
   * callers must handle its absence rather than rendering `undefined` as a number.
   */
  total?: number;
}

/** Display name for a Patient, falling back through the ways FHIR allows one to be written. */
export function patientDisplay(patient: Patient | undefined): string {
  const name = patient?.name?.[0];
  if (!name) {
    return patient?.id ? `Patient/${patient.id}` : 'Unnamed patient';
  }

  const joined = [...(name.given ?? []), name.family].filter(Boolean).join(' ');
  return name.text ?? (joined !== '' ? joined : (patient?.id ?? 'Unnamed patient'));
}

/**
 * The Australian national patient identifier, surfaced ahead of any other because it is the one a
 * clinician recognises. Everything else a sandbox server holds is bookkeeping.
 */
const IHI_SYSTEM = 'http://ns.electronichealth.net.au/id/hi/ihi/1.0';

function identifierSummary(patient: Patient): string | undefined {
  const ihi = patient.identifier?.find((identifier) => identifier.system === IHI_SYSTEM)?.value;
  if (ihi) {
    return `IHI ${ihi}`;
  }

  const first = patient.identifier?.find((identifier) => identifier.value)?.value;
  return first ? `id ${first}` : undefined;
}

/**
 * The supporting line under a patient's name — gender, birth date, identifier.
 *
 * Names collide, so picking the right patient from a search is rarely possible on the name alone.
 * Returns an empty string when the server holds none of it, which callers should render as nothing
 * rather than as an empty separator.
 */
export function describePatient(patient: Patient): string {
  return [
    patient.gender,
    patient.birthDate ? `born ${patient.birthDate}` : undefined,
    identifierSummary(patient)
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface SearchResponsesOptions {
  /** Restrict to one patient, e.g. `Patient/pat-sf`. */
  subject?: string;
  /** Restrict to one Questionnaire canonical. Version suffixes are stripped — see below. */
  questionnaire?: string;
  count?: number;
}

/**
 * List QuestionnaireResponses, newest first.
 *
 * `_sort=-_lastUpdated` rather than `-authored`: `authored` is optional and supplied by whichever app
 * wrote the response, so it is missing or wrong often enough that sorting by it silently buries rows.
 * Server metadata is always present.
 */
export async function searchQuestionnaireResponses(
  ehrServerUrl: string,
  options: SearchResponsesOptions = {},
  signal?: AbortSignal
): Promise<Page<QuestionnaireResponse>> {
  const params = new URLSearchParams({
    _count: String(options.count ?? DEFAULT_PAGE_SIZE),
    _sort: '-_lastUpdated',
    _total: 'accurate'
  });

  if (options.subject) {
    params.set('subject', options.subject);
  }

  if (options.questionnaire) {
    /*
     * Searched without the version suffix. The `questionnaire` search parameter matches the reference
     * as stored, so `…/715|0.3.0-assembled` finds only responses that recorded that exact version —
     * which is rarely what someone filtering by form wants, since versions turn over.
     */
    params.set('questionnaire', options.questionnaire.split('|')[0]);
  }

  const bundle = await fetchFhir<Bundle>(
    `${trimTrailingSlash(ehrServerUrl)}/QuestionnaireResponse?${params.toString()}`,
    signal
  );

  return { resources: bundleResources<QuestionnaireResponse>(bundle), total: bundle.total };
}

export async function fetchQuestionnaireResponse(
  ehrServerUrl: string,
  id: string,
  signal?: AbortSignal
): Promise<QuestionnaireResponse> {
  return fetchFhir<QuestionnaireResponse>(
    `${trimTrailingSlash(ehrServerUrl)}/QuestionnaireResponse/${encodeURIComponent(id)}`,
    signal
  );
}

/**
 * Search patients by name, or list them when the search text is empty.
 *
 * Always revalidated. A stale patient list is not a cosmetic problem: it is what makes a patient
 * somebody just created look like one who does not exist, which is precisely the state that leads to
 * a duplicate being created. Correctness beats a cache hit here, and `staleTime` on the query client
 * already keeps this from being chatty.
 */
export async function searchPatients(
  ehrServerUrl: string,
  searchText = '',
  count = DEFAULT_PAGE_SIZE,
  signal?: AbortSignal
): Promise<Page<Patient>> {
  const params = new URLSearchParams({
    _count: String(count),
    _sort: 'family',
    _total: 'accurate'
  });

  if (searchText.trim() !== '') {
    params.set('name', searchText.trim());
  }

  const bundle = await fetchFhir<Bundle>(
    `${trimTrailingSlash(ehrServerUrl)}/Patient?${params.toString()}`,
    signal,
    { revalidate: true }
  );

  return { resources: bundleResources<Patient>(bundle), total: bundle.total };
}

export async function fetchPatient(
  ehrServerUrl: string,
  id: string,
  signal?: AbortSignal
): Promise<Patient> {
  return fetchFhir<Patient>(
    `${trimTrailingSlash(ehrServerUrl)}/Patient/${encodeURIComponent(id)}`,
    signal
  );
}

/**
 * List the request Tasks this app has published — every request sent, from any browser.
 *
 * Found by the tag `publishRequestTask` stamps rather than by shape, so this returns our requests and
 * not whatever else shares the server. What comes back is deliberately *not* enough to collect a reply:
 * the published Task carries no slot and no key, so the reply key held locally is what turns a listed
 * request into a readable one. See `src/lib/requestStore.ts`.
 */
export async function searchPublishedRequests(
  ehrServerUrl: string,
  count = DEFAULT_PAGE_SIZE,
  signal?: AbortSignal
): Promise<Page<Task>> {
  const params = new URLSearchParams({
    _tag: `${SHL_REQUEST_TAG.system}|${SHL_REQUEST_TAG.code}`,
    _count: String(count),
    _sort: '-_lastUpdated',
    _total: 'accurate'
  });

  const bundle = await fetchFhir<Bundle>(
    `${trimTrailingSlash(ehrServerUrl)}/Task?${params.toString()}`,
    signal
  );

  return { resources: bundleResources<Task>(bundle), total: bundle.total };
}
