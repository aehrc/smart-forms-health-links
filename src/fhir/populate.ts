import type { OperationOutcome, Patient, Practitioner, Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import {
  populateQuestionnaire,
  type FetchResourceCallback,
  type FetchResourceRequestConfig
} from '@aehrc/sdc-populate';
import type { SmartSession } from '@/auth/smartSession';
import { authedFetch } from './authedFetch';

/**
 * Filling a form from the record, on the requesting side.
 *
 * ## Why this runs here and not where SDC puts it
 *
 * `$populate` normally runs at **fill** time, inside a launched app: the renderer resolves each
 * item's `x-fhir-query` against the EHR just before the form is drawn, which is what smart-forms
 * does. That is unavailable here by construction. The person filling one of these forms holds no
 * credential and has no network path to the requester's servers — the second claim the README makes
 * for the design, and the reason the whole thing works over a QR code.
 *
 * So population moves to **request** time, which is the only side that has a launch context, a token
 * and a route to the EHR. The answers travel inside the encrypted payload as a seed
 * `QuestionnaireResponse`, and nothing about the filler's position changes: they still hold nothing
 * but a link. Populating once on the requesting side is not a workaround for the offline filler, it
 * is what makes pre-population and an offline filler possible at the same time.
 *
 * ## Why it does not import the renderer
 *
 * Same reason `templateExtract.ts` is split from `extract.ts`: `@aehrc/smart-forms-renderer` is a
 * browser bundle carrying CSS and font files, and esbuild has no loader for a `.woff2`, so anything
 * importing it is unreachable from the Node check harness. `@aehrc/sdc-populate` is TypeScript over
 * `fhirpath` and bundles for Node without complaint, so everything here can be asserted offline.
 */

/** SDC's populate machinery, by extension URL. */
const LAUNCH_CONTEXT = 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-launchContext';
const SOURCE_QUERIES = 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-sourceQueries';
const ITEM_POPULATION_CONTEXT =
  'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-itemPopulationContext';
const INITIAL_EXPRESSION =
  'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-initialExpression';
const VARIABLE = 'http://hl7.org/fhir/StructureDefinition/variable';

/** How long to wait before calling it off. Well under sdc-populate's own 30s default. */
export const POPULATE_TIMEOUT_MS = 15_000;

function declaresPopulation(extensions: Questionnaire['extension']): boolean {
  return (extensions ?? []).some(
    (extension) =>
      extension.url === LAUNCH_CONTEXT ||
      extension.url === SOURCE_QUERIES ||
      extension.url === ITEM_POPULATION_CONTEXT ||
      extension.url === INITIAL_EXPRESSION ||
      (extension.url === VARIABLE &&
        extension.valueExpression?.language === 'application/x-fhir-query')
  );
}

/**
 * Whether this form has anything to populate *from*.
 *
 * `sdc-populate` exports no such predicate, and without one the toggle would appear on every form and
 * do nothing on a fifth of them: 112 of the 138 Questionnaires on the default catalogue declare
 * population machinery, so 26 do not. Offering a control that silently produces no answers teaches
 * people the feature is broken.
 *
 * The item-level cases are not a rounding error. 5 of the 112 declare nothing at the root and would be
 * missed by a check for `launchContext` alone, which is the obvious way to write this.
 *
 * Deliberately a check for the *machinery*, not a prediction of the *result*. A form can declare
 * everything correctly and still populate nothing, because the record holds nothing — and that is a
 * fact about the patient, which only running it can establish.
 */
export function questionnaireDeclaresPopulation(questionnaire: Questionnaire | undefined): boolean {
  if (!questionnaire) {
    return false;
  }

  if (declaresPopulation(questionnaire.extension)) {
    return true;
  }

  function walk(items: Questionnaire['item']): boolean {
    return (items ?? []).some((item) => declaresPopulation(item.extension) || walk(item.item));
  }

  return walk(questionnaire.item);
}

export interface PrePopulateOptions {
  questionnaire: Questionnaire;
  /** The record to read. The launched server, in practice — see {@link PrePopulateOptions.session}. */
  ehrServerUrl: string;
  /** Authorises the reads. Required: see `canPrePopulate` for why anonymous population is refused. */
  session: SmartSession;
  /** The patient the request is addressed to, as a resource — populate needs more than a reference. */
  patient: Patient;
  /** The launched user, when their resource could be resolved. Optional in SDC, and optional here. */
  user?: Practitioner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PrePopulateResult {
  /** Null when the form declared population but the record produced nothing to fill in with. */
  response: QuestionnaireResponse | null;
  /** What the engine could not do, when it still produced a response. Surfaced, never swallowed. */
  issues: OperationOutcome | null;
}

/**
 * Build the callback `sdc-populate` uses to reach the record.
 *
 * **Every request goes through `authedFetch`, and that is load-bearing rather than tidy.** An
 * `x-fhir-query` lives inside a Questionnaire downloaded from a *public, read-only catalogue*, and it
 * can name any host on the internet — the same shape of attack `authedFetch` already documents for
 * `sdc-questionnaire-endpoint`, arriving through a different extension. Its origin gate is what stops
 * a form author choosing where an EHR access token gets sent; an off-origin query still runs, but it
 * runs unauthenticated, which is the correct outcome rather than a degraded one.
 *
 * Note what is *not* in `fetchResourceRequestConfig`: a token. The documented sdc-populate example
 * puts an `authToken` string there and applies it to whatever URL it builds. Beyond aiming the token
 * at the wrong hosts, a snapshot cannot refresh — `session.authorizationHeader()` is async precisely
 * so a long populate outliving its access token still works.
 */
function recordReader(session: SmartSession, signal?: AbortSignal): FetchResourceCallback {
  return async (query: string, requestConfig: FetchResourceRequestConfig) => {
    const base = requestConfig.sourceServerUrl.replace(/\/+$/, '');
    const url = /^https?:\/\//i.test(query) ? query : `${base}/${query.replace(/^\/+/, '')}`;

    const response = await authedFetch(
      url,
      { headers: { Accept: 'application/fhir+json' }, signal },
      session
    );

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }

    return response.json();
  };
}

/**
 * Fill a Questionnaire from the record, returning the answers rather than applying them.
 *
 * Returning a seed rather than a filled form is the whole shape of this feature: what comes back is
 * reviewed, pruned by the clinician, and only then sealed into the payload.
 *
 * A timeout is a **failure**, never an empty seed. The two are indistinguishable to look at and
 * opposite in meaning — one says the record could not be read, the other that it holds nothing — and
 * a clinician who cannot tell them apart will send a form asserting the second when the first is
 * true.
 */
export async function prePopulate(options: PrePopulateOptions): Promise<PrePopulateResult> {
  const { questionnaire, ehrServerUrl, session, patient, user, signal, timeoutMs } = options;

  const { populateSuccess, populateResult } = await populateQuestionnaire({
    questionnaire,
    fetchResourceCallback: recordReader(session, signal),
    fetchResourceRequestConfig: { sourceServerUrl: ehrServerUrl },
    patient,
    ...(user ? { user } : {}),
    timeoutMs: timeoutMs ?? POPULATE_TIMEOUT_MS
  });

  /*
   * `populateSuccess: false` with no result covers both "this form declares nothing to populate" and
   * "the operation failed outright", and sdc-populate does not distinguish them. The caller does, by
   * having checked `questionnaireDeclaresPopulation` first — so reaching here with nothing back means
   * the second, and it is reported as an empty result rather than thrown: the clinician can still
   * send the form.
   */
  if (!populateSuccess || !populateResult) {
    return { response: null, issues: null };
  }

  return {
    response: populateResult.populatedResponse,
    issues: populateResult.issues ?? null
  };
}
