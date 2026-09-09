/**
 * What a grant says it permits, and what a consumer may do about it.
 *
 * `scope` is the member that lets a filler answer "what have I been handed?" before it presents
 * a credential. The rules it has to satisfy pull in opposite directions, which is why they get a
 * file of their own:
 *
 * - **A producer states it or declines.** This app mints its own token, so having nothing to say
 *   about what that token permits means something is wrong, not that the scope is open.
 * - **A consumer tolerates its absence.** A token response is allowed to omit `scope`, and a
 *   filler that treated silence as refusal would close a working channel over a technicality
 *   (FR-020). Hence the three-valued {@link grantCovers}: `undefined` is "cannot say", never
 *   "no".
 *
 * The coverage tests exist because the wire contract pins no SMART version. A grant may arrive
 * written in v2 letters, in v1 words, or with wildcards, and all three have to be read the same
 * way - otherwise the check silently passes on a grant it did not understand.
 * @author John Grimes
 */

import { describe, expect, it } from "vitest";

import type { ApiAccessGrant, GrantOptions } from "@/link/apiAccess";

import {
  SUBMISSION_SCOPES,
  buildGrant,
  excessScopes,
  grantCovers,
  grantScopes,
  parseGrant,
} from "@/link/apiAccess";

/** The destination every grant in this file points at. */
const AUD = "https://links.example.org/shl/inv-abc123/fhir";

/** The scope this app's own submission needs, as one string. */
const SUBMISSION = SUBMISSION_SCOPES.join(" ");

/** A token response that mints cleanly, as the basis for each case. */
const WELL_FORMED: GrantOptions = {
  accessToken: "opaque-access-token",
  tokenType: "Bearer",
  expiresIn: 3600,
  scope: SUBMISSION,
  aud: AUD,
  patientId: "pt-1",
  grantTtlSeconds: 3600,
};

/**
 * A grant file's plaintext, in the snake_case the wire uses.
 *
 * Deliberately not {@link WELL_FORMED}: that is what a *producer* is handed, and spreading it
 * into a parser would silently test nothing, because none of its camelCase members are ones the
 * contract defines.
 */
const WIRE = {
  access_token: "opaque-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: SUBMISSION,
  aud: AUD,
  patient: "pt-1",
};

/**
 * Parse a grant from a value, as it would arrive off the wire.
 * @param value the grant file's plaintext, before serialisation
 * @returns the parsed grant, or undefined when the contract says to treat it as absent
 */
function parse(value: unknown): ApiAccessGrant | undefined {
  return parseGrant(JSON.stringify(value));
}

/**
 * A grant stating one scope string, for the coverage cases.
 * @param scope the scope string to state
 * @returns a grant carrying it
 */
function granting(scope: string): ApiAccessGrant {
  return {
    access_token: "opaque-access-token",
    token_type: "Bearer",
    scope,
    aud: AUD,
  };
}

describe("the grant's scope", () => {
  describe("producing one", () => {
    it("states the scope it was minted with, verbatim", () => {
      expect(buildGrant(WELL_FORMED)?.scope).toBe(SUBMISSION);
    });

    // One value, one spelling, so a comparison never has to know how the server wrote it.
    it("collapses the whitespace a token response is free to vary", () => {
      const grant = buildGrant({
        ...WELL_FORMED,
        scope: "  system/Task.r \n\t system/Task.u  ",
      });

      expect(grant?.scope).toBe("system/Task.r system/Task.u");
    });

    /*
     * The symmetry with `expires_in`: rather than emit something a conformant filler would read
     * as "no stated scope", the producer declines and the manifest degrades to one file.
     */
    it.each([
      ["null", null],
      ["empty", ""],
      ["whitespace only", "   \n  "],
    ])("declines a token response whose scope is %s", (_label, scope) => {
      expect(buildGrant({ ...WELL_FORMED, scope })).toBeUndefined();
    });
  });

  describe("consuming one", () => {
    it("keeps the scope a well-formed grant states", () => {
      expect(parse({ ...WIRE, scope: SUBMISSION })?.scope).toBe(SUBMISSION);
    });

    /*
     * The rule that is easy to invert, and the one with a patient's answers behind it. A grant
     * that cannot be measured is still a grant.
     */
    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["whitespace only", "  "],
      ["a number", 42],
      ["an array", ["system/Task.r"]],
      ["an object", { system: "Task.r" }],
      ["null", null],
    ])(
      "treats a scope that is %s as unstated, never as absence",
      (_l, scope) => {
        const grant = parse({
          access_token: "opaque-access-token",
          token_type: "Bearer",
          aud: AUD,
          scope,
        });

        expect(grant).toBeDefined();
        expect(grant?.scope).toBeUndefined();
      },
    );

    it("never throws on a hostile scope", () => {
      expect(() =>
        parse({ ...WIRE, scope: "a ".repeat(10_000) }),
      ).not.toThrow();
    });

    // An over-broad grant is still a grant. Whether to use it is the consumer's call, not the
    // parser's.
    it("returns a grant whose scope is far broader than a submission needs", () => {
      const grant = parse({ ...WIRE, scope: "system/*.*" });

      expect(grant?.scope).toBe("system/*.*");
    });
  });

  describe("reading what a grant permits", () => {
    it("lists the scopes, and lists none when the grant stated none", () => {
      expect(grantScopes(granting("system/Task.r system/Task.u"))).toEqual([
        "system/Task.r",
        "system/Task.u",
      ]);
      expect(grantScopes({ ...granting(""), scope: undefined })).toEqual([]);
    });

    /*
     * `undefined` rather than `false`, and the distinction is the whole point: only the
     * destination knows whether an unmeasurable token works, and it says so by refusing.
     */
    it("cannot say whether a grant with no stated scope covers anything", () => {
      const grant: ApiAccessGrant = {
        access_token: "opaque-access-token",
        token_type: "Bearer",
        aud: AUD,
      };

      expect(grantCovers(grant, SUBMISSION_SCOPES)).toBeUndefined();
    });

    it("covers a submission when every scope it needs is stated exactly", () => {
      expect(grantCovers(granting(SUBMISSION), SUBMISSION_SCOPES)).toBe(true);
    });

    it.each([
      ["a wider permission set", "system/Task.cruds", "system/Task.u"],
      ["a resource wildcard", "system/*.cruds", "system/Task.u"],
      ["a total wildcard", "system/*.*", "system/QuestionnaireResponse.c"],
      ["SMART v1 write", "system/Task.write", "system/Task.u"],
      ["SMART v1 read", "system/Task.read", "system/Task.r"],
    ])("reads %s as covering %s", (_label, granted, required) => {
      expect(grantCovers(granting(granted), [required])).toBe(true);
    });

    it("does not read a grant at another level as covering a system scope", () => {
      expect(grantCovers(granting("user/*.*"), ["system/Task.u"])).toBe(false);
    });

    it("reports a submission uncovered when one scope it needs is missing", () => {
      const granted =
        "system/QuestionnaireResponse.c system/Provenance.c system/Task.r";

      expect(grantCovers(granting(granted), SUBMISSION_SCOPES)).toBe(false);
    });

    it("names the scopes stated beyond what a submission needs", () => {
      const granted = `${SUBMISSION} system/Patient.rs`;

      expect(excessScopes(granting(granted))).toEqual(["system/Patient.rs"]);
    });

    // Silence is not a broad claim.
    it("names no excess for a grant that stated no scope", () => {
      const grant: ApiAccessGrant = {
        access_token: "opaque-access-token",
        token_type: "Bearer",
        aud: AUD,
      };

      expect(excessScopes(grant)).toEqual([]);
    });
  });
});
