import {
  decodeUtf8,
  deflateRaw,
  encodeUtf8,
  fromBase64Url,
  inflateRaw,
  toBase64Url,
} from "./binary";
import { extractFragment } from "./codec";

import type { LinkCodec, LinkContent, EncodeOptions } from "./codec";
import type { Bundle } from "fhir/r4";

/**
 * Legacy codec, **decode-only**: the whole payload travels inside the URL fragment.
 *
 * Link shape:  `https://host/view#sfhl:/<base64url(deflate-raw(json))>`
 *
 * The `sfhl:/` prefix intentionally parallels SHL's `shlink:/`. This is NOT a SMART Health Link and
 * third-party SHL wallets will not understand it — see `shlCodec.ts`.
 *
 * SECURITY: the payload is compressed, not encrypted. Anyone who photographs the QR or sees the URL
 * can read the answers. That is why nothing mints these any more: it existed as the only return path
 * open to an app with no server of its own, and the SHL codec now fills that role properly.
 *
 * Links already in the wild keep opening, which is the whole point of retiring a transport rather
 * than deleting it — `decodingCodec` still considers this codec, `encodingCodec` refuses it.
 */

const PREFIX = "sfhl:/";
const VERSION = 1;

interface BespokePayload {
  /** Payload format version, so future changes stay decodable. */
  v: number;
  label?: string;
  content: Bundle;
}

function isBespokePayload(value: unknown): value is BespokePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const content = candidate.content as Record<string, unknown> | undefined;
  return typeof candidate.v === "number" && content?.resourceType === "Bundle";
}

export const bespokeCodec: LinkCodec = {
  id: "bespoke",
  prefix: PREFIX,
  decodeOnly: true,

  canDecode(linkOrFragment: string): boolean {
    return extractFragment(linkOrFragment).startsWith(PREFIX);
  },

  /**
   * @deprecated Nothing in the app mints `sfhl:/` links; `encodingCodec` refuses this codec. It is
   * kept because `check:roundtrip` and `check:e2e` need to *produce* links in order to assert that
   * decoding them still works, and coverage of a retired format is exactly what must not lapse.
   */
  async encode(content: LinkContent, options: EncodeOptions): Promise<string> {
    const payload: BespokePayload = {
      v: VERSION,
      label: content.label,
      content: content.bundle,
    };

    const compressed = await deflateRaw(encodeUtf8(JSON.stringify(payload)));
    const base = options.baseUrl.replace(/\/+$/, "");

    return `${base}/view#${PREFIX}${toBase64Url(compressed)}`;
  },

  async decode(linkOrFragment: string): Promise<LinkContent> {
    const fragment = extractFragment(linkOrFragment);
    if (!fragment.startsWith(PREFIX)) {
      throw new Error("Not a Smart Forms link.");
    }

    const body = fragment.slice(PREFIX.length);
    if (body === "") {
      throw new Error("Link payload is empty.");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(decodeUtf8(await inflateRaw(fromBase64Url(body))));
    } catch (error) {
      throw new Error("Link payload is corrupt or truncated.", {
        cause: error,
      });
    }

    if (!isBespokePayload(payload)) {
      throw new Error("Link payload is not in the expected format.");
    }

    if (payload.v > VERSION) {
      throw new Error(
        `This link was created by a newer version of the app (format v${payload.v}).`,
      );
    }

    return { bundle: payload.content, label: payload.label };
  },
};
