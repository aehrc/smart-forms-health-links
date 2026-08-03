import type { Bundle } from 'fhir/r4';
import type { EncodeOptions, LinkCodec, LinkContent } from './codec';
import { extractFragment } from './codec';
import { decodeUtf8, encodeUtf8, fromBase64Url, toBase64Url } from './binary';
import { decryptJwe, encryptJwe, generateKey, keyFromBase64Url, keyToBase64Url } from './jwe';
import { JOSE_CONTENT_TYPE } from '@/fhir/blobStore';

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
 * Both hosting modes, because a link we read was probably not written by us. A filler app that hosts
 * its payload behind a proper manifest endpoint produces a `U`-less link, and that has to work here.
 *
 * ## What SHL does not do
 *
 * SHL is strictly one-directional and defines no submission channel, so a returned
 * QuestionnaireResponse is never *written* anywhere by its sender. It is published; the receiving app
 * pulls it, presents it for human review, and only then writes to its own server — see
 * `src/fhir/submit.ts`.
 */

const PREFIX = 'shlink:/';

/** SHL protocol version this codec implements. */
const SHL_VERSION = 1;

/** Identifies us in the manifest request, per the spec's `recipient` field. */
const RECIPIENT = 'Smart Forms Health Links';

/** The spec caps `label` at 80 characters. */
const MAX_LABEL_LENGTH = 80;

const FHIR_JSON = 'application/fhir+json';

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
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === 'string' && typeof candidate.key === 'string';
}

/** Parse and validate the base64url JSON payload that follows `shlink:/`. */
function decodePayload(fragment: string): ShlPayload {
  const body = fragment.slice(PREFIX.length);
  if (body === '') {
    throw new Error('SMART Health Link payload is empty.');
  }

  let parsed: unknown;
  try {
    // Unlike the bespoke codec, an SHL payload is plain base64url JSON with no compression.
    parsed = JSON.parse(decodeUtf8(fromBase64Url(body)));
  } catch (cause) {
    throw new Error('SMART Health Link payload is corrupt or truncated.', { cause });
  }

  if (!isShlPayload(parsed)) {
    throw new Error('SMART Health Link payload is missing `url` or `key`.');
  }

  if (parsed.v !== undefined && parsed.v > SHL_VERSION) {
    throw new Error(
      `This link uses SHL protocol v${parsed.v}, which this app does not support yet.`
    );
  }

  if (parsed.exp !== undefined && parsed.exp * 1000 < Date.now()) {
    throw new Error('This link has expired.');
  }

  return parsed;
}

async function fetchJwe(url: string): Promise<string> {
  /*
   * Deliberately no Accept header. A FHIR server hands back a `Binary` resource wrapper for
   * `application/fhir+json`, whereas the spec expects an unadorned GET to yield the JWE itself.
   */
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not retrieve the linked payload (${response.status} ${response.statusText}).`
    );
  }

  return (await response.text()).trim();
}

/** Fetch the manifest, for links without the `U` flag. */
async function fetchManifest(payload: ShlPayload, passcode?: string): Promise<ManifestFile[]> {
  const body: Record<string, unknown> = { recipient: RECIPIENT };
  if (passcode !== undefined) {
    body.passcode = passcode;
  }

  const response = await fetch(payload.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (response.status === 401) {
    let remaining: number | undefined;
    try {
      remaining = ((await response.json()) as { remainingAttempts?: number }).remainingAttempts;
    } catch {
      // The spec defines this body, but don't fail the error path over a missing one.
    }

    throw new Error(
      remaining === undefined
        ? 'This link requires a passcode.'
        : `Incorrect passcode. ${remaining} attempt(s) remaining.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Could not retrieve the link manifest (${response.status} ${response.statusText}).`
    );
  }

  const manifest = (await response.json()) as { files?: ManifestFile[] };
  if (!Array.isArray(manifest.files)) {
    throw new Error('Link manifest contained no `files` array.');
  }

  return manifest.files;
}

/** Decrypt one manifest file, whether it arrived embedded or by reference. */
async function readManifestFile(file: ManifestFile, key: Uint8Array): Promise<string> {
  const jwe = file.embedded ?? (file.location ? await fetchJwe(file.location) : undefined);
  if (jwe === undefined) {
    throw new Error('Link manifest file had neither `embedded` content nor a `location`.');
  }

  return decodeUtf8(await decryptJwe(jwe, key));
}

function bundleFromJson(text: string): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error('Decrypted payload was not valid JSON.', { cause });
  }

  const resourceType = (parsed as { resourceType?: string }).resourceType;
  if (resourceType !== 'Bundle') {
    throw new Error(
      `Expected a FHIR Bundle in the link payload, got ${resourceType ?? 'unknown content'}.`
    );
  }

  return parsed as Bundle;
}

export const shlCodec: LinkCodec = {
  id: 'shl',
  prefix: PREFIX,

  canDecode(linkOrFragment: string): boolean {
    return extractFragment(linkOrFragment).startsWith(PREFIX);
  },

  async encode(content: LinkContent, options: EncodeOptions): Promise<string> {
    const { blobStore } = options;
    if (!blobStore) {
      throw new Error(
        'Creating a SMART Health Link needs somewhere to host the encrypted payload. ' +
          'Pass a BlobStore in EncodeOptions.'
      );
    }

    const key = generateKey();
    const jwe = await encryptJwe(encodeUtf8(JSON.stringify(content.bundle)), key);
    const url = await blobStore.put(encodeUtf8(jwe), JOSE_CONTENT_TYPE);

    const payload: ShlPayload = {
      url,
      key: keyToBase64Url(key),
      // Single encrypted file retrieved by GET — no manifest server required.
      flag: 'U',
      v: SHL_VERSION
    };

    if (content.label) {
      payload.label = content.label.slice(0, MAX_LABEL_LENGTH);
    }

    if (options.expiresAt !== undefined) {
      payload.exp = options.expiresAt;
    }

    const encoded = toBase64Url(encodeUtf8(JSON.stringify(payload)));
    const base = options.baseUrl.replace(/\/+$/, '');

    return `${base}/view#${PREFIX}${encoded}`;
  },

  async decode(linkOrFragment: string): Promise<LinkContent> {
    const fragment = extractFragment(linkOrFragment);
    if (!fragment.startsWith(PREFIX)) {
      throw new Error('Not a SMART Health Link.');
    }

    const payload = decodePayload(fragment);
    const key = keyFromBase64Url(payload.key);

    // `U` means the url resolves straight to a single encrypted file; anything else means a manifest.
    if ((payload.flag ?? '').includes('U')) {
      const plaintext = decodeUtf8(await decryptJwe(await fetchJwe(payload.url), key));
      return { bundle: bundleFromJson(plaintext), label: payload.label };
    }

    const files = await fetchManifest(payload);
    const fhirFiles = files.filter((file) => file.contentType === FHIR_JSON);

    if (fhirFiles.length === 0) {
      const seen = files.map((file) => file.contentType).join(', ') || 'none';
      throw new Error(
        `This link contains no FHIR content that can be rendered as a form (content types: ${seen}).`
      );
    }

    if (files.length > 1) {
      // Better a console note than silently dropping content the sharer meant to send.
      console.warn(
        `Link contained ${files.length} files; using the first ${FHIR_JSON} and ignoring the rest.`
      );
    }

    return { bundle: bundleFromJson(await readManifestFile(fhirFiles[0], key)), label: payload.label };
  }
};
