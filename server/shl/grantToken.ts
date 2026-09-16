/**
 * The capability token that travels inside a grant file.
 *
 * Before the facade, the grant carried a SMART Backend Services token: the *system's* authority,
 * narrowed by scope and by nothing else. Anyone holding the link held a credential that could
 * create a response for any patient on the practice's server and update any Task, and nothing in
 * it said which invitation it travelled in. This module is the replacement, and the whole of the
 * difference is that the token names one invitation and authorises nothing anywhere else.
 *
 * ## Signed rather than stored
 *
 * A grant is minted on every manifest fetch, and two people opening the same link both have to
 * end up with something that works. A stored token would mean either a row per fetch or
 * overwriting one column, and overwriting would invalidate a link somebody already had open
 * mid-form. A signature has neither problem: the token carries its own expiry, nothing is
 * written, and concurrent opens are independent by construction.
 *
 * Being stateless is not the same as being unrevokable. The facade verifies the signature and
 * then* re-reads the invitation, so a row that has expired or been deleted refuses every token
 * ever issued against it ({@link verifyGrantToken} is a gate, not a decision).
 *
 * ## The key is derived, not configured
 *
 * HKDF from `SESSION_COOKIE_SECRET` under a fixed info label. That is domain separation, not
 * reuse: the derived key cannot sign a session cookie and the cookie secret cannot sign a grant.
 * The alternative was a second required environment variable, which would have to be threaded
 * through the chart, the image, the workflow and the deployed Secret before a single link could
 * be minted - a lot of operational surface for a key that can be derived deterministically from
 * one already there.
 * @author John Grimes
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** Bytes of derived key material. Matches the HMAC's block-independent output size. */
const KEY_BYTES = 32;

/**
 * HKDF info label. Fixed, and never to be changed: it is what separates this key from any other
 * derived from the same secret, so changing it would invalidate every grant in flight.
 */
const KEY_INFO = "smart-forms-health-links/grant-token/v1";

/** Separator between a token's expiry and its signature. Not valid base64url, so it cannot collide. */
const FIELD_SEPARATOR = ".";

/**
 * Derive the signing key for grant tokens.
 *
 * Called once where the facade and the manifest are registered rather than per request: HKDF is
 * cheap but it is not free, and the answer never changes for a given process.
 * @param cookieSecret the configured `SESSION_COOKIE_SECRET`
 * @returns 32 bytes of key material, independent of any other key derived from that secret
 * @example
 * const key = deriveGrantTokenKey(config.cookieSecret);
 */
export function deriveGrantTokenKey(cookieSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", cookieSecret, "", KEY_INFO, KEY_BYTES));
}

/**
 * The signature over one invitation and one expiry.
 *
 * The invitation id is signed but not carried: the facade already knows which invitation is being
 * addressed, because it is in the request path. Signing it anyway is what stops a token minted
 * for one link being presented against another.
 * @param key the derived signing key
 * @param invitationId the invitation the token authorises
 * @param expiresAt the token's expiry in epoch seconds
 * @returns the base64url signature
 */
function sign(key: Buffer, invitationId: string, expiresAt: number): string {
  return createHmac("sha256", key)
    .update(`${invitationId}${FIELD_SEPARATOR}${String(expiresAt)}`)
    .digest("base64url");
}

/**
 * Mint a capability token for one invitation.
 * @param options the key, the invitation and the window
 * @param options.key the derived signing key
 * @param options.invitationId the invitation this token may write against, and no other
 * @param options.expiresAt the moment the token stops being accepted, in epoch seconds
 * @returns the token, for the grant file's `access_token`
 * @example
 * const token = mintGrantToken({ key, invitationId: row.id, expiresAt: now + ttl });
 */
export function mintGrantToken(options: {
  readonly key: Buffer;
  readonly invitationId: string;
  readonly expiresAt: number;
}): string {
  const { key, invitationId, expiresAt } = options;
  const stated = Math.floor(expiresAt);
  return `${String(stated)}${FIELD_SEPARATOR}${sign(key, invitationId, stated)}`;
}

/**
 * Whether a presented token authorises writing against this invitation, right now.
 *
 * Boolean rather than a reason, and deliberately so. A malformed token, a token for a different
 * invitation, a forged signature and an elapsed window are all one answer to the caller - the
 * request is not authorised - and telling them apart in a response would describe the shape of
 * the secret to whoever was guessing at it.
 *
 * The comparison is constant-time over equal-length buffers. A length mismatch short-circuits,
 * which leaks only the length of a digest that is fixed and public anyway.
 * @param options the key, the invitation being addressed, the presented token and the time
 * @param options.key the derived signing key
 * @param options.invitationId the invitation from the request path
 * @param options.token the token the request presented, if it presented one
 * @param options.now current time in epoch seconds, injectable for tests
 * @returns true only for an unexpired token minted for this invitation under this key
 * @example
 * if (!verifyGrantToken({ key, invitationId: id, token })) {
 *   return reply.code(401).send({ error: "invalid-token" });
 * }
 */
export function verifyGrantToken(options: {
  readonly key: Buffer;
  readonly invitationId: string;
  readonly token: string | undefined;
  readonly now?: number;
}): boolean {
  const { key, invitationId, token } = options;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (token === undefined) {
    return false;
  }

  const separator = token.indexOf(FIELD_SEPARATOR);
  if (separator <= 0) {
    return false;
  }
  const statedExpiry = token.slice(0, separator);
  const presented = token.slice(separator + 1);

  // A leading zero, a sign, whitespace or an exponent would all parse and none is a token we
  // minted, so the digits are matched rather than coerced.
  if (!/^\d{1,15}$/.test(statedExpiry)) {
    return false;
  }
  const expiresAt = Number(statedExpiry);
  if (now > expiresAt) {
    return false;
  }

  const expected = Buffer.from(sign(key, invitationId, expiresAt), "utf8");
  const offered = Buffer.from(presented, "utf8");
  return (
    expected.length === offered.length && timingSafeEqual(expected, offered)
  );
}
