/**
 * Conformance vectors for the API access grant, mirroring Platypus fixtures 24-31.
 *
 * Those fixtures are the shared conformance suite for this wire shape: 24-26 are well-formed
 * grants a consumer must honour, and 27-31 are malformed ones a consumer must treat as
 * absent* - never as an error that blocks the form (`contracts/shl-wire.md`, "Consumer
 * tolerance rules"; spec FR-020).
 *
 * The vectors below are reconstructed from those written rules rather than copied out of the
 * Platypus repository, and each one is named after the rule it locks.
 *
 * ## Which side is under test
 *
 * The producer. The consumer half - reading a fetched manifest and surfacing the grant beside
 * the FHIR payload - is Phase 5 (`src/link/apiAccess.ts` gains a parser at T037), so there is
 * nothing here that imports a module which does not exist yet.
 *
 * Asserting the producer against a consumer's tolerance rules is not a category error, it is
 * the point: every shape a consumer is told to discard is a shape this app must never emit. So
 * the 27-31 group asserts that {@link buildGrant} declines rather than producing them, and the
 * manifest degrades to its one-file form - which is a state the filler already handles - rather
 * than shipping a grant that a conformant filler would throw away.
 * @author John Grimes
 */

import { describe, expect, it } from "vitest";

import type { ApiAccessGrant, GrantOptions } from "@/link/apiAccess";

import { GRANT_CONTENT_TYPE, buildGrant } from "@/link/apiAccess";

/** The destination every vector points at. */
const AUD = "https://kuzfdswqmz.edge.aidbox.app/fhir";

/** A token response that mints cleanly, as the basis for each vector. */
const WELL_FORMED: GrantOptions = {
  accessToken: "opaque-access-token",
  tokenType: "Bearer",
  expiresIn: 3600,
  aud: AUD,
  patientId: "pt-1",
  grantTtlSeconds: 3600,
};

/**
 * Build a grant from the well-formed vector with some members replaced.
 *
 * `overrides` is deliberately untyped. These vectors model what an authorisation server can
 * actually put on the wire - members absent, empty, or of the wrong type - which is exactly what
 * the producer's guards exist for, and a typed override object could not express it. The single
 * cast below is that boundary, stated once.
 * @param overrides the members to differ, as they would arrive off the wire
 * @returns the grant, or undefined when the producer declined to state one
 */
function vector(
  overrides: Record<string, unknown>,
): ApiAccessGrant | undefined {
  return buildGrant({
    ...WELL_FORMED,
    ...overrides,
  });
}

describe("grant conformance vectors", () => {
  describe("vectors 24-26: well-formed grants", () => {
    /*
     * Fixture 24: the canonical grant. Five members, no more: anything else in this object is
     * something a filler has not agreed to interpret.
     */
    it("24: a complete grant carries exactly access_token, token_type, expires_in, aud and patient", () => {
      const grant = vector({});

      expect(grant).toEqual({
        access_token: "opaque-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        aud: AUD,
        patient: "pt-1",
      });
    });

    /*
     * Fixture 25: no patient. The property is absent rather than null or empty, because a
     * consumer decides whether to write `subject` on `patient in grant`, and `patient: null`
     * would put a null subject on a QuestionnaireResponse.
     */
    it("25: a grant for a request that named no patient omits the patient property entirely", () => {
      const grant = vector({ patientId: null });

      expect(grant).toBeDefined();
      expect("patient" in (grant ?? {})).toBe(false);
    });

    /*
     * Fixture 26: the authorisation server's own lifetime is stated when it is shorter than the
     * deployment's ceiling. A consumer derives the window from `expires_in` at fetch time, so an
     * overstated lifetime is a promise the destination will not keep.
     */
    it("26: a short-lived token states its own lifetime, not the configured ceiling", () => {
      expect(vector({ expiresIn: 300 })?.expires_in).toBe(300);
      expect(vector({ expiresIn: 86_400 })?.expires_in).toBe(3600);
    });

    // The token type a consumer accepts case-insensitively is the one this app writes exactly.
    it("normalises a lower-case token type to the exact Bearer a consumer looks for", () => {
      expect(vector({ tokenType: "bearer" })?.token_type).toBe("Bearer");
    });

    // The file's content type is how a consumer finds the grant among the manifest's files.
    it("is carried in the manifest under the smart-api-access content type", () => {
      expect(GRANT_CONTENT_TYPE).toBe("application/smart-api-access");
    });
  });

  describe("vectors 27-31: malformed grants a consumer must treat as absent", () => {
    /*
     * Fixture 27: not a JSON object. A producer cannot emit "not an object" through a typed
     * builder, so the property asserted here is the one that matters downstream: whatever comes
     * back is either a plain object of the agreed shape, or nothing at all.
     */
    it("27: not a JSON object - the producer only ever yields an object or nothing", () => {
      const grant = vector({});

      expect(typeof grant).toBe("object");
      expect(Array.isArray(grant)).toBe(false);
      expect(vector({ accessToken: "" })).toBeUndefined();
    });

    // Fixture 28: `access_token` missing or empty. Nothing to present; there is no channel.
    it("28: access_token missing or empty - declined rather than emitted", () => {
      expect(vector({ accessToken: "" })).toBeUndefined();
      expect(vector({ accessToken: " ".repeat(3) })).toBeUndefined();
      expect(vector({ accessToken: undefined })).toBeUndefined();
    });

    /*
     * Fixture 29: `aud` missing or not https. A bearer token presented over http travels in the
     * clear to anyone on the path, so this is refused at the point of production too.
     */
    it("29: aud missing or not https - declined rather than emitted", () => {
      expect(vector({ aud: "" })).toBeUndefined();
      expect(vector({ aud: "http://ehr.example.org/fhir" })).toBeUndefined();
      expect(vector({ aud: "ehr.example.org/fhir" })).toBeUndefined();
      expect(vector({ aud: undefined })).toBeUndefined();
    });

    /*
     * Fixture 30: `token_type` is not Bearer. Case-insensitive on the way in, so `bearer` is
     * accepted (asserted above); anything else is a scheme this app cannot honestly restate.
     */
    it("30: token_type that is not Bearer - declined rather than restated as Bearer", () => {
      expect(vector({ tokenType: "DPoP" })).toBeUndefined();
      expect(vector({ tokenType: "" })).toBeUndefined();
      expect(vector({ tokenType: undefined })).toBeUndefined();
    });

    /*
     * Fixture 31: a missing or absurd `expires_in`. A consumer reads that as "no stated expiry"
     * and keeps offering the channel until it is refused - which is the right consumer
     * behaviour, and precisely why a producer must not lean on it. This app knows the lifetime
     * it was granted, so a grant it cannot state a window for is not one it emits.
     */
    it("31: missing or absurd expires_in - declined rather than left for the consumer to guess", () => {
      expect(vector({ expiresIn: 0 })).toBeUndefined();
      expect(vector({ expiresIn: -1 })).toBeUndefined();
      expect(vector({ expiresIn: Number.POSITIVE_INFINITY })).toBeUndefined();
      expect(vector({ expiresIn: Number.NaN })).toBeUndefined();
      expect(vector({ expiresIn: undefined })).toBeUndefined();
    });

    /*
     * The consequence of every decline above: the manifest is a one-file manifest, which the
     * filler reads as "no direct channel" and handles by offering the scan-back return. A
     * declined grant must never surface as an error that blocks the form (FR-020).
     */
    it("a declined grant is absent, never an error", () => {
      expect(() => vector({ tokenType: "DPoP" })).not.toThrow();
      expect(() =>
        vector({ aud: "http://ehr.example.org/fhir" }),
      ).not.toThrow();
      expect(() => vector({ accessToken: "" })).not.toThrow();
    });
  });
});
