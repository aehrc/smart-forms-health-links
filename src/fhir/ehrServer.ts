import type { Bundle, Patient, QuestionnaireResponse, Task } from "fhir/r4";

import { fetchProxiedFhir } from "@/lib/session";
import { SHL_REQUEST_TAG } from "@/link/invitationBundle";

/**
 * Reading the launched server: patients, their responses, and the request Tasks this app
 * published.
 *
 * There used to be three servers here - a forms catalogue, a response server and a blob host -
 * each named by its own configuration key, because the app had no launch context and had to be
 * told where everything was. There is now one server and no configuration: the requester signs
 * in to a clinical system and every read below goes to that system through the BFF proxy, which
 * attaches the session's access token server-side (FR-004, FR-005).
 *
 * The base URL is still a parameter rather than a constant in this file. Callers pass
 * `FHIR_PROXY_BASE`, and the functions stay unit-testable against any base without a browser
 * origin to intercept.
 *
 * Everything here is a read. Writes go through `src/fhir/submit.ts`.
 * @author John Grimes
 */

/** How many rows a list fetches at once. Enough to be useful, small enough to stay responsive. */
export const DEFAULT_PAGE_SIZE = 50;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
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
    return patient?.id ? `Patient/${patient.id}` : "Unnamed patient";
  }

  const joined = [...(name.given ?? []), name.family].filter(Boolean).join(" ");
  return (
    name.text ?? (joined === "" ? (patient?.id ?? "Unnamed patient") : joined)
  );
}

/**
 * The Australian national patient identifier, surfaced ahead of any other because it is the one a
 * clinician recognises. Everything else a sandbox server holds is bookkeeping.
 */
const IHI_SYSTEM = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

function identifierSummary(patient: Patient): string | undefined {
  const ihi = patient.identifier?.find(
    (identifier) => identifier.system === IHI_SYSTEM,
  )?.value;
  if (ihi) {
    return `IHI ${ihi}`;
  }

  const first = patient.identifier?.find(
    (identifier) => identifier.value,
  )?.value;
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
    identifierSummary(patient),
  ]
    .filter(Boolean)
    .join(" · ");
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
  signal?: AbortSignal,
): Promise<Page<QuestionnaireResponse>> {
  const params = new URLSearchParams({
    _count: String(options.count ?? DEFAULT_PAGE_SIZE),
    _sort: "-_lastUpdated",
    _total: "accurate",
  });

  if (options.subject) {
    params.set("subject", options.subject);
  }

  if (options.questionnaire) {
    /*
     * Searched without the version suffix. The `questionnaire` search parameter matches the reference
     * as stored, so `…/715|0.3.0-assembled` finds only responses that recorded that exact version —
     * which is rarely what someone filtering by form wants, since versions turn over.
     */
    params.set("questionnaire", options.questionnaire.split("|", 1)[0]);
  }

  const bundle = await fetchProxiedFhir<Bundle>(
    `${trimTrailingSlash(ehrServerUrl)}/QuestionnaireResponse?${params.toString()}`,
    signal,
  );

  return {
    resources: bundleResources<QuestionnaireResponse>(bundle),
    total: bundle.total,
  };
}

export async function fetchQuestionnaireResponse(
  ehrServerUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<QuestionnaireResponse> {
  return fetchProxiedFhir<QuestionnaireResponse>(
    `${trimTrailingSlash(ehrServerUrl)}/QuestionnaireResponse/${encodeURIComponent(id)}`,
    signal,
  );
}

/** Search patients by name, or list them when the search text is empty. */
export async function searchPatients(
  ehrServerUrl: string,
  searchText = "",
  count = DEFAULT_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<Page<Patient>> {
  const params = new URLSearchParams({
    _count: String(count),
    _sort: "family",
    _total: "accurate",
  });

  if (searchText.trim() !== "") {
    params.set("name", searchText.trim());
  }

  const bundle = await fetchProxiedFhir<Bundle>(
    `${trimTrailingSlash(ehrServerUrl)}/Patient?${params.toString()}`,
    signal,
  );

  return { resources: bundleResources<Patient>(bundle), total: bundle.total };
}

export async function fetchPatient(
  ehrServerUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<Patient> {
  return fetchProxiedFhir<Patient>(
    `${trimTrailingSlash(ehrServerUrl)}/Patient/${encodeURIComponent(id)}`,
    signal,
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
  signal?: AbortSignal,
): Promise<Page<Task>> {
  const params = new URLSearchParams({
    _tag: `${SHL_REQUEST_TAG.system}|${SHL_REQUEST_TAG.code}`,
    _count: String(count),
    _sort: "-_lastUpdated",
    _total: "accurate",
  });

  const bundle = await fetchProxiedFhir<Bundle>(
    `${trimTrailingSlash(ehrServerUrl)}/Task?${params.toString()}`,
    signal,
  );

  return { resources: bundleResources<Task>(bundle), total: bundle.total };
}
