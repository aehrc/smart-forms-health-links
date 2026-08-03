import type { Bundle, Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import type { AppConfig, LinkCodecId } from '@/lib/config';

/**
 * The payload a link carries, independent of how it is transported.
 *
 * This is deliberately modelled on what a SMART Health Link carries: the content of an SHL
 * manifest file is `application/fhir+json` — a FHIR Bundle. Keeping the Phase 1 payload as a
 * Bundle too means Phase 2 changes only the *transport* (fragment vs manifest + JWE), never the
 * data model, and the routes/UI stay untouched.
 */
export interface LinkContent {
  /** A `collection` Bundle. In practice: one QuestionnaireResponse entry. */
  bundle: Bundle;

  /** Human-readable description, shown before the form is opened. Maps to SHL's `label`. */
  label?: string;
}

export interface EncodeOptions {
  /** Origin the link should point at, e.g. `https://links.example.org`. */
  baseUrl: string;
}

/**
 * A link transport.
 *
 * Every codec presents its payload in the URL *fragment*, which is the form SMART Health Links
 * itself uses (`https://viewer.example.org#shlink:/eyJ1cmwi...`). Two consequences worth knowing:
 *
 *  1. The fragment is never sent in an HTTP request, so response data never leaves the device.
 *  2. The fragment is therefore unavailable for routing — this app must use path-based routing.
 */
export interface LinkCodec {
  readonly id: LinkCodecId;

  /** Fragment prefix, e.g. `sfhl:/` or `shlink:/`. */
  readonly prefix: string;

  /** Whether this codec recognises the given link or bare fragment. */
  canDecode(linkOrFragment: string): boolean;

  encode(content: LinkContent, options: EncodeOptions): Promise<string>;

  decode(linkOrFragment: string): Promise<LinkContent>;
}

/**
 * Reduce a full URL, a `scheme:/payload` string, or a bare `#fragment` down to just the fragment
 * body. Scanners hand back whichever of these the QR happened to contain.
 */
export function extractFragment(linkOrFragment: string): string {
  const trimmed = linkOrFragment.trim();

  const hashIndex = trimmed.indexOf('#');
  if (hashIndex !== -1) {
    return trimmed.slice(hashIndex + 1);
  }

  // No '#': either a bare fragment body already, or a full URL with nothing useful in it.
  if (/^https?:\/\//.test(trimmed)) {
    return '';
  }

  return trimmed;
}

/** Build a `collection` Bundle around a QuestionnaireResponse — the link's payload. */
export function bundleResponse(questionnaireResponse: QuestionnaireResponse): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: questionnaireResponse }]
  };
}

/** Pull the QuestionnaireResponse back out of a decoded payload. */
export function responseFromBundle(bundle: Bundle): QuestionnaireResponse {
  const response = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find(
      (resource): resource is QuestionnaireResponse =>
        resource?.resourceType === 'QuestionnaireResponse'
    );

  if (!response) {
    throw new Error('Link payload contains no QuestionnaireResponse.');
  }

  return response;
}

/**
 * The canonical URL of the Questionnaire a response belongs to.
 *
 * The Questionnaire is always carried by reference, never by value: the Aboriginal and Torres
 * Strait Islander Health Check questionnaire alone is ~821 KB, which no QR code can hold.
 */
export function questionnaireCanonical(response: QuestionnaireResponse): string {
  if (!response.questionnaire) {
    throw new Error(
      'QuestionnaireResponse has no `questionnaire` canonical, so the form cannot be resolved.'
    );
  }

  return response.questionnaire;
}

/**
 * A QuestionnaireResponse must carry the canonical URL of its Questionnaire, because that is the
 * only thing in the link that lets the receiving side resolve which form to render. The renderer
 * normally sets this during `buildForm`, but fall back to deriving it so a link can never be
 * created that cannot be opened.
 */
export function ensureQuestionnaireCanonical(
  response: QuestionnaireResponse,
  questionnaire: Questionnaire
): QuestionnaireResponse {
  if (response.questionnaire) {
    return response;
  }

  if (!questionnaire.url) {
    throw new Error(
      'This Questionnaire has no canonical `url`, so a link to it cannot be resolved by the reader.'
    );
  }

  const canonical = questionnaire.version
    ? `${questionnaire.url}|${questionnaire.version}`
    : questionnaire.url;

  return { ...response, questionnaire: canonical };
}

export function defaultLabel(questionnaire: Questionnaire): string {
  return questionnaire.title ?? questionnaire.name ?? questionnaire.id ?? 'Questionnaire';
}

/** Resolve the codec used for *creating* links. */
export function encodingCodec(config: AppConfig, codecs: LinkCodec[]): LinkCodec {
  const codec = codecs.find((candidate) => candidate.id === config.linkCodec);
  if (!codec) {
    throw new Error(`Configured linkCodec "${config.linkCodec}" is not registered.`);
  }

  return codec;
}

/**
 * Resolve the codec for *reading* a link by sniffing its prefix.
 *
 * Decoding always considers every registered codec regardless of config, so links created before
 * a Phase 2 cutover keep working afterwards.
 */
export function decodingCodec(linkOrFragment: string, codecs: LinkCodec[]): LinkCodec {
  const codec = codecs.find((candidate) => candidate.canDecode(linkOrFragment));
  if (!codec) {
    throw new Error('Not a recognised Smart Forms link.');
  }

  return codec;
}
