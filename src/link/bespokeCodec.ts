import {
  decodeUtf8,
  deflateRaw,
  encodeUtf8,
  fromBase64Url,
  inflateRaw,
  toBase64Url,
} from "./binary";
import { extractFragment } from "./codec";

import type { EncodingCodec, LinkContent, EncodeOptions } from "./codec";
import type { Bundle } from "fhir/r4";

/**
 * The inline transport: the whole payload travels inside the URL fragment.
 *
 * Link shape:  `https://host/view#sfhl:/<base64url(deflate-raw(json))>`
 *
 * The `sfhl:/` prefix intentionally parallels SHL's `shlink:/`. This is NOT a SMART Health Link and
 * third-party SHL wallets will not understand it - see `shlCodec.ts`.
 *
 * ## Who mints these, and why it has to be this transport
 *
 * The filler, returning completed answers. Nobody else: a requester's invitation is minted, hosted
 * and published by this app's own server under a launched session (`POST /api/invitations`), which
 * is what makes a hosted, encrypted SHL possible for that direction.
 *
 * The return leg has none of that. Whoever fills the form holds a link and nothing else - no
 * session, no server, no account - and the server's public surface is fixed by
 * `contracts/http-api.md`, which lists the routes that answer without a session and includes
 * nothing that would take a payload. Hosting is therefore not available in this direction at all,
 * and an inline link is what remains: it needs no host, no network and no account, which is
 * exactly the situation it was built for.
 *
 * ## SECURITY
 *
 * The payload is compressed, not encrypted. Anyone who photographs the QR code or sees the URL can
 * read the answers. Two things make that a stated trade rather than an oversight: the fragment is
 * the one part of a URL a browser never transmits, so the answers do not reach a server on the way
 * back; and `ShareLinkPanel` says so plainly on the surface that shows the link, because the
 * person handing it over is the only one who can judge who is looking.
 * @author John Grimes
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

export const bespokeCodec: EncodingCodec = {
  id: "bespoke",
  prefix: PREFIX,

  canDecode(linkOrFragment: string): boolean {
    return extractFragment(linkOrFragment).startsWith(PREFIX);
  },

  /**
   * Compress the payload into a viewer URL's fragment.
   * @param content the Bundle to carry, and the label to show for it
   * @param options the origin the viewer URL is built against
   * @returns the link
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
