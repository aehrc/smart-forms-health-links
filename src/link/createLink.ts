import type { Questionnaire, Task } from 'fhir/r4';
import { getResponse, removeEmptyAnswersFromResponse } from '@aehrc/smart-forms-renderer';
import type { AppConfig } from '@/lib/config';
import { resolveLinkBaseUrl } from '@/lib/config';
import { fhirBinaryBlobStore, type BlobStore } from '@/fhir/blobStore';
import { LINK_CODECS } from './registry';
import { defaultLabel, encodingCodec, ensureQuestionnaireCanonical } from './codec';
import { buildRequestBundle, buildResponseBundle } from './exchange';

/**
 * Link creation — the boundary where the renderer's global form state and the app's config meet the
 * codecs. This is the only part of the link layer that depends on `@aehrc/smart-forms-renderer`.
 */

/** Where a SMART Health Link's encrypted payload gets hosted, per config. */
export function resolveBlobStore(config: AppConfig): BlobStore {
  switch (config.blobStore) {
    case 'fhir-binary':
      return fhirBinaryBlobStore(config.formsServerUrl);
  }
}

/**
 * Build a "please fill this in" link.
 *
 * The Questionnaire is embedded whole so the filler needs no forms-server access, which is what
 * pushes this onto the hosted-SHL path — hundreds of kilobytes cannot ride inside a QR code.
 */
export async function createRequestLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  options: { subjectReference?: string; expiresAt?: number } = {}
): Promise<{ link: string; task: Task }> {
  const { bundle, task } = buildRequestBundle(questionnaire, {
    subjectReference: options.subjectReference
  });

  const codec = encodingCodec(config, LINK_CODECS);

  const link = await codec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    {
      baseUrl: resolveLinkBaseUrl(config),
      blobStore: resolveBlobStore(config),
      expiresAt: options.expiresAt
    }
  );

  return { link, task };
}

/**
 * Build a "here are the answers" link from the form's current state.
 *
 * Empty and enableWhen-hidden answers are stripped first — partly hygiene, mostly size, since
 * everything removed here is payload that would otherwise count against the QR budget on the return
 * leg.
 *
 * `requestTask` is the Task that arrived with the request; passing it through is what lets the
 * requester match these answers to what it asked for.
 */
export async function createResponseLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  requestTask?: Task
): Promise<string> {
  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildResponseBundle(response, requestTask);

  const codec = encodingCodec(config, LINK_CODECS);

  return codec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config), blobStore: resolveBlobStore(config) }
  );
}

/**
 * Build a response link using the bespoke fragment codec regardless of config.
 *
 * This is the no-infrastructure return path: the answers travel inside the URL, so nothing is hosted
 * anywhere. Size-limited to roughly 14 KB of raw response JSON, and unencrypted — but it is how a
 * filler with no server of its own can hand results back at all.
 */
export async function createOfflineResponseLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  requestTask?: Task
): Promise<string> {
  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildResponseBundle(response, requestTask);

  const bespoke = LINK_CODECS.find((codec) => codec.id === 'bespoke');
  if (!bespoke) {
    throw new Error('The bespoke codec is not registered.');
  }

  return bespoke.encode(
    { bundle, label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config) }
  );
}
