/**
 * Tests for `server/shl/grantToken.ts`: the capability token a grant now carries.
 *
 * The module replaced a SMART Backend Services token with a signature, and the tests below are
 * the four properties that replacement rests on.
 *
 *  1. **It names one invitation.** A token minted for one link authorises nothing against
 *     another, which is the whole of what "bound to its invitation" means.
 *  2. **It carries its own window.** Nothing is stored, so the expiry travels in the token and
 *     an elapsed one is refused without a database read.
 *  3. **It cannot be forged or edited.** Changing the expiry, the signature, or the key it was
 *     signed under all fail, and none of them fail differently.
 *  4. **The key is domain-separated.** Derived from the session cookie secret, but not equal to
 *     it and not usable for anything else derived from it.
 * @author John Grimes
 */

import { describe, expect, it } from "vitest";

import {
  deriveGrantTokenKey,
  mintGrantToken,
  verifyGrantToken,
} from "../../server/shl/grantToken";

/** The configured secret both halves derive from. */
const SECRET = "0123456789abcdef0123456789abcdef";

/** The derived signing key, as both the manifest and the facade compute it. */
const KEY = deriveGrantTokenKey(SECRET);

/** A fixed clock, so a window is a window rather than a race. */
const NOW = 1_800_000_000;

/** An invitation id, shaped like the base64url ones `insertInvitation` mints. */
const INVITATION = "cM9x_2fQqL4pR7tV1yZ0Bw";

/**
 * Mint a token for the well-formed case.
 * @param overrides what to differ
 * @param overrides.invitationId
 * @param overrides.expiresAt
 * @returns the token
 */
function token(
  overrides: { invitationId?: string; expiresAt?: number } = {},
): string {
  return mintGrantToken({
    key: KEY,
    invitationId: overrides.invitationId ?? INVITATION,
    expiresAt: overrides.expiresAt ?? NOW + 3600,
  });
}

/**
 * Verify a token the way the facade does.
 * @param presented the token to check
 * @param overrides what to differ
 * @param overrides.invitationId
 * @param overrides.now
 * @param overrides.key
 * @returns whether it authorises the write
 */
function verify(
  presented: string | undefined,
  overrides: { invitationId?: string; now?: number; key?: Buffer } = {},
): boolean {
  return verifyGrantToken({
    key: overrides.key ?? KEY,
    invitationId: overrides.invitationId ?? INVITATION,
    token: presented,
    now: overrides.now ?? NOW,
  });
}

describe("the grant's capability token", () => {
  it("verifies a token it just minted", () => {
    expect(verify(token())).toBe(true);
  });

  /*
   * The property the whole facade rests on. Before it, the grant carried the system's authority
   * and nothing in it said which invitation it travelled in.
   */
  it("authorises nothing against another invitation", () => {
    expect(verify(token(), { invitationId: "some-other-invitation" })).toBe(
      false,
    );
  });

  describe("the window", () => {
    it("accepts a token right up to its stated expiry", () => {
      expect(verify(token({ expiresAt: NOW }), { now: NOW })).toBe(true);
    });

    it("refuses a token one second past it", () => {
      expect(verify(token({ expiresAt: NOW }), { now: NOW + 1 })).toBe(false);
    });

    /*
     * Two opens of one link are independent, which is why nothing is stored. The earlier token
     * keeps working until its own window closes rather than being displaced by the later one.
     */
    it("keeps an earlier token valid alongside a later one", () => {
      const earlier = token({ expiresAt: NOW + 60 });
      const later = token({ expiresAt: NOW + 3600 });

      expect(earlier).not.toBe(later);
      expect(verify(earlier, { now: NOW + 30 })).toBe(true);
      expect(verify(later, { now: NOW + 30 })).toBe(true);
    });
  });

  describe("refusals", () => {
    // Every one of these is the same answer, because a reason would describe the secret.
    it.for([
      ["nothing presented", undefined],
      ["empty", ""],
      ["no separator", "3600"],
      ["no expiry", ".signature"],
      ["no signature", "1800003600."],
      ["a non-numeric expiry", "later.signature"],
      ["a negative expiry", "-1.signature"],
      ["a padded expiry", "01800003600.signature"],
      ["an expiry with whitespace", " 1800003600.signature"],
      ["an exponent expiry", "1e30.signature"],
      ["an absurdly long expiry", `${"9".repeat(40)}.signature`],
    ] as const)("refuses %s", ([, presented]) => {
      expect(verify(presented)).toBe(false);
    });

    it("refuses a token whose expiry has been extended", () => {
      const [, signature] = token({ expiresAt: NOW + 60 }).split(".");

      expect(verify(`${String(NOW + 86_400)}.${signature}`)).toBe(false);
    });

    it("refuses a token whose signature has been replaced", () => {
      const [expiry] = token().split(".");

      expect(verify(`${expiry}.aGVsbG8td29ybGQ`)).toBe(false);
    });

    it("refuses a token signed under a different key", () => {
      const foreign = mintGrantToken({
        key: deriveGrantTokenKey("fedcba9876543210fedcba9876543210"),
        invitationId: INVITATION,
        expiresAt: NOW + 3600,
      });

      expect(verify(foreign)).toBe(false);
    });
  });

  describe("the derived key", () => {
    it("is stable for a given secret", () => {
      expect(deriveGrantTokenKey(SECRET)).toEqual(deriveGrantTokenKey(SECRET));
    });

    // Domain separation: the point of deriving rather than reusing.
    it("is not the secret, and differs for a different secret", () => {
      expect(KEY.toString("utf8")).not.toBe(SECRET);
      expect(KEY).not.toEqual(
        deriveGrantTokenKey("fedcba9876543210fedcba9876543210"),
      );
    });

    it("is 32 bytes", () => {
      expect(KEY).toHaveLength(32);
    });
  });
});
