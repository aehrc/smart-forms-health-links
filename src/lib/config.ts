/**
 * Runtime configuration, fetched from `/config.json` at boot.
 *
 * This mirrors the approach used by `apps/smart-forms-app`
 * (`src/features/configChecker/utils/config.ts`) in the smart-forms monorepo: config is
 * fetched at runtime rather than baked in at build time, so the same built artifact can be
 * deployed against different forms/terminology servers.
 */

/** Identifier of the link codec used when *creating* links. See `src/link/codec.ts`. */
export type LinkCodecId = 'bespoke' | 'shl';

export interface AppConfig {
  /** Questionnaire-hosting FHIR server. Read-only usage — we never write to it. */
  formsServerUrl: string;

  /** FHIR terminology server for ValueSet expansion, passed through to the renderer. */
  terminologyServerUrl: string;

  /**
   * Origin used when building links, e.g. `https://links.example.org`.
   * When null, `window.location.origin` is used, which is what you want in dev.
   */
  linkBaseUrl: string | null;

  /**
   * Which codec creates links.
   *
   * Phase 1 ships `bespoke` only. Flipping this to `shl` is the intended Phase 2 switch —
   * decoding always accepts every registered codec, so old links keep working.
   */
  linkCodec: LinkCodecId;

  /**
   * Where reviewed QuestionnaireResponses and their Tasks are written.
   *
   * Deliberately has **no fallback**. `formsServerUrl` is a read-only catalogue — smart-forms itself
   * only ever issues `GET Questionnaire` and `$assemble` against it, and writes responses to the
   * SMART launch server instead. This app has no launch context and therefore no such server, so the
   * write target has to be stated rather than guessed. When null, the app refuses to write and says
   * why.
   *
   * A Questionnaire's own `sdc-questionnaire-endpoint` extension still outranks this.
   */
  responseServerUrl: string | null;

  /**
   * Where SMART Health Link payloads are hosted, as FHIR `Binary` resources.
   *
   * Also no fallback, and for the same reason: blobs are transactional data and do not belong in the
   * forms catalogue. Any FHIR server accepting `Binary` create/read will do — it need not be trusted,
   * because the payload is a JWE and the key travels only inside the link, which is the untrusted-host
   * model SHL is built around.
   */
  blobServerUrl: string | null;

  /** How SHL payloads are stored. Only FHIR `Binary` is implemented. */
  blobStore: 'fhir-binary';

  /**
   * Base URL of an external SMART Health Links manifest server, if one is ever stood up.
   * Unused while `blobStore` is `fhir-binary` — reading manifest-based links needs no config.
   */
  shlManifestUrl: string | null;
}

export const FALLBACK_CONFIG: AppConfig = {
  formsServerUrl: 'https://smartforms.csiro.au/api/fhir',
  terminologyServerUrl: 'https://r4.ontoserver.csiro.au/fhir',
  linkBaseUrl: null,
  linkCodec: 'shl',
  // Null on purpose: writing must be configured, never inferred. See the field docs above.
  responseServerUrl: null,
  blobServerUrl: null,
  blobStore: 'fhir-binary',
  shlManifestUrl: null
};

function isValidUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\/.+/.test(value.trim())) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Exported so tests can assert the shipped `public/config.json` actually validates. */
export function isAppConfig(value: unknown): value is AppConfig {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isValidUrl(candidate.formsServerUrl) &&
    isValidUrl(candidate.terminologyServerUrl) &&
    (candidate.linkBaseUrl === null || isValidUrl(candidate.linkBaseUrl)) &&
    (candidate.linkCodec === 'bespoke' || candidate.linkCodec === 'shl') &&
    (candidate.responseServerUrl === null || isValidUrl(candidate.responseServerUrl)) &&
    (candidate.blobServerUrl === null || isValidUrl(candidate.blobServerUrl)) &&
    candidate.blobStore === 'fhir-binary' &&
    (candidate.shlManifestUrl === null || isValidUrl(candidate.shlManifestUrl))
  );
}

/**
 * Load `/config.json`, falling back to {@link FALLBACK_CONFIG} if it is missing or malformed.
 *
 * A missing config is not fatal here — unlike smart-forms-app, this app has no SMART launch to
 * get wrong, so defaulting to the public CSIRO servers is a safe and useful behaviour.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch('/config.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return FALLBACK_CONFIG;
    }

    const parsed: unknown = await response.json();
    if (!isAppConfig(parsed)) {
      console.warn('config.json is malformed, falling back to defaults');
      return FALLBACK_CONFIG;
    }

    return parsed;
  } catch {
    console.warn('config.json could not be loaded, falling back to defaults');
    return FALLBACK_CONFIG;
  }
}

/** Origin that generated links point at. */
export function resolveLinkBaseUrl(config: AppConfig): string {
  return config.linkBaseUrl ?? window.location.origin;
}
