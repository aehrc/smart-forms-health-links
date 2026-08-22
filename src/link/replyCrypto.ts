/**
 * ECDH-ES + A256GCM, for the encrypted reply channel.
 *
 * `src/link/jwe.ts` covers the *outbound* leg, where SHL mandates `alg: "dir"` - a symmetric key the
 * link itself carries. That is exactly wrong for a reply: the invitation is a QR code, so anyone who
 * photographs it holds the symmetric key and could read the answers sent back. The reply is therefore
 * encrypted to a **public** key that travels in the invitation, while the private half never leaves
 * the requester. A leaked invitation can then at worst destroy a reply, never read one.
 *
 *   `alg: "ECDH-ES"`, `enc: "A256GCM"`
 *
 * ECDH-ES in Direct Key Agreement mode (RFC 7518 §4.6): the agreed key *is* the content encryption
 * key, so (as with `dir`) the JWE's encrypted-key segment stays empty. The sender generates an
 * ephemeral P-256 keypair per message and publishes the public half as `epk` in the protected header.
 *
 *   BASE64URL(protected header) . <empty> . BASE64URL(iv) . BASE64URL(ciphertext) . BASE64URL(tag)
 *
 * ## Byte compatibility
 *
 * This is wire-compatible with Platypus's `packages/shl-parser/src/reply-crypto.ts` and the
 * `node:crypto` implementation in its `scripts/shl-invite.mjs`. Three details have to agree exactly,
 * and none of them are negotiable:
 *
 *  - the AAD is the ASCII bytes of the *encoded* protected header, as in `jwe.ts`;
 *  - `apu` and `apv` are absent, and Concat-KDF hashes them as zero-length;
 *  - `SuppPubInfo` is the key length in **bits** (256), big-endian.
 *
 * `check:roundtrip` locks this down by cross-checking against an independent `node:crypto`
 * implementation in both directions, rather than trusting that this comment stays true.
 *
 * No new dependency: WebCrypto does P-256 ECDH and SHA-256, so Concat-KDF is the only thing that has
 * to be written out by hand.
 */
import { fromBase64Url, toBase64Url } from "./binary";

/** The only curve this supports, and the one the reply descriptor specifies. */
const CURVE = "P-256";

const ALG = "ECDH-ES";
const ENC = "A256GCM";

/** A256GCM content encryption key length, in bits - also Concat-KDF's `keydatalen`. */
const CEK_BITS = 256;

/** AES-GCM authentication tag length. */
const TAG_BYTES = 16;

/** AES-GCM initialisation vector length. JWE/JOSE requires 96 bits for A256GCM. */
const IV_BYTES = 12;

/** Public half of a reply key: a P-256 JWK, as carried in the reply descriptor. */
export interface ReplyPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** Private half. Kept by the requester; never travels in a link. */
export interface ReplyPrivateJwk extends ReplyPublicJwk {
  d: string;
}

export interface ReplyKeyPair {
  publicJwk: ReplyPublicJwk;
  privateJwk: ReplyPrivateJwk;
}

/** Narrow an untrusted value to a usable P-256 public JWK. */
export function isReplyPublicJwk(value: unknown): value is ReplyPublicJwk {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kty === "EC" &&
    candidate.crv === CURVE &&
    typeof candidate.x === "string" &&
    candidate.x !== "" &&
    typeof candidate.y === "string" &&
    candidate.y !== ""
  );
}

export function isReplyPrivateJwk(value: unknown): value is ReplyPrivateJwk {
  if (!isReplyPublicJwk(value)) {
    return false;
  }

  const d = (value as { d?: unknown }).d;
  return typeof d === "string" && d !== "";
}

/**
 * Generate a reply keypair.
 *
 * Extractable on purpose: a reply channel is only useful if the private half can be kept somewhere
 * for as long as the reply may take to arrive, which a non-extractable `CryptoKey` rules out. This
 * app no longer mints such channels itself - it writes to channels other producers declare (see
 * {@link encryptReplyJwe}) - so nothing here persists a private half today.
 */
export async function generateReplyKeyPair(): Promise<ReplyKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE },
    true,
    ["deriveBits"],
  );

  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  if (!isReplyPrivateJwk(privateJwk) || !isReplyPublicJwk(publicJwk)) {
    throw new Error(
      "WebCrypto produced an EC keypair this app does not recognise.",
    );
  }

  // Drop everything WebCrypto adds beyond the curve points (`key_ops`, `ext`, `alg`) so the JWK
  // that goes into a descriptor and into storage is exactly the five fields the wire format defines.
  return {
    publicJwk: { kty: "EC", crv: CURVE, x: publicJwk.x, y: publicJwk.y },
    privateJwk: {
      kty: "EC",
      crv: CURVE,
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d,
    },
  };
}

function importPublic(jwk: ReplyPublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: CURVE, x: jwk.x, y: jwk.y },
    { name: "ECDH", namedCurve: CURVE },
    false,
    [],
  );
}

function importPrivate(jwk: ReplyPrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: CURVE, x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDH", namedCurve: CURVE },
    false,
    ["deriveBits"],
  );
}

/** Big-endian uint32, the length prefix Concat-KDF uses throughout. */
function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

/** `Datalen ‖ Data`, per NIST SP 800-56A's definition of the OtherInfo fields. */
function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concat(uint32(bytes.length), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/**
 * Concat KDF (NIST SP 800-56A §5.8.1) as JOSE applies it, per RFC 7518 §4.6.2.
 *
 * A256GCM needs 256 bits and SHA-256 produces exactly that, so this is a single round with the
 * counter fixed at 1 - no loop, and none of the truncation a longer key would require.
 *
 * `AlgorithmID` is the `enc` value in Direct Key Agreement mode (**not** `alg`), and `PartyUInfo` /
 * `PartyVInfo` are `apu` / `apv`, both absent here and so hashed as zero-length. Getting either wrong
 * yields a plausible-looking key that simply fails to decrypt.
 */
async function concatKdf(sharedSecret: Uint8Array): Promise<Uint8Array> {
  const otherInfo = concat(
    lengthPrefixed(new TextEncoder().encode(ENC)),
    lengthPrefixed(new Uint8Array(0)),
    lengthPrefixed(new Uint8Array(0)),
    uint32(CEK_BITS),
  );

  const digest = await crypto.subtle.digest(
    "SHA-256",
    concat(uint32(1), sharedSecret, otherInfo) as BufferSource,
  );

  return new Uint8Array(digest);
}

/** Agree on the content encryption key. Identical on both sides - that is the point of ECDH. */
async function deriveCek(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<CryptoKey> {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      CEK_BITS,
    ),
  );

  return crypto.subtle.importKey(
    "raw",
    (await concatKdf(shared)) as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

interface ReplyHeader {
  alg?: string;
  enc?: string;
  epk?: unknown;
  apu?: string;
  apv?: string;
  zip?: string;
}

/**
 * Encrypt a reply to the recipient's public key.
 *
 * The requester never needs this (it only ever decrypts), but a filler does, and this app is a
 * filler too (`FillFromRequest`). Keeping both halves here is also what lets `check:roundtrip` prove
 * compatibility with no phone in the loop.
 */
export async function encryptReplyJwe(
  plaintext: Uint8Array,
  recipientPublicJwk: ReplyPublicJwk,
): Promise<string> {
  const recipient = await importPublic(recipientPublicJwk);
  // Ephemeral, per message: a fresh `epk` is what makes each reply's CEK unique.
  const ephemeral = await generateReplyKeyPair();
  const ephemeralPrivate = await importPrivate(ephemeral.privateJwk);
  const cek = await deriveCek(ephemeralPrivate, recipient);

  const header = { alg: ALG, enc: ENC, epk: ephemeral.publicJwk };
  const protectedHeader = toBase64Url(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: new TextEncoder().encode(
          protectedHeader,
        ) as BufferSource,
        tagLength: TAG_BYTES * 8,
      },
      cek,
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
 * Decrypt a reply with the private key held for the request.
 *
 * Throws on a wrong key, a tampered ciphertext, a tampered `epk`, or an unsupported algorithm.
 * AES-GCM authentication failure makes the first three indistinguishable, which is the point.
 */
export async function decryptReplyJwe(
  compact: string,
  privateJwk: ReplyPrivateJwk,
): Promise<Uint8Array> {
  const segments = compact.trim().split(".");
  if (segments.length !== 5) {
    throw new Error(
      `Not a JWE compact serialisation: expected 5 dot-separated segments, got ${segments.length}.`,
    );
  }

  const [protectedHeader, encryptedKey, iv, ciphertext, tag] = segments;

  let header: ReplyHeader;
  try {
    header = JSON.parse(
      new TextDecoder().decode(fromBase64Url(protectedHeader)),
    ) as ReplyHeader;
  } catch (error) {
    throw new Error("Reply JWE protected header is not valid base64url JSON.", {
      cause: error,
    });
  }

  if (header.alg !== ALG || header.enc !== ENC) {
    throw new Error(
      `Unsupported reply JWE algorithms (alg=${header.alg}, enc=${header.enc}). ` +
        `The reply channel requires alg=${ALG} and enc=${ENC}.`,
    );
  }

  if (encryptedKey !== "") {
    throw new Error(
      "Reply JWE encrypted key segment must be empty - ECDH-ES here is Direct Key Agreement, so " +
        "the agreed key is the content encryption key and there is nothing to wrap.",
    );
  }

  if (header.zip) {
    // Legal JOSE, but this channel does not use it; fail loudly rather than hand back deflate bytes
    // the caller would try to JSON.parse. Same stance as `jwe.ts`.
    throw new Error(
      `Compressed reply payloads (zip=${header.zip}) are not supported.`,
    );
  }

  if (header.apu !== undefined || header.apv !== undefined) {
    /*
     * Concat-KDF below hashes apu/apv as zero-length. Honouring non-empty ones is a small change, but
     * silently ignoring them would derive the wrong key and report it as "could not decrypt", which
     * sends whoever debugs it looking in the wrong place.
     */
    throw new Error(
      "This reply JWE sets apu/apv. The reply channel specifies neither, and ignoring them would " +
        "derive a different key.",
    );
  }

  if (!isReplyPublicJwk(header.epk)) {
    throw new Error("Reply JWE header is missing a usable P-256 `epk`.");
  }

  const cek = await deriveCek(
    await importPrivate(privateJwk),
    await importPublic(header.epk),
  );

  // Re-join ciphertext and tag the way WebCrypto expects them.
  const ciphertextBytes = fromBase64Url(ciphertext);
  const tagBytes = fromBase64Url(tag);
  const sealed = concat(ciphertextBytes, tagBytes);

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
      cek,
      sealed as BufferSource,
    );

    return new Uint8Array(plaintext);
  } catch (error) {
    throw new Error(
      "Could not decrypt the reply. The key does not match this request, or the content has been " +
        "altered.",
      { cause: error },
    );
  }
}

/**
 * Whether a fetched reply slot body looks like a reply rather than the pending sentinel.
 *
 * Deliberately structural rather than a comparison against the sentinel: a slot hosted somewhere that
 * returns its own idea of "empty" should still read as pending rather than as a corrupt reply.
 */
export function looksLikeReplyJwe(body: string): boolean {
  const segments = body.trim().split(".");
  return segments.length === 5 && segments[0] !== "" && segments[3] !== "";
}
