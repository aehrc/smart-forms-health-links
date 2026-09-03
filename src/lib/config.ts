/**
 * Runtime configuration, fetched from `/config.json` at boot.
 *
 * This mirrors the approach used by `apps/smart-forms-app`
 * (`src/features/configChecker/utils/config.ts`) in the smart-forms monorepo: config is fetched
 * at runtime rather than baked in at build time, so the same built artifact can be deployed
 * against different terminology servers.
 *
 * What is *not* here is the point. This file used to name three FHIR servers - a forms
 * catalogue, a response server and a blob host - because the app had no launch context and had
 * to be told where everything was. It now has one: the requester signs in to a clinical system
 * and reads and writes that system through the BFF proxy at `/api/fhir` (FR-004). There is
 * nothing left to configure about which server holds the data, because the answer is always
 * "the one you launched from", and the permitted servers are the deployment's issuer registry on
 * the server side rather than a URL the browser could be pointed at.
 *
 * What remains is of two kinds. Four settings describe the deployment itself - a terminology
 * server, the origin links are built on, who requests appear to come from, and how long a link
 * stays openable. The rest are **capability flags**, and they survived the move to a launched
 * server because they answer a question the launch does not: not *where* the data lives, but
 * which optional things this deployment is willing to do with it.
 * @author John Grimes
 */

/** Which codec mints links. Decoding always accepts every registered codec. */
export type LinkCodecId = "bespoke" | "shl";

export interface AppConfig {
  /** FHIR terminology server for ValueSet expansion, passed through to the renderer. */
  terminologyServerUrl: string;

  /**
   * Which codec creates links.
   *
   * `shl` is the only one that still mints; `bespoke` is decode-only and setting it here is an
   * error. Decoding always accepts every registered codec, so old `sfhl:/` links keep opening.
   */
  linkCodec: LinkCodecId;

  /**
   * Origin used when building links, e.g. `https://links.example.org`.
   * When null, `window.location.origin` is used, which is what you want in dev.
   */
  linkBaseUrl: string | null;

  /**
   * Who requests appear to come from, e.g. `"Parkview Medical Centre"`.
   *
   * A fallback rather than the source of truth: a launched session knows who is signed in, and
   * that name is the one written to `Task.requester.display`. This covers the case where the
   * launch disclosed no user, which is legal - an invitation that cannot say who sent it is one
   * a patient has every reason to decline.
   */
  senderName: string | null;

  /**
   * How long a request stays openable, in days. `null` means no expiry.
   *
   * Sets the SHL payload's `exp`. Matches the 30-day default Platypus uses for its own
   * invitations.
   */
  linkLifetimeDays: number | null;

  /**
   * Offer the one-shot write channel (channel D) on requests this app mints.
   *
   * The slot is now pre-allocated **on the BFF** rather than on a third-party blob host, which is
   * the one thing about this channel the move to a launched server changed. Everything that made
   * it worth keeping is unchanged: each request pre-allocates an empty `QuestionnaireResponse`,
   * the invitation names its absolute URL, an `If-Match` ETag and a write token, and a filler
   * holding the link may `PUT` the completed answers there **once** - the second attempt collides
   * with the first version and is refused. That "once" is a property of the wire rather than of
   * trust, which is precisely what the direct-send channel cannot offer.
   *
   * It is the **fallback**, not the primary path. A link minted against a server with Backend
   * Services gets the direct send, whose window opens when the filler opens the link. This is
   * what answers the case that one cannot serve: a destination with no Backend Services, or a
   * send window that has already closed. Keeping both is why `docs/shl-form-reply-channel.md`
   * still documents two live channels rather than one.
   *
   * Answers landing here are staged, not filed: they are collected, shown to a human, and only
   * then written to the record. That review gate is the difference between this channel and the
   * refused channel B, and it is why the slot must not live on the record server.
   */
  enableOneShotWrite: boolean;

  /**
   * Offer to write the resources these answers imply into the patient record.
   *
   * SDC form data extraction: a form's own templates say that "chest pain, since March" means a
   * `Condition`, and the reviewer ticks which of those belong on the record. It runs entirely in
   * the browser - no `$extract` server, no StructureMap engine - so this flag costs no
   * infrastructure.
   *
   * Off in the fallback for the same reason every other write capability is: a deployment whose
   * config failed to load should not start creating clinical resources.
   *
   * Inert for a form that declares no extraction, which is most of them. Turning it on does not
   * make the app write anything on its own - extraction is still reviewed, ticked and accepted by
   * a human, which is the posture the whole app takes.
   */
  enableWriteBack: boolean;

  /**
   * Fill a requested form from the record before the link is minted.
   *
   * SDC pre-population, moved to the only place this app can run it. `$populate` normally runs at
   * fill* time inside a launched app, resolving each item's `x-fhir-query` against the EHR just
   * before the form is drawn - which is impossible here, because the filler holds no credential
   * and has no path to our servers. That is the point of the design, not a gap in it.
   *
   * So population happens at **request** time, on the side that does have a launch context, and
   * the answers ride inside the encrypted payload. Nothing about the filler's position changes.
   *
   * **Weigh it differently for real data.** Its neighbours are *write* capabilities, gated because
   * they put data on somebody's server. This is a **disclosure** capability: it copies record
   * content into a payload that leaves the building and is readable by anyone holding the link. A
   * request stops being "a public questionnaire plus a name" and becomes an extract from a chart,
   * with its key in a QR code somebody can photograph. Turning it on is a decision about what a
   * leaked link would cost, and the answer differs by deployment.
   *
   * Two deliberate acts are still needed with the flag on: a launched session, and ticking the box
   * on the request itself. The flag makes the option visible, not automatic.
   *
   * Requires a launched session - see {@link canPrePopulate}.
   */
  enablePrePopulate: boolean;

  /**
   * Publish each request's `Task` to the launched server, so sent requests can be listed back.
   *
   * This only records *that* a request was sent: without it, `/requests` can only ever show what
   * the current browser created, because the reply key never leaves it.
   *
   * The published copy carries no reply slot, no key and no token - see `publishRequestTask`. What
   * it does put on the record server is the fact that a form was requested, for whom, and by whom,
   * so turn it off if that metadata should not be there.
   */
  publishRequestTasks: boolean;
}

export const FALLBACK_CONFIG: AppConfig = {
  terminologyServerUrl: "https://r4.ontoserver.csiro.au/fhir",
  linkCodec: "shl",
  linkBaseUrl: null,
  senderName: null,
  linkLifetimeDays: 30,
  enableOneShotWrite: false,
  enableWriteBack: false,
  enablePrePopulate: false,
  publishRequestTasks: false,
};

/**
 * Whether a value is an absolute `http` or `https` URL.
 * @param value the candidate
 * @returns true when it parses as one
 */
function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\/.+/.test(value.trim())) {
    return false;
  }

  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absent is fine and takes the fallback; present but the wrong shape is not.
 * @param value the candidate
 * @param valid the predicate to apply when the value is present
 * @returns true when the value is absent, or present and valid
 */
function isAbsentOr(
  value: unknown,
  valid: (candidate: unknown) => boolean,
): boolean {
  return value === undefined || valid(value);
}

/**
 * Whether a value is absent or a boolean.
 * @param value the candidate
 * @returns true when the value may be used as a capability flag
 */
function isAbsentOrBoolean(value: unknown): boolean {
  return isAbsentOr(value, (flag) => typeof flag === "boolean");
}

/**
 * Exported so tests can assert the shipped `public/config.json` actually validates.
 *
 * Fields added after the first release are optional: a config written before they existed is not
 * malformed, it just does not mention them, and {@link loadConfig} fills them from
 * {@link FALLBACK_CONFIG}. Rejecting it outright would discard the settings it *does* specify and
 * silently point a deployment somewhere else. Keys this app no longer honours are ignored for the
 * same reason: a config file left over from the anonymous-mode release is not a broken one.
 * @param value the parsed `config.json`
 * @returns true when every field it does declare is usable
 */
export function isAppConfig(value: unknown): value is Partial<AppConfig> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isValidUrl(candidate.terminologyServerUrl) &&
    (candidate.linkBaseUrl === null || isValidUrl(candidate.linkBaseUrl)) &&
    isAbsentOr(
      candidate.linkCodec,
      (codec) => codec === "shl" || codec === "bespoke",
    ) &&
    isAbsentOr(
      candidate.senderName,
      (name) =>
        name === null || (typeof name === "string" && name.trim() !== ""),
    ) &&
    isAbsentOr(
      candidate.linkLifetimeDays,
      (days) =>
        days === null ||
        (typeof days === "number" && Number.isFinite(days) && days > 0),
    ) &&
    isAbsentOrBoolean(candidate.enableOneShotWrite) &&
    isAbsentOrBoolean(candidate.enableWriteBack) &&
    isAbsentOrBoolean(candidate.enablePrePopulate) &&
    isAbsentOrBoolean(candidate.publishRequestTasks)
  );
}

/**
 * Load `/config.json`, falling back to {@link FALLBACK_CONFIG} if it is missing or malformed.
 *
 * A missing config is not fatal: nothing here decides where data is read from or written to, so
 * defaulting the terminology server and the link lifetime is a safe and useful behaviour. Every
 * capability flag defaults to off, so a config that failed to load hands out no capability it was
 * not explicitly asked for.
 * @returns the loaded configuration, merged over the fallback
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch("/config.json", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return FALLBACK_CONFIG;
    }

    const parsed: unknown = await response.json();
    if (!isAppConfig(parsed)) {
      console.warn("config.json is malformed, falling back to defaults");
      return FALLBACK_CONFIG;
    }

    // Merged rather than returned as-is, so a config predating a field gets that field's default
    // instead of `undefined`.
    return { ...FALLBACK_CONFIG, ...parsed };
  } catch {
    console.warn("config.json could not be loaded, falling back to defaults");
    return FALLBACK_CONFIG;
  }
}

/**
 * Origin that generated links point at.
 * @param config the loaded configuration
 * @returns the configured origin, or the browser's own
 */
export function resolveLinkBaseUrl(config: AppConfig): string {
  return config.linkBaseUrl ?? globalThis.location.origin;
}

/**
 * Epoch seconds at which a request minted now should stop being openable.
 * @param config the loaded configuration
 * @param now the current time in milliseconds, injectable for tests
 * @returns the expiry, or undefined when links do not expire
 */
export function resolveExpiry(
  config: AppConfig,
  now = Date.now(),
): number | undefined {
  if (config.linkLifetimeDays === null) {
    return undefined;
  }

  return Math.floor(now / 1000) + Math.round(config.linkLifetimeDays * 86_400);
}

/**
 * What to tell someone who has to launch before the thing they asked for can happen.
 *
 * One message, so every gated surface says the same thing for the same reason.
 */
export const LAUNCH_REQUIRED_MESSAGE =
  "Sign in to a clinical system to do this. Requests are sent, and answers are filed, with the authority of that session.";

/**
 * Whether the one-shot write channel may be offered on a request this app mints.
 *
 * Needs only the flag now. The slot used to need a host named in config, and that is exactly what
 * the BFF replaced: it pre-allocates the slot on the launched server's behalf and serves it, so
 * there is no longer a URL that could be missing.
 * @param config the loaded configuration
 * @returns true when the channel may be offered
 */
export function canUseOneShotWrite(config: AppConfig): boolean {
  return config.enableOneShotWrite;
}

/**
 * Whether a form may be pre-populated from the record before the link is minted.
 * @param config the loaded configuration
 * @param session the launched session, or null when nobody is signed in
 * @returns true when population may be offered
 */
export function canPrePopulate(config: AppConfig, session: unknown): boolean {
  return config.enablePrePopulate && session !== null;
}

/**
 * Whether this app may write to the patient record.
 *
 * A launched session and nothing else. Under the BFF there is no anonymous write to fall back to:
 * every write goes through the proxy, and the proxy has no authority to lend without a session.
 * @param session the launched session, or null when nobody is signed in
 * @returns true when a write may be attempted
 */
export function canWriteToRecord(session: unknown): boolean {
  return session !== null;
}

/**
 * Whether a request may be minted.
 *
 * Gated on identity rather than on the write: an invitation names who sent it, and one that
 * cannot is one a patient has every reason to decline.
 * @param session the launched session, or null when nobody is signed in
 * @returns true when a request may be minted
 */
export function canMintRequest(session: unknown): boolean {
  return session !== null;
}

/**
 * Whether sent requests can be listed back from the record server.
 * @param config the loaded configuration
 * @param session the launched session, or null when nobody is signed in
 * @returns true when `/requests` can show more than this browser's own history
 */
export function canTrackRequests(config: AppConfig, session: unknown): boolean {
  return config.publishRequestTasks && session !== null;
}
