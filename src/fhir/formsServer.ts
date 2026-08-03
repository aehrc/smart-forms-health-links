import type { Bundle, Questionnaire } from 'fhir/r4';

const FHIR_JSON = 'application/fhir+json';

async function fetchFhir<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Accept: FHIR_JSON }, signal });

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

/**
 * A Questionnaire is only renderable if it actually has items. The forms server hosts a number of
 * sub-questionnaires and assembly roots that have none, and feeding those to the renderer produces
 * a blank form rather than an error — so filter them out at the source.
 */
export function isRenderableQuestionnaire(questionnaire: Questionnaire | undefined): boolean {
  return !!questionnaire && Array.isArray(questionnaire.item) && questionnaire.item.length > 0;
}

/**
 * Search Questionnaires by title.
 *
 * Mirrors the query used by smart-forms-app's `useFetchQuestionnaires`:
 * `/Questionnaire?_count=&_sort=-date&title:contains=`
 */
export async function searchQuestionnaires(
  formsServerUrl: string,
  searchText: string,
  count = 100,
  signal?: AbortSignal
): Promise<Questionnaire[]> {
  const params = new URLSearchParams({ _count: String(count), _sort: '-date' });
  if (searchText.trim() !== '') {
    params.set('title:contains', searchText.trim());
  }

  const bundle = await fetchFhir<Bundle>(
    `${trimTrailingSlash(formsServerUrl)}/Questionnaire?${params.toString()}`,
    signal
  );

  return bundleResources<Questionnaire>(bundle).filter(isRenderableQuestionnaire);
}

export async function fetchQuestionnaireById(
  formsServerUrl: string,
  id: string,
  signal?: AbortSignal
): Promise<Questionnaire> {
  return fetchFhir<Questionnaire>(
    `${trimTrailingSlash(formsServerUrl)}/Questionnaire/${encodeURIComponent(id)}`,
    signal
  );
}

/**
 * Resolve a Questionnaire from a canonical URL, which is how a QuestionnaireResponse refers to its
 * Questionnaire (`QuestionnaireResponse.questionnaire`).
 *
 * Canonicals may carry a version suffix (`http://example.org/Q|1.2.0`); the FHIR search API takes
 * `url` and `version` as separate parameters, so split before querying.
 */
export async function fetchQuestionnaireByCanonical(
  formsServerUrl: string,
  canonical: string,
  signal?: AbortSignal
): Promise<Questionnaire> {
  const [url, version] = splitCanonical(canonical);

  const params = new URLSearchParams({ url, _count: '1' });
  if (version) {
    params.set('version', version);
  }

  const bundle = await fetchFhir<Bundle>(
    `${trimTrailingSlash(formsServerUrl)}/Questionnaire?${params.toString()}`,
    signal
  );

  const [questionnaire] = bundleResources<Questionnaire>(bundle);
  if (!questionnaire) {
    throw new Error(`No Questionnaire found on ${formsServerUrl} for canonical: ${canonical}`);
  }

  return questionnaire;
}

export function splitCanonical(canonical: string): [url: string, version: string | undefined] {
  const separatorIndex = canonical.lastIndexOf('|');
  if (separatorIndex === -1) {
    return [canonical, undefined];
  }

  return [canonical.slice(0, separatorIndex), canonical.slice(separatorIndex + 1)];
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
