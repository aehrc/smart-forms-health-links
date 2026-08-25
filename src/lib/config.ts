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
   * The EHR: where patients and responses are read from, and — historically — written to.
   *
   * Read is now the operative half. `resolveDestinations` falls to this only when there is no session,
   * and with no session the app will not write at all ({@link canWriteToRecord}), so in practice a
   * launched deployment reads from here until it launches and writes to the launched server. It is
   * still the value that decides whether `/patients` and `/responses` show anything before anyone
   * signs in, which is most of what a reader of this field wants to know.
   *
   * Deliberately has **no fallback** to `formsServerUrl`, which is a read-only catalogue — smart-forms
   * itself only ever issues `GET Questionnaire` and `$assemble` against it and writes responses to its
   * launch server instead. Defaulting here would quietly put patient data into a shared reference
   * library. When null, there is nothing to read and nothing to write, and the app says so.
   *
   * A Questionnaire's own `sdc-questionnaire-endpoint` extension still outranks this — and outranks a
   * launch, which is why the token is gated on origin rather than on "is there a session". See
   * `src/fhir/authedFetch.ts`.
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
   * Offer the one-shot write channel (channel D) on requests this app mints.
   *
   * **On** in the shipped `config.json`, off in {@link FALLBACK_CONFIG}. The distinction is the point:
   * what ships is a chosen sandbox where this channel is part of the demo, whereas the fallback is a
   * config that failed to load and must hand out no capability it was not explicitly asked for.
   *
   * With it on, each request pre-allocates an
   * empty `QuestionnaireResponse` on {@link writeSlotServerUrl} and the invitation names its absolute
   * URL, an `If-Match` ETag, and a write token. A filler holding the link may `PUT` the completed
   * answers there **once** — the second attempt is refused by the server's own optimistic locking,
   * which is what makes "once" a property of the wire rather than of trust.
   *
   * This is channel B done properly, and it supersedes it for new deployments: B named a server and
   * carried no capability at all, so the endpoint had to accept writes from anyone holding a link,
   * and the answers landed in a record **unreviewed**. Here the slot is staged off the record server,
   * so the answers are collected, shown to a human, and only then written — the same posture as every
   * other channel.
   *
   * It does **not** supersede {@link enableEncryptedReply}. The payload here is plaintext FHIR, so the
   * slot host sees the answers; channel C exists precisely so it cannot. What this buys instead is a
   * filler that needs no bespoke crypto — any app that can `PUT` a FHIR resource can answer.
   *
   * Requires a slot server: {@link writeSlotServerUrl}, or `blobServerUrl`.
   */
  enableOneShotWrite: boolean;

  /**
   * Offer to write the resources these answers imply into the patient record.
   *
   * SDC form data extraction: a form's own templates say that "chest pain, since March" means a
   * `Condition`, and the reviewer ticks which of those belong on the record. It runs entirely in the
   * browser — no `$extract` server, no StructureMap engine — so this flag costs no infrastructure.
   *
   * Off in the fallback for the same reason every other write capability is: a deployment whose config
   * failed to load should not start creating clinical resources on a server it cannot name properly.
   *
   * Inert for a form that declares no extraction, which is most of them. Turning it on does not make
   * the app write anything on its own — extraction is still reviewed, ticked and accepted by a human,
   * which is the posture the whole app takes.
   */
  enableWriteBack: boolean;

  /**
   * Fill a requested form from the record before the link is minted.
   *
   * SDC pre-population, moved to the only place this app can run it. `$populate` normally runs at
   * *fill* time inside a launched app, resolving each item's `x-fhir-query` against the EHR just
   * before the form is drawn — which is impossible here, because the filler holds no credential and
   * has no path to our servers. That is the point of the design, not a gap in it.
   *
   * So population happens at **request** time, on the side that does have a launch context, and the
   * answers ride inside the encrypted payload. Nothing about the filler's position changes.
   *
   * Off in the fallback, on in the shipped `config.json` — the same split as
   * {@link enableOneShotWrite}, because what ships is a chosen sandbox of synthetic patients where
   * this is part of the demo, and the fallback is a config that failed to load.
   *
   * **Weigh it differently for real data.** Its neighbours are *write* capabilities, gated because
   * they put data on somebody's server. This is a **disclosure** capability: it copies record content
   * into a payload that leaves the building and is readable by anyone holding the link. A request
   * stops being "a public questionnaire plus a name" and becomes an extract from a chart, sitting
   * encrypted on an untrusted host with its key in a QR code somebody can photograph. Turning it on
   * is a decision about what a leaked link would cost, and the answer differs by deployment.
   *
   * Two deliberate acts are still needed with the flag on: a SMART launch, and ticking the box on the
   * request itself. The flag makes the option visible, not automatic.
   *
   * Requires a launched session — see {@link canPrePopulate}. Inert for a form that declares no
   * population machinery, though that is the minority here: 112 of the 138 forms on the default
   * catalogue declare some, against 25 that declare extraction. This is the broadest SDC capability
   * in that catalogue, and until now the app used none of it.
   */
  enablePrePopulate: boolean;

  /**
   * Where one-shot write slots are pre-allocated. `null` falls back to `blobServerUrl`.
   *
   * Separate from `responseServerUrl` on purpose, and the separation is the whole point of the
   * channel: a slot is transient transport of the same trust class as the SHL payload host, not a
   * record. Pointing it at the record server would put unreviewed third-party answers straight into
   * it, which is the Channel B behaviour this replaces.
   */
  writeSlotServerUrl: string | null;

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

  /**
   * Offer SMART App Launch, so the EHR is discovered from a launch rather than named in config.
   *
   * **On** in the shipped `config.json`, off in {@link FALLBACK_CONFIG} — same split, same reason as
   * {@link enableOneShotWrite}: a deployment whose config failed to load has no issuer and no client
   * id, so it could not start a flow even if this were true.
   *
   * With it on, the app gains `/launch` and
   * `/callback`, and a clinician who arrives through either one gets a session: EHR calls carry a
   * bearer token, and `fhirUser` supplies a real identity for attribution instead of a typed name.
   *
   * A launch is **required to write** and optional to read. With no session the requester's half of the
   * app is read-only — it still lists patients, responses and sent requests anonymously through
   * {@link responseServerUrl} — but it will not mint a request, file answers, amend them, create a
   * patient or write back extracted resources. See {@link canWriteToRecord} for why, and
   * {@link canMintRequest} for the one case that is gated on identity rather than on the write.
   *
   * The filler's half is untouched and must stay that way: somebody holding nothing but a link has no
   * credentials by construction. See `src/auth/smartSession.ts`.
   *
   * Requires {@link smartIssuerUrl} and {@link smartClientId}.
   */
  enableSmartLaunch: boolean;

  /**
   * Base URL of the SMART-enabled FHIR server to launch against.
   *
   * Must be a base that actually serves `.well-known/smart-configuration`, which is not the same
   * server as {@link responseServerUrl} even when they hold the same data. `proxy.smartforms.io/fhir`
   * answers that path with `HAPI-0302: Unknown resource type '.well-known'`; its
   * smart-launcher-v2 sibling `proxy.smartforms.io/v/r4/fhir` serves a real one.
   *
   * Also the allowlist for the `iss` a launch arrives with — see `issMatch` in `smartSession.ts`.
   * An `iss` that is not this issuer is refused rather than followed.
   */
  smartIssuerUrl: string | null;

  /**
   * OAuth client id, registered with the authorisation server.
   *
   * This is a **public** client: a static site can hold no secret, so there is nothing here to keep.
   * Confidentiality comes from PKCE, which `smartSession.ts` requires rather than merely offers.
   */
  smartClientId: string | null;

  /**
   * Scopes to request, space-separated. Null takes {@link DEFAULT_SMART_SCOPES}.
   *
   * Worth overriding only to narrow. Widening past what the app actually issues invites a consent
   * screen that overstates what it does.
   */
  smartScopes: string | null;
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
  // Off in the *fallback* even though the shipped config enables it: a config that failed to load must
  // hand out no write capability. See the field docs above.
  enableOneShotWrite: false,
  // Off in the *fallback*, on in the shipped config. A config that failed to load names no reliable
  // destination, and creating Conditions on a guessed server is worse than creating none.
  enableWriteBack: false,
  enablePrePopulate: false,
  writeSlotServerUrl: null,
  linkLifetimeDays: 30,
  publishRequestTasks: true,
  // Off in the *fallback*, and inert regardless without an issuer and a client id. See the field docs.
  enableSmartLaunch: false,
  smartIssuerUrl: null,
  smartClientId: null,
  smartScopes: null
};

/**
 * What the app asks for, and no more.
 *
 * `user/` rather than `patient/` because `/patients` and `/responses` search across the server; a
 * `patient/` grant is scoped to one patient in context and would leave both routes empty. The
 * permission letters track what the code actually issues, and the split between the two groups below
 * is a real one: the app **never updates or deletes** the resources it authors, and needs `u` only on
 * the clinical resources form data extraction writes back.
 *
 * `online_access` rather than `offline_access` — this is a foreground clinician tool with no backend
 * to hold a long-lived refresh token, so a refresh that outlives the session is a liability, not a
 * feature.
 *
 * `launch` is swapped for `launch/patient` on a standalone launch, where there is no EHR context to
 * inherit and the authorisation server has to ask who the patient is. See `buildScopes`.
 */
export const DEFAULT_SMART_SCOPES = [
  'launch',
  'openid',
  'fhirUser',
  'online_access',
  'user/Patient.crs',
  'user/QuestionnaireResponse.crs',
  'user/Task.crs',
  'user/Provenance.cr',
  /*
   * `fhirUser` yields a *reference*, not a name, and `fetchUserDisplay` reads the resource to turn
   * `Practitioner/123` into something a clinician recognises. Without this the read is refused and the
   * session badge falls back to showing the bare reference — which a permissive sandbox hides, because
   * it grants `user/*.*` and never exercises the gap.
   */
  'user/Practitioner.r',

  /*
   * Form data extraction — see `src/fhir/extract.ts`.
   *
   * `u` as well as `c`, and this is the only place the app asks for it. Template-based extraction
   * emits `PUT` and `PATCH` entries: a form that records a resolved allergy is amending a record that
   * already exists, and there is no create-only way to express that. The grant stays narrow in the
   * other direction — no `d` anywhere, and no `u` on `Patient`, `QuestionnaireResponse`, `Task` or
   * `Provenance` above, which the app still only ever creates. The amendment path exists precisely so
   * a stored response never has to be updated in place.
   *
   * Extraction runs only when a Questionnaire declares it, so on a deployment whose forms declare none
   * these scopes are asked for and never exercised. Narrow them with `smartScopes` if that is the case
   * and your authorisation server would rather not grant them.
   */
  'user/Condition.cu',
  'user/Observation.cu',
  'user/AllergyIntolerance.cu',
  'user/MedicationStatement.cu',
  'user/Immunization.cu',
  'user/Procedure.cu',
  'user/Encounter.cu'
].join(' ');

/**
 * The extra reads pre-population needs, on top of {@link DEFAULT_SMART_SCOPES}.
 *
 * ## Why this list exists at all, and why it is not obvious
 *
 * The extraction group above grants `user/Condition.cu`, `user/Observation.cu` and five more. In
 * SMART v2 those letters are the whole permission: `c` create, `r` read, `u` update, `d` delete,
 * `s` search. So `.cu` is **create and update, with no read and no search** — the app writes those
 * resources and has never needed to look at them.
 *
 * Pre-population does nothing but look at them. A form's `x-fhir-query` is a search
 * (`Condition?patient={{%patient.id}}&…`), so every type in the extraction group needs `r` and `s`
 * added. Each one reads as already covered and is not, which is the trap: the failure is not an
 * error a clinician sees, it is an **empty answer**, indistinguishable from a record that holds
 * nothing. They send the form believing the patient has no recorded conditions.
 *
 * It stays hidden on the default sandbox, which grants `user/*.*` and therefore never exercises the
 * gap — the same blind spot `user/Practitioner.r` above already records.
 *
 * ## How the list was derived
 *
 * By reading every `x-fhir-query` expression in the 138 Questionnaires on the default forms server
 * and counting the resource types they name, rather than by guessing what a form might want:
 *
 * | | forms querying it | |
 * | --- | --- | --- |
 * | `Observation` | 31 | in the extraction group, `.cu` only |
 * | `Condition` | 25 | in the extraction group, `.cu` only |
 * | `AllergyIntolerance` | 12 | in the extraction group, `.cu` only |
 * | `PractitionerRole` | 9 | not granted at all |
 * | `MedicationStatement` | 9 | in the extraction group, `.cu` only |
 * | `QuestionnaireResponse` | 9 | already `.crs` — nothing to add |
 * | `Immunization` | 7 | in the extraction group, `.cu` only |
 * | `Encounter` | 6 | in the extraction group, `.cu` only |
 * | `MedicationRequest` | 5 | not granted at all |
 * | `Procedure` | 4 | in the extraction group, `.cu` only |
 * | `ServiceRequest` | 2 | not granted at all |
 * | `Device` | 1 | not granted at all |
 * | `Organization` | 1 | not granted at all |
 *
 * `Patient` is absent because it arrives through `launchContext`, not through a query.
 *
 * This is therefore a list about **the default catalogue**, not about pre-population in general —
 * another deployment's forms will ask for other types. That is what `smartScopes` is for, and a
 * deployment overriding it takes over this list wholesale.
 *
 * Requested only when {@link AppConfig.enablePrePopulate} is on, and merged letter-wise with the
 * group above so a launch asks `user/Condition.crus` once rather than `.cu` and `.rs` separately.
 * See `buildScopes` in `src/auth/scopes.ts`.
 */
export const PRE_POPULATE_SCOPES = [
  'user/Condition.rs',
  'user/Observation.rs',
  'user/AllergyIntolerance.rs',
  'user/MedicationStatement.rs',
  'user/MedicationRequest.rs',
  'user/Immunization.rs',
  'user/Procedure.rs',
  'user/Encounter.rs',
  'user/ServiceRequest.rs',
  'user/PractitionerRole.rs',
  'user/Organization.rs',
  'user/Device.rs'
].join(' ');

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
    isAbsentOr(candidate.enableOneShotWrite, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.enableWriteBack, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.enablePrePopulate, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.writeSlotServerUrl, (url) => url === null || isValidUrl(url)) &&
    isAbsentOr(candidate.publishRequestTasks, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.enableSmartLaunch, (flag) => typeof flag === 'boolean') &&
    isAbsentOr(candidate.smartIssuerUrl, (url) => url === null || isValidUrl(url)) &&
    isAbsentOr(
      candidate.smartClientId,
      (id) => id === null || (typeof id === 'string' && id.trim() !== '')
    ) &&
    isAbsentOr(
      candidate.smartScopes,
      (scopes) => scopes === null || (typeof scopes === 'string' && scopes.trim() !== '')
    ) &&
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

/**
 * Where a one-shot write slot is pre-allocated, or null if nowhere is configured.
 *
 * Falls back to `blobServerUrl` because a slot and an SHL payload are the same kind of thing: a
 * transient blob on a host nobody has to trust. It deliberately does **not** fall back to
 * `responseServerUrl` — that is the record, and staging answers off it is what lets a human review
 * them first.
 */
export function resolveWriteSlotServerUrl(config: AppConfig): string | null {
  return config.writeSlotServerUrl ?? config.blobServerUrl;
}

/**
 * Whether a one-shot write slot can be minted: the channel is enabled *and* there is somewhere to
 * pre-allocate the slot.
 *
 * The second half is what keeps {@link FALLBACK_CONFIG} safe, exactly as it does for
 * {@link canUseEncryptedReply}: a deployment whose config failed to load has no slot server and
 * therefore cannot hand out a write capability, whatever some future default does to the flag.
 */
export function canUseOneShotWrite(config: AppConfig): boolean {
  return config.enableOneShotWrite && resolveWriteSlotServerUrl(config) !== null;
}

/**
 * Whether a form can be filled from the record before the link is minted: the capability is enabled
 * *and* there is a launched session to read the record with.
 *
 * The second half is the same guard {@link canUseOneShotWrite} uses, and here it is doing more than
 * keeping {@link FALLBACK_CONFIG} safe. Anonymous population would in fact *work* — `useEhrServerUrl`
 * falls back to `responseServerUrl`, and the default sandbox is open — and it is refused anyway:
 * populating is a bulk clinical read, and doing it with no user identity, no authorisation decision
 * and no audit trail succeeds only because that particular sandbox happens not to care. Reading a
 * chart is the requester's capability, and the requester is the half that launched.
 *
 * This was the first place that argument was made, and {@link canWriteToRecord} now makes it for every
 * write as well. Kept separate rather than folded into it: this one is also gated on a config flag,
 * because reading a chart into a payload that leaves the building is a disclosure a deployment gets to
 * decline. Writing is not optional in the same way.
 */
export function canPrePopulate(
  config: AppConfig,
  session: { serverUrl: string } | null,
  ehrServerUrl: string | null
): boolean {
  return config.enablePrePopulate && session !== null && ehrServerUrl !== null;
}

/**
 * The one sentence every gated surface says, so they cannot drift apart.
 *
 * A sibling of `NO_DESTINATION_MESSAGE` in `src/fhir/submit.ts`, which answers the neighbouring
 * question: that one is "there is nowhere to write", this one is "you are not the sort of visitor who
 * may write".
 */
export const LAUNCH_REQUIRED_MESSAGE =
  'Sign in through your EHR to write to the record. Reading works without one.';

/**
 * Whether the app may write to the record: a launch, and somewhere to write it.
 *
 * ## Why a launch, when the write would often succeed without one
 *
 * The same reasoning {@link canPrePopulate} already applies to reading a chart, generalised to every
 * write this app makes on the requester's behalf — accepting answers, amending them, creating a
 * patient, and writing back the resources a form extracted.
 *
 * Anonymous writing does in fact *work*: `useEhrServerUrl` falls back to
 * {@link AppConfig.responseServerUrl} and the default sandbox accepts unauthenticated POSTs. It
 * succeeds only because that particular sandbox does not care. What lands is a clinical resource with
 * no user identity, no authorisation decision behind it, and a `Provenance` naming whoever typed a
 * name into a box — a claim rather than an attribution. On a real record that is not a lax
 * configuration, it is an unattributable write.
 *
 * ## What this deliberately does not gate
 *
 * **Reads.** `/patients`, `/responses` and `/requests` still list anonymously, so a deployment pointed
 * at a public sandbox is still browsable with no setup at all. A launch upgrades a read; it gates a
 * write.
 *
 * **The filler's half — and this is the constraint that shapes where the check goes.** Someone holding
 * nothing but a link has no account to log into, which is the whole design. So this is asked at the
 * requester's call sites and *never* inside `src/fhir/submit.ts`: `resolveDestinations` also serves
 * channel B, where a filler is invited by the invitation itself to write to the endpoint the
 * Questionnaire declares. A check in the fhir layer would refuse exactly the person the architecture
 * exists to serve.
 */
export function canWriteToRecord(
  session: { serverUrl: string } | null,
  ehrServerUrl: string | null
): boolean {
  return session !== null && ehrServerUrl !== null;
}

/**
 * Whether a request may be minted.
 *
 * A launch, and nothing else — unlike {@link canWriteToRecord} this asks for no destination, because a
 * request is not always a write. With `publishRequestTasks` off, minting touches the EHR not at all:
 * the payload goes to the blob host, which is untrusted by design.
 *
 * It is gated anyway, on the other half of what a launch supplies. An invitation says who it is from,
 * and `requesterDisplay` without a session is {@link AppConfig.senderName} — a string from a config
 * file, identical on every request the deployment ever sends. The filler is being asked to hand over
 * health information on the strength of that name. A launch makes it the launched user, vouched for by
 * an authorisation server, which is the difference between an attribution and an assertion.
 */
export function canMintRequest(session: { serverUrl: string } | null): boolean {
  return session !== null;
}

/**
 * Whether a SMART launch can be attempted: the channel is enabled *and* it is pointed somewhere with
 * an identity to present.
 *
 * The second half is the same guard {@link canUseEncryptedReply} and {@link canUseOneShotWrite} use,
 * for the same reason: a deployment whose config failed to load has no issuer and no client id, so it
 * cannot start a flow whatever a future default does to the flag.
 */
export function canUseSmartLaunch(config: AppConfig): boolean {
  return (
    config.enableSmartLaunch && config.smartIssuerUrl !== null && config.smartClientId !== null
  );
}

/**
 * Whether sent requests can be recorded on, and listed back from, the EHR.
 *
 * `ehrServerUrl` is the *resolved* base — a launched server when there is a session, configuration
 * otherwise — because a launch supplies a server just as validly as config does, and reading only
 * `responseServerUrl` here would leave a launched deployment unable to track anything.
 */
export function canTrackRequests(config: AppConfig, ehrServerUrl?: string | null): boolean {
  return config.publishRequestTasks && (ehrServerUrl ?? config.responseServerUrl) !== null;
}
