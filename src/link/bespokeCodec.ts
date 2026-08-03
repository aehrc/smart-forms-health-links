import type { LinkCodec, LinkContent, EncodeOptions } from './codec';
import { extractFragment } from './codec';
import { decodeUtf8, deflateRaw, encodeUtf8, fromBase64Url, inflateRaw, toBase64Url } from './binary';
import type { Bundle } from 'fhir/r4';

/**
 * Phase 1 codec: the whole payload travels inside the URL fragment. No backend, no manifest.
 *
 * Link shape:  `https://host/view#sfhl:/<base64url(deflate-raw(json))>`
 *
 * The `sfhl:/` prefix intentionally parallels SHL's `shlink:/`. This is NOT a SMART Health Link and
 * third-party SHL wallets will not understand it — see `shlCodec.ts`.
 *
 * SECURITY: the payload is compressed, not encrypted. Anyone who photographs the QR or sees the URL
 * can read the answers. That is acceptable for demos and self-scanning; it is not acceptable for
 * real patient data, which is exactly what Phase 2 addresses.
 */

const PREFIX = 'sfhl:/';
const VERSION = 1;

interface BespokePayload {
  /** Payload format version, so future changes stay decodable. */
  v: number;
  label?: string;
  content: Bundle;
}

function isBespokePayload(value: unknown): value is BespokePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const content = candidate.content as Record<string, unknown> | undefined;
  return typeof candidate.v === 'number' && content?.resourceType === 'Bundle';
}

export const bespokeCodec: LinkCodec = {
  id: 'bespoke',
  prefix: PREFIX,

  canDecode(linkOrFragment: string): boolean {
    return extractFragment(linkOrFragment).startsWith(PREFIX);
  },

  async encode(content: LinkContent, options: EncodeOptions): Promise<string> {
    const payload: BespokePayload = {
      v: VERSION,
      label: content.label,
      content: content.bundle
    };

    const compressed = await deflateRaw(encodeUtf8(JSON.stringify(payload)));
    const base = options.baseUrl.replace(/\/+$/, '');

    return `${base}/view#${PREFIX}${toBase64Url(compressed)}`;
  },

  async decode(linkOrFragment: string): Promise<LinkContent> {
    const fragment = extractFragment(linkOrFragment);
    if (!fragment.startsWith(PREFIX)) {
      throw new Error('Not a Smart Forms link.');
    }

    const body = fragment.slice(PREFIX.length);
    if (body === '') {
      throw new Error('Link payload is empty.');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(decodeUtf8(await inflateRaw(fromBase64Url(body))));
    } catch (cause) {
      throw new Error('Link payload is corrupt or truncated.', { cause });
    }

    if (!isBespokePayload(payload)) {
      throw new Error('Link payload is not in the expected format.');
    }

    if (payload.v > VERSION) {
      throw new Error(
        `This link was created by a newer version of the app (format v${payload.v}).`
      );
    }

    return { bundle: payload.content, label: payload.label };
  }
};
