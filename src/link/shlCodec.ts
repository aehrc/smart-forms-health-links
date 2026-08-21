import { decodeUtf8, encodeUtf8, fromBase64Url, toBase64Url } from "./binary";
import {
  bundleFromJson,
  extractFragment,
  mergeBundles,
  PasscodeRequiredError,
} from "./codec";
import {
  decryptJwe,
  encryptJwe,
  generateKey,
  keyFromBase64Url,
  keyToBase64Url,
} from "./jwe";

import type {
  DecodeOptions,
  EncodeOptions,
  LinkCodec,
  LinkContent,
} from "./codec";
import type { Bundle } from "fhir/r4";

import { JOSE_CONTENT_TYPE } from "@/fhir/blobStore";

/**
 * SMART Health Links — https://docs.smarthealthit.org/smart-health-links/spec/
 *
 * The link carries no clinical data, only a pointer and a key:
 *
 *   shlink:/BASE64URL({"url": "...", "key": "...", "flag": "U", "label": "...", "exp": 123})
 *
 * presented either bare or, as here, in the fragment of a viewer URL —
 * `https://viewer.example.org/view#shlink:/...` — which is the form the spec itself uses.
 *
 * ## What this codec writes
 *
 * Always the `U` flag: a single encrypted file fetched with a plain `GET`. That needs only a static
 * file host rather than a manifest service, which is why the payload can live as a FHIR `Binary` on
 * the forms server with no new infrastructure. The cost is real and worth stating plainly: **`U`
 * cannot be combined with `P`, so these links have no passcode**, and they can be neither revoked
 * nor varied per recipient.
 *
 * ## What this codec reads
 *
 * Both hosting modes, because a link we read was probably not written by us — and, increasingly,
 * *is* not: the primary return path is now a filler minting its own link and the requester scanning
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
 * pulls it, presents it for human review, and only then writes to its own server — see
 * `src/fhir/submit.ts`.
 */

const PREFIX = "shlink:/";

/** SHL protocol version this codec implements. */
const SHL_VERSION = 1;

/** Identifies us in the manifest request, per the spec's `recipient` field. */
const RECIPIENT = "Smart Forms Health Links";

/** The spec caps `label` at 80 characters. */
const MAX_LABEL_LENGTH = 80;

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

/** Parse and validate the base64url JSON payload that follows `shlink:/`. */
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

async function fetchJwe(url: string): Promise<string> {
  /*
   * Deliberately no Accept header. A FHIR server hands back a `Binary` resource wrapper for
   * `application/fhir+json`, whereas the spec expects an unadorned GET to yield the JWE itself.
   *
   * ⚠️ KNOWN DEFECT: the spec also makes `recipient` *required* on this GET, and we send it only on
   * the manifest path below. Omitting it here is non-conformant and fails against a host that
   * insists on it — and it is why the unopenable links described in `docs/u-flag-hosting.md` still
   * work in our own viewer. Fix both halves together.
   */
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not retrieve the linked payload (${response.status} ${response.statusText}).`,
    );
  }

  return (await response.text()).trim();
}

/** Fetch the manifest, for links without the `U` flag. */
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

/** Decrypt one manifest file, whether it arrived embedded or by reference. */
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
 * Whether a manifest file holds FHIR JSON.
 *
 * Compared after stripping any `;charset=…` parameter, because `application/fhir+json;charset=utf-8`
 * is the same content type and a strict equality check silently discards it.
 */
function isFhirJson(contentType: string | undefined): boolean {
  return (
    (contentType ?? "").split(";", 1)[0].trim().toLowerCase() === FHIR_JSON
  );
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Read every FHIR file in a manifest and merge them into one Bundle.
 *
 * Failure policy is per-file: keep what decoded, note what did not, and throw only when *nothing*
 * did. One corrupt file in a five-file manifest must not hide the answers in the other four — but a
 * manifest where everything failed has to be an error, or the caller gets an empty Bundle and
 * reports "no answers" for what is really a broken link.
 */
async function readManifestBundle(
  files: ManifestFile[],
  key: Uint8Array,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const warnings: string[] = [];

  const skipped = files.filter((file) => !isFhirJson(file.contentType));
  if (skipped.length > 0) {
    warnings.push(
      `Ignored ${skipped.length} file(s) this app cannot render as a form: ` +
        `${skipped.map((file) => file.contentType || "unknown type").join(", ")}.`,
    );
  }

  const fhirFiles = files.filter((file) => isFhirJson(file.contentType));
  if (fhirFiles.length === 0) {
    const seen = files.map((file) => file.contentType).join(", ") || "none";
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

  async encode(content: LinkContent, options: EncodeOptions): Promise<string> {
    const { blobStore } = options;
    if (!blobStore) {
      throw new Error(
        "Creating a SMART Health Link needs somewhere to host the encrypted payload. " +
          "Pass a BlobStore in EncodeOptions.",
      );
    }

    const key = generateKey();
    const jwe = await encryptJwe(
      encodeUtf8(JSON.stringify(content.bundle)),
      key,
    );
    const url = await blobStore.put(encodeUtf8(jwe), JOSE_CONTENT_TYPE);

    const payload: ShlPayload = {
      url,
      key: keyToBase64Url(key),
      // Single encrypted file retrieved by GET — no manifest server required.
      flag: "U",
      v: SHL_VERSION,
    };

    if (content.label) {
      payload.label = content.label.slice(0, MAX_LABEL_LENGTH);
    }

    if (options.expiresAt !== undefined) {
      payload.exp = options.expiresAt;
    }

    const encoded = toBase64Url(encodeUtf8(JSON.stringify(payload)));
    const base = options.baseUrl.replace(/\/+$/, "");

    return `${base}/view#${PREFIX}${encoded}`;
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
        await decryptJwe(await fetchJwe(payload.url), key),
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

    const { bundle, warnings } = await readManifestBundle(
      await fetchManifest(payload, options),
      key,
    );
    return {
      bundle,
      label: payload.label,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};
