import type { Questionnaire } from 'fhir/r4';
import { getResponse, removeEmptyAnswersFromResponse } from '@aehrc/smart-forms-renderer';
import type { AppConfig } from '@/lib/config';
import { resolveLinkBaseUrl } from '@/lib/config';
import { LINK_CODECS } from './registry';
import { bundleResponse, defaultLabel, encodingCodec, ensureQuestionnaireCanonical } from './codec';

/**
 * Take the form's current answers and produce a shareable link.
 *
 * Empty and enableWhen-hidden answers are stripped first. That is partly hygiene, but mostly size:
 * everything removed here is payload that would otherwise count against the QR code's byte budget.
 *
 * This module is the boundary where the renderer's global form state meets the codec, which is why
 * it is the only part of the link layer that depends on `@aehrc/smart-forms-renderer`.
 */
export async function createLinkFromCurrentForm(
  questionnaire: Questionnaire,
  config: AppConfig
): Promise<string> {
  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);

  const codec = encodingCodec(config, LINK_CODECS);

  return codec.encode(
    { bundle: bundleResponse(response), label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config) }
  );
}
