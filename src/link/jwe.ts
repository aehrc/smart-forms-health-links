/**
 * JWE compact serialisation, as required by SMART Health Links.
 *
 * SHL mandates direct encryption with a shared symmetric key:
 *   `alg: "dir"`, `enc: "A256GCM"`
 *
 * Compact form is five base64url segments joined by dots:
 *
 *   BASE64URL(protected header) . <empty> . BASE64URL(iv) . BASE64URL(ciphertext) . BASE64URL(tag)
 *
 * The second segment is always empty - that is precisely what `dir` means: the content encryption
 * key IS the shared key, so there is no wrapped key to transmit.
 *
 * AES-GCM in WebCrypto returns ciphertext and tag concatenated, whereas JWE keeps them as separate
 * segments, so the 16-byte tag is split off on encrypt and re-joined on decrypt.
 *
 * The protected header is the GCM additional authenticated data, per RFC 7516 §5.1.
 */
import { fromBase64Url, toBase64Url } from "./binary";

const PROTECTED_HEADER = { alg: "dir", enc: "A256GCM" } as const;

/** Media type for a JWE compact serialisation (RFC 7515 §9.2.1). */
export const JOSE_CONTENT_TYPE = "application/jose";

/** AES-256 key length. */
export const KEY_BYTES = 32;

/** AES-GCM authentication tag length. */
const TAG_BYTES = 16;

/** AES-GCM initialisation vector length. JWE/JOSE requires 96 bits for A256GCM. */
const IV_BYTES = 12;

/**
 * Generate a fresh content encryption key.
 *
 * SHL expects this base64url-encoded in the link's `key` field, which is 43 characters for 32 bytes.
 */
export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 *
 * @param key
 */
export function keyToBase64Url(key: Uint8Array): string {
  return toBase64Url(key);
}

/**
 *
 * @param value
 */
export function keyFromBase64Url(value: string): Uint8Array {
  const key = fromBase64Url(value);
  if (key.length !== KEY_BYTES) {
    throw new Error(`SHL key must be ${KEY_BYTES} bytes, got ${key.length}.`);
  }

  return key;
}

async function importKey(
  key: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }

  return crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    usage,
  ]);
}

/**
 * Encode the protected header, which doubles as the GCM additional authenticated data.
 * @param contentType value for the `cty` member, omitted when undefined
 * @returns the base64url-encoded header
 */
function encodeProtectedHeader(contentType?: string): string {
  // Encoded once and used verbatim as the AAD, so the exact bytes must match on both sides.
  const header =
    contentType === undefined
      ? PROTECTED_HEADER
      : { ...PROTECTED_HEADER, cty: contentType };
  return toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
}

/** The members of a JWE protected header that this decoder acts on. */
interface JweHeader {
  alg?: string;
  enc?: string;
  zip?: string;
}

/** How a payload is sealed. */
export interface EncryptJweOptions {
  /**
   * Content type of the plaintext, written to the header's `cty` member.
   *
   * SMART Health Links carry more than one kind of file in a manifest - an invitation Bundle and
   * an API access grant, in this app - and `cty` is how a reader tells them apart before
   * decrypting. Omitted for payloads whose type is already established by where they were found.
   */
  readonly contentType?: string;
}

/**
 * Encrypt to JWE compact serialisation.
 * @param plaintext the bytes to seal
 * @param key the 256-bit content encryption key
 * @param options the content type to declare, if any
 * @returns the compact serialisation
 * @throws {Error} when the key is not 32 bytes
 * @example
 * await encryptJwe(encodeUtf8(json), key, { contentType: "application/fhir+json" });
 */
export async function encryptJwe(
  plaintext: Uint8Array,
  key: Uint8Array,
  options: EncryptJweOptions = {},
): Promise<string> {
  const cryptoKey = await importKey(key, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const protectedHeader = encodeProtectedHeader(options.contentType);
  const additionalData = new TextEncoder().encode(protectedHeader);

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: additionalData as BufferSource,
        tagLength: TAG_BYTES * 8,
      },
      cryptoKey,
      plaintext as BufferSource,
    ),
  );

  // WebCrypto appends the tag; JWE wants it in its own segment.
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  return [
    protectedHeader,
    "",
    toBase64Url(iv),
    toBase64Url(ciphertext),
    toBase64Url(tag),
  ].join(".");
}

/**
 * Decrypt a JWE compact serialisation.
 *
 * Throws on a wrong key, a tampered payload, or an unsupported algorithm - AES-GCM authentication
 * failure is indistinguishable from the former two, which is the point.
 * @param compact
 * @param key
 */
export async function decryptJwe(
  compact: string,
  key: Uint8Array,
): Promise<Uint8Array> {
  const segments = compact.trim().split(".");
  if (segments.length !== 5) {
    throw new Error(
      `Not a JWE compact serialisation: expected 5 dot-separated segments, got ${segments.length}.`,
    );
  }

  const [protectedHeader, encryptedKey, iv, ciphertext, tag] = segments;

  let header: JweHeader;
  try {
    header = JSON.parse(
      new TextDecoder().decode(fromBase64Url(protectedHeader)),
    ) as JweHeader;
  } catch (error) {
    throw new Error("JWE protected header is not valid base64url JSON.", {
      cause: error,
    });
  }

  if (header.alg !== "dir" || header.enc !== "A256GCM") {
    throw new Error(
      `Unsupported JWE algorithms (alg=${header.alg}, enc=${header.enc}). ` +
        "SMART Health Links require alg=dir and enc=A256GCM.",
    );
  }

  if (header.zip) {
    // DEF-compressed payloads are legal JOSE but SHL does not use them; fail loudly rather than
    // hand back deflate bytes that the caller would try to JSON.parse.
    throw new Error(
      `Compressed JWE payloads (zip=${header.zip}) are not supported.`,
    );
  }

  if (encryptedKey !== "") {
    throw new Error("JWE encrypted key segment must be empty when alg=dir.");
  }

  const cryptoKey = await importKey(key, "decrypt");

  // Re-join ciphertext and tag the way WebCrypto expects them.
  const ciphertextBytes = fromBase64Url(ciphertext);
  const tagBytes = fromBase64Url(tag);
  const sealed = new Uint8Array(ciphertextBytes.length + tagBytes.length);
  sealed.set(ciphertextBytes, 0);
  sealed.set(tagBytes, ciphertextBytes.length);

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(iv) as BufferSource,
        additionalData: new TextEncoder().encode(
          protectedHeader,
        ) as BufferSource,
        tagLength: TAG_BYTES * 8,
      },
      cryptoKey,
      sealed,
    );

    return new Uint8Array(plaintext);
  } catch (error) {
    throw new Error(
      "Could not decrypt the payload. The key is wrong, or the content has been altered.",
      { cause: error },
    );
  }
}
