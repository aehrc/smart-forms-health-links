import type { Bundle, OperationOutcome, Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import {
  buildBundleFromObservationArray,
  canBeObservationExtracted,
  extractObservationBased
} from '@aehrc/smart-forms-renderer';
import { canTemplateExtract, retargetSubject, templateExtract } from './templateExtract';

/**
 * Turn completed answers into the resources they imply — Conditions, Observations, and the rest.
 *
 * This is SDC form data extraction, and it runs **entirely in the browser**. There is no `$extract`
 * server, no StructureMap transform, and no new infrastructure: both mechanisms here are pure
 * functions over a Questionnaire and a QuestionnaireResponse. That matters for this app specifically,
 * which is a static site with no backend of its own — see the README's sixth claim.
 *
 * Nothing here writes. Extraction produces a transaction Bundle and stops, because a human still has
 * to say which parts of it belong in the record. `src/fhir/writeBundle.ts` does the writing.
 *
 * The template half lives in `./templateExtract` so the Node check harness can reach it without
 * bundling the renderer. This module is the one the app imports, and the only one that knows there is
 * more than one mechanism.
 */

export { describeOutcome, outcomeHasErrors, retargetSubject } from './templateExtract';

/**
 * Which extraction mechanism a form declares, if any.
 *
 * `null` is the common case and is not a failure — 107 of the 138 Questionnaires on the default forms
 * server declare no extraction at all. Callers must render nothing rather than rendering empty.
 *
 * Template first, then observation, matching `getExtractMechanism` in smart-forms
 * (`apps/smart-forms-app/src/features/renderer/utils/extract.ts`). No form on the default server
 * declares both, but keeping the precedence identical means behaviour cannot quietly diverge if one
 * ever does.
 *
 * Definition-based and StructureMap-based are both absent on purpose. smart-forms has never
 * implemented the former, and CSIRO decommissioned its demo engine for the latter on 1 July 2025.
 */
export type ExtractMechanism = 'template-based' | 'observation-based' | null;

export function extractMechanism(questionnaire: Questionnaire | undefined): ExtractMechanism {
  if (!questionnaire) {
    return null;
  }

  if (canTemplateExtract(questionnaire)) {
    return 'template-based';
  }

  if (canBeObservationExtracted(questionnaire)) {
    return 'observation-based';
  }

  return null;
}

export interface Extraction {
  /** A `transaction` Bundle. Empty `entry` is possible and means "this form extracted nothing". */
  bundle: Bundle;
  mechanism: Exclude<ExtractMechanism, null>;
  /**
   * Non-fatal problems the engine reported while still producing a Bundle.
   *
   * Worth surfacing rather than logging: a template that silently failed to resolve one value yields a
   * resource that looks complete and is not, and the reviewer is the only one who can catch that.
   */
  issues: OperationOutcome | null;
}

export interface ExtractOptions {
  /**
   * The answers to extract from — **after** subject reconciliation, never as they arrived.
   *
   * See `retargetSubject` in `./templateExtract` for why this is the single most load-bearing sentence
   * in the feature.
   */
  response: QuestionnaireResponse;
  questionnaire: Questionnaire;
  /**
   * The subject the answers named before the reviewer repointed them, when they did.
   *
   * Only used to catch templates that reached past `%resource.subject`. Omitting it is safe; it just
   * turns the safety net off.
   */
  originalSubject?: string;
}

/** Run whichever mechanism the form declares, or throw with something a reviewer can act on. */
export async function extractFromResponse(options: ExtractOptions): Promise<Extraction> {
  const { response, questionnaire, originalSubject } = options;
  const mechanism = extractMechanism(questionnaire);

  if (mechanism === null) {
    throw new Error('This form does not declare any form data extraction.');
  }

  if (mechanism === 'observation-based') {
    const observations = extractObservationBased(questionnaire, response);
    return {
      bundle: retargetSubject(
        buildBundleFromObservationArray(observations),
        response,
        originalSubject
      ),
      mechanism,
      issues: null
    };
  }

  const { bundle, issues } = await templateExtract(response, questionnaire);

  return { bundle: retargetSubject(bundle, response, originalSubject), mechanism, issues };
}
