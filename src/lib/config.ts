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
   * `shl` is the only one that still mints; `bespoke` is decode-only and setting it here is an
   * error. Decoding always accepts every registered codec, so old `sfhl:/` links keep opening.
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

  /**
   * Who requests appear to come from, e.g. `"Parkview Medical Centre"`.
   *
   * Written to `Task.requester.display` and shown to the filler before anything is stored. Worth
   * setting: an invitation that cannot say who sent it is one a patient has every reason to decline.
   */
  senderName: string | null;

  /**
   * Offer the plain-FHIR return channel (channel B) alongside the encrypted one.
   *
   * Off by default, and deliberately so. It writes the request's `Task` to `responseServerUrl` and
   * declares that server on the Questionnaire via `sdc-questionnaire-endpoint`, which means a filler
   * holding nothing but the link can `POST` a response straight into it. That is ordinary SDC and it
   * needs no infrastructure — but the answers land **unreviewed**, which is the opposite posture to
   * the encrypted channel, where they are pulled, shown to a human, and only then written.
   *
   * Point `sdc-questionnaire-endpoint` at a staging server rather than the record server if you want
   * both. Requires `responseServerUrl`.
   */
  enableServerReturn: boolean;

  /**
   * Offer the encrypted reply channel (channel C) on requests this app mints.
   *
   * Off by default, because the primary return path is now the filler minting its own SMART Health
   * Link and the requester scanning it back. With this off, a request carries no reply slot, no
   * public key and no reply descriptor — the invitation is just the form.
   *
   * The channel is implemented and tested, not removed: turning this on restores it, and nothing
   * else needs to change. Note this governs only what this app *mints*. A request from a third
   * party that offers a reply descriptor is still answerable regardless, because refusing to honour
   * someone else's return channel would strand their answers, not protect anyone.
   *
   * Requires `blobServerUrl` to host the slot.
   */
  enableEncryptedReply: boolean;

  /**
   * How long a request stays openable, in days. `null` means no expiry.
   *
   * Sets the SHL payload's `exp` and the reply slot's `expiresAt`. Matches the 30-day default Platypus
   * uses for its own invitations.
   */
  linkLifetimeDays: number | null;

  /**
   * Publish each request's `Task` to `responseServerUrl`, so sent requests can be listed back.
   *
   * Independent of {@link enableServerReturn}, which is the separate and much bigger decision to accept
   * answers without review. This only records *that* a request was sent: without it, `/requests` can
   * only ever show what the current browser created, because the reply key never leaves it.
   *
   * The published copy carries no reply slot, no key and no token — see `publishRequestTask`. What it
   * does put on a shared server is the fact that a form was requested, for whom, and by whom, so turn
   * it off if that metadata should not be there.
   */
  publishRequestTasks: boolean;
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
  shlManifestUrl: null,
  senderName: null,
  // Off unless asked for: it is the channel that writes without review. See the field docs above.
  enableServerReturn: false,
  // Deferred, not removed. The primary return path is a link the filler mints. See the field docs.
  enableEncryptedReply: false,
  linkLifetimeDays: 30,
  publishRequestTasks: true
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

/** Absent is fine and takes the fallback; present but the wrong shape is not. */
function isAbsentOr(value: unknown, valid: (candidate: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

/**
 * Exported so tests can assert the shipped `public/config.json` actually validates.
 *
 * Fields added after the first release are optional: a config written before they existed is not
 * malformed, it just does not mention them, and {@link loadConfig} fills them from
 * {@link FALLBACK_CONFIG}. Rejecting it outright would discard the servers it *does* specify and
 * silently point a deployment somewhere else.
 */
export function isAppConfig(value: unknown): value is Partial<AppConfig> {
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
    (candidate.shlManifestUrl === null || isValidUrl(candidate.shlManifestUrl)) &&
    isAbsentOr(
      candidate.senderName,
      (name) => name === null || (typeof name === 'string' && name.trim() !== '')
    ) &&
    isAbsentOr(candidate.enableServerReturn, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.enableEncryptedReply, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.publishRequestTasks, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(
      candidate.linkLifetimeDays,
      (days) => days === null || (typeof days === 'number' && Number.isFinite(days) && days > 0)
    )
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

    // Merged rather than returned as-is, so a config predating a field gets that field's default
    // instead of `undefined`.
    return { ...FALLBACK_CONFIG, ...parsed };
  } catch {
    console.warn('config.json could not be loaded, falling back to defaults');
    return FALLBACK_CONFIG;
  }
}

/** Origin that generated links point at. */
export function resolveLinkBaseUrl(config: AppConfig): string {
  return config.linkBaseUrl ?? window.location.origin;
}

/** Epoch seconds at which a request minted now should stop being openable. */
export function resolveExpiry(config: AppConfig, now = Date.now()): number | undefined {
  if (config.linkLifetimeDays === null) {
    return undefined;
  }

  return Math.floor(now / 1000) + Math.round(config.linkLifetimeDays * 86400);
}

/** Whether the plain-FHIR return channel is both enabled and pointed somewhere. */
export function canUseServerReturn(config: AppConfig): boolean {
  return config.enableServerReturn && config.responseServerUrl !== null;
}

/**
 * Whether an encrypted reply slot can be minted: the channel is enabled *and* there is somewhere to
 * host the slot.
 *
 * The `blobServerUrl` half is what makes {@link FALLBACK_CONFIG} safe — a deployment whose config
 * failed to load cannot mint a slot even if some future default turned the flag on.
 */
export function canUseEncryptedReply(config: AppConfig): boolean {
  return config.enableEncryptedReply && config.blobServerUrl !== null;
}

/** Whether sent requests can be recorded on, and listed back from, the EHR. */
export function canTrackRequests(config: AppConfig): boolean {
  return config.publishRequestTasks && config.responseServerUrl !== null;
}
