import { GRANT_CONTENT_TYPE, parseGrant } from "./apiAccess";
import { decodeUtf8, fromBase64Url } from "./binary";
import {
  bundleFromJson,
  extractFragment,
  mergeBundles,
  PasscodeRequiredError,
} from "./codec";
import { decryptJwe, keyFromBase64Url } from "./jwe";

import type { ReceivedGrant } from "./apiAccess";
import type { DecodeOptions, LinkCodec, LinkContent } from "./codec";
import type { Bundle } from "fhir/r4";

/**
 * SMART Health Links - https://docs.smarthealthit.org/smart-health-links/spec/
 *
 * The link carries no clinical data, only a pointer and a key:
 *
 *   shlink:/BASE64URL({"url": "...", "key": "...", "flag": "U", "label": "...", "exp": 123})
 *
 * presented either bare or, as here, in the fragment of a viewer URL
 * (`https://viewer.example.org/view#shlink:/...`), which is the form the spec itself uses.
 *
 * ## This codec only reads
 *
 * There is no `encode` here any more, and its absence is the architecture rather than a gap.
 * Hosting an SHL payload means being a manifest server, and this deployment's manifest server is
 * its own BFF: a requester's invitation is minted, published and hosted by
 * `POST /api/invitations` under the session's authority, and the browser is handed a finished
 * `shlink:/` (`contracts/http-api.md`). Minting from the page would mean parking transactional
 * data on a third-party blob host, which is exactly what this feature removed (FR-013).
 *
 * ## What this codec reads
 *
 * Both hosting modes, because a link we read was probably not written by us - and, increasingly,
 * is* not: the primary return path is now a filler minting its own link and the requester scanning
 * it back. A filler that hosts its payload behind a proper manifest endpoint produces a `U`-less
 * link, and that has to work here. Concretely, reading is tolerant in four ways:
 *
 *  - a manifest file may hold a bare FHIR resource rather than a Bundle, and is normalised;
 *  - *every* `application/fhir+json` file is read and merged, not just the first, because a payload
 *    split across files (answers here, attribution there) is one payload, not a choice;
 *  - a `P`-flagged link asks for a passcode instead of failing; and
 *  - a file that will not decrypt costs its own content, not the whole link.
 *
 * What was dropped is reported in {@link LinkContent.warnings} rather than the console: the only
 * person who can judge whether a skipped file mattered is the one reading the answers.
 *
 * ## What SHL does not do
 *
 * SHL is strictly one-directional and defines no submission channel, so a returned
 * QuestionnaireResponse is never *written* anywhere by its sender. It is published; the receiving app
 * pulls it, presents it for human review, and only then writes to its own server - see
 * `src/fhir/submit.ts`.
 */

const PREFIX = "shlink:/";

/** SHL protocol version this codec implements. */
const SHL_VERSION = 1;

/** Identifies us to the host, per the spec's `recipient`: in the manifest body, or on a `U`-flag `GET`. */
const RECIPIENT = "Smart Forms Health Links";

const FHIR_JSON = "application/fhir+json";

interface ShlPayload {
  url: string;
  key: string;
  exp?: number;
  flag?: string;
  label?: string;
  v?: number;
}

interface ManifestFile {
  contentType: string;
  embedded?: string;
  location?: string;
}

function isShlPayload(value: unknown): value is ShlPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === "string" && typeof candidate.key === "string";
}

/**
 * Parse and validate the base64url JSON payload that follows `shlink:/`.
 * @param fragment
 */
function decodePayload(fragment: string): ShlPayload {
  const body = fragment.slice(PREFIX.length);
  if (body === "") {
    throw new Error("SMART Health Link payload is empty.");
  }

  let parsed: unknown;
  try {
    // Unlike the bespoke codec, an SHL payload is plain base64url JSON with no compression.
    parsed = JSON.parse(decodeUtf8(fromBase64Url(body)));
  } catch (error) {
    throw new Error("SMART Health Link payload is corrupt or truncated.", {
      cause: error,
    });
  }

  if (!isShlPayload(parsed)) {
    throw new Error("SMART Health Link payload is missing `url` or `key`.");
  }

  if (parsed.v !== undefined && parsed.v > SHL_VERSION) {
    throw new Error(
      `This link uses SHL protocol v${parsed.v}, which this app does not support yet.`,
    );
  }

  if (parsed.exp !== undefined && parsed.exp * 1000 < Date.now()) {
    throw new Error("This link has expired.");
  }

  return parsed;
}

/**
 * Add `recipient` to a `U`-flag URL, keeping any query string the host already put there.
 * @param url the link's `url`
 * @param recipient who is reading
 * @returns the URL to `GET`
 */
function withRecipient(url: string, recipient: string): string {
  const target = new URL(url);
  target.searchParams.set("recipient", recipient);
  return target.href;
}

/**
 * Fetch one encrypted file by plain `GET`.
 *
 * Two callers, and they differ in exactly one respect. A `U`-flag link's `url` is retrieved with
 * the `recipient` query parameter, because the spec makes it required there and a conformant host
 * is entitled to refuse a request without it - which is what a patient app's relay, logging each
 * access, will do. A manifest file's `location` is retrieved with nothing added, because the spec
 * asks for no parameters there and a location is typically a signed URL whose signature covers
 * the query string.
 * @param url the URL to retrieve
 * @param recipient who is reading, for a `U`-flag `GET`; omitted for a manifest `location`
 * @returns the JWE compact serialisation, trimmed
 */
async function fetchJwe(url: string, recipient?: string): Promise<string> {
  /*
   * Deliberately no Accept header. A FHIR server hands back a `Binary` resource wrapper for
   * `application/fhir+json`, whereas the spec expects an unadorned GET to yield the JWE itself.
   */
  let response = await fetch(
    recipient === undefined ? url : withRecipient(url, recipient),
  );

  /*
   * Strict-host tolerance, matching Platypus's `fetchDirectFile`. A general-purpose FHIR server
   * answers an unrecognised parameter with `400` rather than ignoring it, so a payload parked on a
   * `Binary` - which is where this app itself used to park them - is unreachable to a conformant
   * reader. Retry the bare URL once, and only on `400`: a `404` means the link is gone, and
   * retrying it would double every request for a revoked link. All the retry drops is a
   * self-declared name the host was always free to ignore.
   */
  if (recipient !== undefined && response.status === 400) {
    response = await fetch(url);
  }

  if (!response.ok) {
    throw new Error(
      `Could not retrieve the linked payload (${response.status} ${response.statusText}).`,
    );
  }

  const body = await response.text();
  return body.trim();
}

/**
 * Fetch the manifest, for links without the `U` flag.
 * @param payload
 * @param options
 */
async function fetchManifest(
  payload: ShlPayload,
  options: DecodeOptions = {},
): Promise<ManifestFile[]> {
  const body: Record<string, unknown> = {
    recipient: options.recipient ?? RECIPIENT,
  };
  if (options.passcode !== undefined) {
    body.passcode = options.passcode;
  }

  const response = await fetch(payload.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    let remaining: number | undefined;
    try {
      remaining = ((await response.json()) as { remainingAttempts?: number })
        .remainingAttempts;
    } catch {
      // The spec defines this body, but don't fail the error path over a missing one.
    }

    // Typed, so the caller can prompt rather than dead-end. See `PasscodeRequiredError`.
    throw new PasscodeRequiredError({
      remainingAttempts: remaining,
      wasAttempted: options.passcode !== undefined,
    });
  }

  if (!response.ok) {
    throw new Error(
      `Could not retrieve the link manifest (${response.status} ${response.statusText}).`,
    );
  }

  const manifest = (await response.json()) as { files?: ManifestFile[] };
  if (!Array.isArray(manifest.files)) {
    throw new TypeError("Link manifest contained no `files` array.");
  }

  return manifest.files;
}

/**
 * Decrypt one manifest file, whether it arrived embedded or by reference.
 * @param file
 * @param key
 */
async function readManifestFile(
  file: ManifestFile,
  key: Uint8Array,
): Promise<string> {
  const jwe =
    file.embedded ??
    (file.location ? await fetchJwe(file.location) : undefined);
  if (jwe === undefined) {
    throw new Error(
      "Link manifest file had neither `embedded` content nor a `location`.",
    );
  }

  return decodeUtf8(await decryptJwe(jwe, key));
}

/**
 * A content type without its parameters.
 *
 * `application/fhir+json;charset=utf-8` is the same content type as `application/fhir+json`, and a
 * strict equality check silently discards it.
 * @param contentType the content type as the manifest declared it
 * @returns the type and subtype, lower-cased
 */
function baseContentType(contentType: string | undefined): string {
  return (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
}

/**
 * Read the API access grant, when the manifest carried one.
 *
 * Everything here is a tolerance rule rather than a failure path. A grant is a capability, not
 * content: a filler that cannot read one simply has no direct channel and returns the answers as
 * a link instead, so an undecryptable or malformed grant file yields *no grant* and no warning
 * (FR-020). A warning would be worse than silence - it would tell the person filling the form
 * about a file they cannot act on, when the absence of the send affordance already says
 * everything there is to say.
 * @param files the manifest's files
 * @param key the link key
 * @returns the grant with the moment it was read, or undefined when there is none to have
 */
async function readManifestGrant(
  files: ManifestFile[],
  key: Uint8Array,
): Promise<ReceivedGrant | undefined> {
  for (const file of files) {
    if (baseContentType(file.contentType) !== GRANT_CONTENT_TYPE) {
      continue;
    }

    try {
      const grant = parseGrant(await readManifestFile(file, key));
      if (grant) {
        return { grant, receivedAt: Date.now() };
      }
    } catch {
      // A grant that will not decrypt is a grant this reader does not have. Nothing to say.
    }
  }

  return undefined;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Read every FHIR file in a manifest and merge them into one Bundle.
 *
 * Failure policy is per-file: keep what decoded, note what did not, and throw only when *nothing*
 * did. One corrupt file in a five-file manifest must not hide the answers in the other four - but a
 * manifest where everything failed has to be an error, or the caller gets an empty Bundle and
 * reports "no answers" for what is really a broken link.
 *
 * The grant file is dispatched away from here by content type before anything is read. It is not
 * a file "this app cannot render as a form" - it is not content at all - so counting it as
 * skipped would report a healthy two-file manifest as partially unreadable, and feeding it to
 * {@link bundleFromJson} would put a bearer token in the Bundle the form is built from.
 * @param files
 * @param key
 */
async function readManifestBundle(
  files: ManifestFile[],
  key: Uint8Array,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const warnings: string[] = [];
  const payload = files.filter(
    (file) => baseContentType(file.contentType) !== GRANT_CONTENT_TYPE,
  );

  const skipped = payload.filter(
    (file) => baseContentType(file.contentType) !== FHIR_JSON,
  );
  if (skipped.length > 0) {
    warnings.push(
      `Ignored ${skipped.length} file(s) this app cannot render as a form: ` +
        `${skipped.map((file) => file.contentType || "unknown type").join(", ")}.`,
    );
  }

  const fhirFiles = payload.filter(
    (file) => baseContentType(file.contentType) === FHIR_JSON,
  );
  if (fhirFiles.length === 0) {
    const seen = payload.map((file) => file.contentType).join(", ") || "none";
    throw new Error(
      `This link contains no FHIR content that can be rendered as a form (content types: ${seen}).`,
    );
  }

  const bundles: Bundle[] = [];
  let firstCause: unknown;

  for (const [index, file] of fhirFiles.entries()) {
    try {
      bundles.push(bundleFromJson(await readManifestFile(file, key)));
    } catch (error) {
      firstCause ??= error;
      warnings.push(
        `File ${index + 1} of ${fhirFiles.length} could not be read: ${describeError(error)}`,
      );
    }
  }

  if (bundles.length === 0) {
    throw new Error(
      `Nothing in this link could be read. ${describeError(firstCause)}`,
      {
        cause: firstCause,
      },
    );
  }

  return { bundle: mergeBundles(bundles), warnings };
}

export const shlCodec: LinkCodec = {
  id: "shl",
  prefix: PREFIX,

  canDecode(linkOrFragment: string): boolean {
    return extractFragment(linkOrFragment).startsWith(PREFIX);
  },

  async decode(
    linkOrFragment: string,
    options: DecodeOptions = {},
  ): Promise<LinkContent> {
    const fragment = extractFragment(linkOrFragment);
    if (!fragment.startsWith(PREFIX)) {
      throw new Error("Not a SMART Health Link.");
    }

    const payload = decodePayload(fragment);
    const key = keyFromBase64Url(payload.key);
    const flag = payload.flag ?? "";

    // `U` means the url resolves straight to a single encrypted file; anything else means a manifest.
    if (flag.includes("U")) {
      const plaintext = decodeUtf8(
        await decryptJwe(
          await fetchJwe(payload.url, options.recipient ?? RECIPIENT),
          key,
        ),
      );
      return { bundle: bundleFromJson(plaintext), label: payload.label };
    }

    /*
     * Ask before knocking. A manifest server is entitled to count a passcode-less request as a
     * failed attempt and lock the link permanently, so burning one of a patient's attempts to
     * discover a fact the payload already states would be inexcusable.
     */
    if (flag.includes("P") && options.passcode === undefined) {
      throw new PasscodeRequiredError({ wasAttempted: false });
    }

    /*
     * One fetch, two readings. The manifest is retrieved once and both the payload and the grant
     * are read out of the same file list: a second fetch would mint a second grant on the
     * producer's side (`server/shl/manifest.ts` mints per fetch), leaving the filler holding a
     * token the destination has no reason to honour more than once.
     */
    const files = await fetchManifest(payload, options);
    const { bundle, warnings } = await readManifestBundle(files, key);
    return {
      bundle,
      label: payload.label,
      warnings: warnings.length > 0 ? warnings : undefined,
      apiAccess: await readManifestGrant(files, key),
    };
  },
};
