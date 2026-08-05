import type { Bundle, FhirResource, Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import type { AppConfig, LinkCodecId } from '@/lib/config';
import type { BlobStore } from '@/fhir/blobStore';

/**
 * The payload a link carries, independent of how it is transported.
 *
 * This is deliberately modelled on what a SMART Health Link carries: the content of an SHL
 * manifest file is `application/fhir+json` — a FHIR Bundle. Keeping the fragment-carried payload as
 * a Bundle too means a transport change (fragment vs manifest + JWE) never touches the data model,
 * and the routes/UI stay untouched.
 *
 * A link this app *reads* was probably not written by it, so a payload is normalised into this
 * shape rather than required to arrive in it — see {@link asBundle} and {@link mergeBundles}.
 */
export interface LinkContent {
  /** A `collection` Bundle. Typically a QuestionnaireResponse, often with a Task or Provenance. */
  bundle: Bundle;

  /** Human-readable description, shown before the form is opened. Maps to SHL's `label`. */
  label?: string;

  /**
   * Non-fatal notes from decoding: files skipped, files that would not decrypt, content types
   * ignored.
   *
   * Surfaced rather than logged, because the only person who can judge whether a dropped file
   * mattered is the one reading the answers. A manifest carrying a second QuestionnaireResponse
   * that is not on screen must not be discoverable only from the console.
   */
  warnings?: string[];
}

/** Options a reader may supply when opening a link. */
export interface DecodeOptions {
  /** Passcode for a manifest-mode link that demands one (the SHL `P` flag). */
  passcode?: string;

  /** Names the reader in the manifest request body, per the spec's `recipient` field. */
  recipient?: string;
}

/**
 * A manifest-mode link needs a passcode before it will yield its content.
 *
 * Distinguishable from an ordinary failure so the UI can prompt rather than dead-end, and carries
 * `remainingAttempts` because a passcode-protected SHL is allowed to lock itself permanently.
 */
export class PasscodeRequiredError extends Error {
  readonly remainingAttempts?: number;

  /** True when a passcode was supplied and rejected; false when none had been tried yet. */
  readonly wasAttempted: boolean;

  constructor(options: { remainingAttempts?: number; wasAttempted: boolean }) {
    super(
      options.wasAttempted
        ? options.remainingAttempts === undefined
          ? 'Incorrect passcode.'
          : `Incorrect passcode. ${options.remainingAttempts} attempt(s) remaining.`
        : 'This link requires a passcode.'
    );

    this.name = 'PasscodeRequiredError';
    this.remainingAttempts = options.remainingAttempts;
    this.wasAttempted = options.wasAttempted;
  }
}

export interface EncodeOptions {
  /** Origin the link should point at, e.g. `https://links.example.org`. */
  baseUrl: string;

  /**
   * Where to park an encrypted payload that is too large to travel inside the link.
   *
   * Required by the SHL codec, ignored by the bespoke codec — which is the whole distinction between
   * them: bespoke carries its payload in the fragment, SHL carries a pointer to a hosted one.
   */
  blobStore?: BlobStore;

  /** Optional expiry, as Epoch seconds. Maps to the SHL payload's `exp`. */
  expiresAt?: number;
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

  /**
   * This codec can still open links, but nothing new is minted with it.
   *
   * Retiring a transport is not the same as dropping it: links already in the wild have to keep
   * working. {@link encodingCodec} refuses a decode-only codec, while {@link decodingCodec}
   * continues to consider it.
   */
  readonly decodeOnly?: boolean;

  /** Whether this codec recognises the given link or bare fragment. */
  canDecode(linkOrFragment: string): boolean;

  encode(content: LinkContent, options: EncodeOptions): Promise<string>;

  /**
   * `options` is optional so a codec that needs nothing can declare `decode(link)` and stay
   * assignable here — which is what keeps the passcode addition from rippling into every codec.
   */
  decode(linkOrFragment: string, options?: DecodeOptions): Promise<LinkContent>;
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

/**
 * Build a `collection` Bundle.
 *
 * Entries carry a `fullUrl` so resources inside the Bundle can reference each other with
 * `urn:uuid:` — which is how a Task points at the QuestionnaireResponse it produced, given that
 * QuestionnaireResponse cannot reference a Task in the other direction. See `exchange.ts`.
 */
export function collectionBundle(entries: { fullUrl?: string; resource: FhirResource }[]): Bundle {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: entries.map(({ fullUrl, resource }) => (fullUrl ? { fullUrl, resource } : { resource }))
  };
}

/** Build a `collection` Bundle around a QuestionnaireResponse — the simplest link payload. */
export function bundleResponse(questionnaireResponse: QuestionnaireResponse): Bundle {
  return collectionBundle([{ resource: questionnaireResponse }]);
}

/**
 * Normalise a decoded FHIR resource into a Bundle.
 *
 * A Bundle passes through; anything else is wrapped. This exists because an SHL manifest file is
 * `application/fhir+json` — *any* FHIR resource, not necessarily a Bundle — and a filler that parks
 * a bare `QuestionnaireResponse` there has done nothing wrong. Insisting on a Bundle would make a
 * perfectly ordinary link unopenable, so tolerate the shape and let the rest of the app go on
 * working in Bundles.
 */
export function asBundle(resource: FhirResource): Bundle {
  return resource.resourceType === 'Bundle'
    ? (resource as Bundle)
    : collectionBundle([{ resource }]);
}

/**
 * Parse decrypted payload text into a Bundle, tolerating a bare resource.
 *
 * `what` names the payload in error messages ("link payload", "reply") — the only difference
 * between the two call sites, which is why there is one implementation.
 */
export function bundleFromJson(text: string, what = 'link payload'): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`The decrypted ${what} was not valid JSON.`, { cause });
  }

  const resourceType = (parsed as { resourceType?: unknown } | null)?.resourceType;
  if (typeof resourceType !== 'string' || resourceType === '') {
    throw new Error(`The decrypted ${what} is not a FHIR resource.`);
  }

  return asBundle(parsed as FhirResource);
}

/**
 * Concatenate Bundles into one `collection`, dropping entries whose `fullUrl` was already seen.
 *
 * An SHL manifest may split its content across files — the QuestionnaireResponse in one, the
 * Provenance attributing it in another — and those are one payload, not a choice between them.
 * De-duplication is by `fullUrl` only: entries without one are always kept, because two resources
 * that decline to identify themselves cannot be shown to be the same resource.
 */
export function mergeBundles(bundles: Bundle[]): Bundle {
  if (bundles.length === 1) {
    return bundles[0];
  }

  const seen = new Set<string>();
  const entry = bundles
    .flatMap((bundle) => bundle.entry ?? [])
    .filter((candidate) => {
      if (candidate.fullUrl === undefined) {
        return true;
      }

      if (seen.has(candidate.fullUrl)) {
        return false;
      }

      seen.add(candidate.fullUrl);
      return true;
    });

  return { resourceType: 'Bundle', type: 'collection', entry };
}

/** Find the first resource of a given type in a Bundle. */
export function findInBundle<T extends FhirResource>(
  bundle: Bundle,
  resourceType: T['resourceType']
): T | undefined {
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is T => resource?.resourceType === resourceType);
}

/** Pull the QuestionnaireResponse back out of a decoded payload. */
export function responseFromBundle(bundle: Bundle): QuestionnaireResponse {
  const response = findInBundle<QuestionnaireResponse>(bundle, 'QuestionnaireResponse');

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

  if (codec.decodeOnly) {
    throw new Error(
      `Configured linkCodec "${config.linkCodec}" is decode-only — its links can still be opened, ` +
        'but nothing new is minted with it. Set linkCodec to "shl".'
    );
  }

  return codec;
}

/**
 * Resolve the codec for *reading* a link by sniffing its prefix.
 *
 * Decoding always considers every registered codec regardless of config, and regardless of whether
 * that codec is still used for minting. That asymmetry is what lets a transport be retired without
 * invalidating links already in the wild.
 */
export function decodingCodec(linkOrFragment: string, codecs: LinkCodec[]): LinkCodec {
  const codec = codecs.find((candidate) => candidate.canDecode(linkOrFragment));
  if (!codec) {
    throw new Error('Not a recognised Smart Forms link.');
  }

  return codec;
}
