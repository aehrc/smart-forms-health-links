import type { LinkCodec, LinkContent, EncodeOptions } from './codec';
import { extractFragment } from './codec';

/**
 * Phase 2 placeholder: SMART Health Links (https://docs.smarthealthit.org/smart-health-links/).
 *
 * Registered but not implemented, so that:
 *  - the codec seam is exercised by real code rather than being hypothetical, and
 *  - an `shlink:/` link scanned today fails with an explanation instead of "unrecognised link".
 *
 * ## What Phase 2 requires
 *
 * The payload here is NOT the clinical data — it is a pointer:
 *
 * ```json
 * { "url": "https://manifest.example.org/shl/<id>", "key": "<base64url 32-byte AES key>",
 *   "exp": 1735689600, "flag": "P", "label": "Health Check", "v": 1 }
 * ```
 *
 * base64url-encoded after `shlink:/`, optionally prefixed by a viewer URL + `#`.
 *
 * Reading:  POST `{recipient, passcode?}` to `url` -> manifest of files -> each file is a JWE
 *           (`alg: dir`, `enc: A256GCM`) decrypted with `key` -> `application/fhir+json` Bundle.
 *           That Bundle is exactly {@link LinkContent.bundle}, so everything downstream of the
 *           codec — routes, renderer, response extraction — is already correct and unchanged.
 *
 * Creating: encrypt the Bundle as a JWE with a fresh 256-bit key, PUT it to the manifest server,
 *           then return the `shlink:/` pointer. The key lives only in the link.
 *
 * ## What this needs that Phase 1 does not
 *
 *  - A manifest server (the one piece that cannot be avoided; SHL has no embedded-payload mode).
 *  - AES-256-GCM via WebCrypto, plus JWE compact serialisation.
 *  - Optional passcode handling and the `P` flag.
 *
 * To cut over: implement the two methods below, stand up the manifest server, set
 * `shlManifestUrl` and flip `linkCodec` to `"shl"` in `public/config.json`. Existing `sfhl:/`
 * links keep decoding, because `decodingCodec()` sniffs across all registered codecs.
 */

const PREFIX = 'shlink:/';

const NOT_IMPLEMENTED =
  'SMART Health Links are not supported yet. This build creates and reads Phase 1 links only ' +
  '(see src/link/shlCodec.ts).';

export const shlCodec: LinkCodec = {
  id: 'shl',
  prefix: PREFIX,

  canDecode(linkOrFragment: string): boolean {
    return extractFragment(linkOrFragment).startsWith(PREFIX);
  },

  async encode(_content: LinkContent, _options: EncodeOptions): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  },

  async decode(_linkOrFragment: string): Promise<LinkContent> {
    throw new Error(NOT_IMPLEMENTED);
  }
};
