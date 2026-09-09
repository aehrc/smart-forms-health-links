/**
 * Grant consumption: reading the manifest's second file, and refusing to be broken by it.
 *
 * Two things are under test, and they are separable on purpose.
 *
 * **{@link parseGrant}, the tolerance rules.** `contracts/shl-wire.md` lists five shapes a
 * consumer must treat as *absent* rather than as an error, and one that must **not** be treated
 * as absent: a missing or absurd `expires_in` means "no stated expiry", which is a grant that
 * still works, not an expired one. Each rule below is one test, named after the rule, because
 * the failure mode being guarded against is a well-meaning "surely this is invalid too" that
 * quietly closes the channel (or, worse, opens it on a token that cannot be presented).
 *
 * **{@link shlCodec}, the dispatch.** A manifest is a list of files with content types, and the
 * grant is one of them. It must be surfaced *beside* the FHIR payload and never inside it: a
 * grant that reached the resource extractor would either be discarded with a warning aimed at
 * the reader ("some of this link was not shown") or, worse, merged into the Bundle the form is
 * built from. Neither is a thing a filler should ever see.
 *
 * The through-line of both halves is FR-020: a malformed grant is absent, never an error that
 * blocks the form. Every negative case here therefore asserts two things - no grant, *and* the
 * invitation still opened.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiAccessGrant } from "@/link/apiAccess";

import {
  GRANT_CONTENT_TYPE,
  destinationHost,
  grantExpiresAt,
  isGrantExpired,
  parseGrant,
} from "@/link/apiAccess";
import { encodeUtf8, toBase64Url } from "@/link/binary";
import { encryptJwe, generateKey, keyToBase64Url } from "@/link/jwe";
import { shlCodec } from "@/link/shlCodec";

/** The destination every grant in this file points at. */
const AUD = "https://sczsqtqcgi.aidbox.app/fhir";

/** A grant exactly as the contract writes it. */
const WELL_FORMED = {
  access_token: "opaque-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  scope:
    "system/QuestionnaireResponse.c system/Provenance.c system/Task.r system/Task.u",
  aud: AUD,
  patient: "pt-demo",
};

/**
 * Parse a grant from a value, as it would arrive off the wire.
 *
 * The plaintext of a manifest file is text, so that is what the parser takes; the tests express
 * their vectors as values and serialise them here. `unknown` rather than a typed override object
 * because the whole point of these vectors is shapes the type system forbids.
 * @param value the grant file's plaintext, as a value
 * @returns the parsed grant, or undefined when it was treated as absent
 */
function parse(value: unknown): ApiAccessGrant | undefined {
  return parseGrant(JSON.stringify(value));
}

/** The invitation payload the manifest's first file carries. */
const INVITATION_BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      fullUrl: "urn:uuid:q",
      resource: {
        resourceType: "Questionnaire",
        url: "http://example.org/Questionnaire/q",
        status: "active",
      },
    },
    {
      fullUrl: "urn:uuid:t",
      resource: {
        resourceType: "Task",
        status: "requested",
        intent: "order",
        identifier: [
          { system: "urn:ietf:rfc:3986", value: "urn:uuid:request-1" },
        ],
      },
    },
  ],
};

describe("grant consumption", () => {
  describe("tolerance rules from contracts/shl-wire.md", () => {
    // The happy path first, so every negative below is a difference from something that works.
    it("reads a well-formed grant, keeping exactly the six members the contract defines", () => {
      expect(parse(WELL_FORMED)).toEqual({
        access_token: "opaque-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          "system/QuestionnaireResponse.c system/Provenance.c system/Task.r system/Task.u",
        aud: AUD,
        patient: "pt-demo",
      });
    });

    /*
     * `patient` is absent, not null: a consumer decides whether to write `subject` on the
     * response by asking whether the grant named a patient, and a null would put a null subject
     * on a QuestionnaireResponse.
     */
    it("omits patient entirely when the grant named none", () => {
      const grant = parse({ ...WELL_FORMED, patient: undefined });

      expect(grant).toBeDefined();
      expect("patient" in (grant ?? {})).toBe(false);
    });

    // A member the contract does not define is one no filler has agreed to interpret.
    it("keeps nothing beyond the contract's members", () => {
      const grant = parse({
        ...WELL_FORMED,
        refresh_token: "not-ours-to-hold",
        smart_style_url: "https://ehr.example.org/style.json",
        id_token: "…",
      });

      expect(Object.keys(grant ?? {}).toSorted()).toEqual([
        "access_token",
        "aud",
        "expires_in",
        "patient",
        "scope",
        "token_type",
      ]);
    });

    // Rule: treat as absent when the payload is not a JSON object.
    it("treats a payload that is not a JSON object as absent", () => {
      expect(parseGrant("not json at all")).toBeUndefined();
      expect(parseGrant("")).toBeUndefined();
      expect(parse(null)).toBeUndefined();
      expect(parse(42)).toBeUndefined();
      expect(parse("a string")).toBeUndefined();
      expect(parse([WELL_FORMED])).toBeUndefined();
    });

    // Rule: treat as absent when `access_token` is missing or empty.
    it("treats a missing or empty access_token as absent", () => {
      expect(
        parse({ ...WELL_FORMED, access_token: undefined }),
      ).toBeUndefined();
      expect(parse({ ...WELL_FORMED, access_token: "" })).toBeUndefined();
      expect(
        parse({ ...WELL_FORMED, access_token: " ".repeat(3) }),
      ).toBeUndefined();
      expect(parse({ ...WELL_FORMED, access_token: 1234 })).toBeUndefined();
    });

    // Rule: treat as absent when `aud` is missing or not https - a bearer token over http is
    // a token handed to whoever is on the path.
    it("treats a missing or non-https aud as absent", () => {
      expect(parse({ ...WELL_FORMED, aud: undefined })).toBeUndefined();
      expect(parse({ ...WELL_FORMED, aud: "" })).toBeUndefined();
      expect(
        parse({ ...WELL_FORMED, aud: "http://ehr.example.org/fhir" }),
      ).toBeUndefined();
      expect(
        parse({ ...WELL_FORMED, aud: "ehr.example.org/fhir" }),
      ).toBeUndefined();
    });

    // Rule: treat as absent when `token_type` is not Bearer, compared case-insensitively.
    it("treats a token_type that is not Bearer as absent, case-insensitively", () => {
      expect(parse({ ...WELL_FORMED, token_type: "bearer" })?.token_type).toBe(
        "Bearer",
      );
      expect(parse({ ...WELL_FORMED, token_type: "BEARER" })?.token_type).toBe(
        "Bearer",
      );
      expect(parse({ ...WELL_FORMED, token_type: "DPoP" })).toBeUndefined();
      expect(parse({ ...WELL_FORMED, token_type: undefined })).toBeUndefined();
      expect(parse({ ...WELL_FORMED, token_type: "" })).toBeUndefined();
    });

    /*
     * Rule: a missing or absurd `expires_in` means "no stated expiry", which is **not** the same
     * as expired. This is the one tolerance rule that is easy to get backwards, and getting it
     * backwards silently closes a working channel. The grant survives; it simply has no window
     * to check, so it is offered until the destination refuses it.
     */
    it("reads a missing or absurd expires_in as no stated expiry, not as expired", () => {
      for (const expiresIn of [
        undefined,
        0,
        -1,
        "3600",
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const grant = parse({ ...WELL_FORMED, expires_in: expiresIn });

        expect(grant, `expires_in: ${String(expiresIn)}`).toBeDefined();
        expect("expires_in" in (grant ?? {})).toBe(false);

        const received = { grant: grant!, receivedAt: 1_000_000 };
        expect(grantExpiresAt(received)).toBeUndefined();
        // Far in the future, and still not expired: there is no window to have passed.
        expect(isGrantExpired(received, 1_000_000 + 400 * 86_400_000)).toBe(
          false,
        );
      }
    });

    // A stated window is measured from when the manifest was read, never against a server clock.
    it("derives the expiry window from the moment the grant was received", () => {
      const received = {
        grant: parse(WELL_FORMED)!,
        receivedAt: 1_700_000_000_000,
      };

      expect(grantExpiresAt(received)).toBe(1_700_000_000_000 + 3600 * 1000);
      expect(isGrantExpired(received, 1_700_000_000_000 + 3599 * 1000)).toBe(
        false,
      );
      expect(isGrantExpired(received, 1_700_000_000_000 + 3601 * 1000)).toBe(
        true,
      );
    });

    // Every rule above returns; none of them throws. FR-020: absent, never an error.
    it("never throws, whatever the file contained", () => {
      for (const text of [
        "",
        "{",
        "null",
        "[]",
        JSON.stringify({ token_type: "DPoP" }),
        JSON.stringify({ ...WELL_FORMED, aud: "http://ehr.example.org" }),
      ]) {
        expect(() => parseGrant(text)).not.toThrow();
      }
    });

    // The host, not the whole URL: it is what the disclosure has to name (FR-020).
    it("names the destination by host, not by URL", () => {
      expect(destinationHost(parse(WELL_FORMED)!)).toBe(
        "sczsqtqcgi.aidbox.app",
      );
    });
  });

  describe("manifest content-type dispatch", () => {
    let key: Uint8Array;
    let fragment: string;
    /** The files the stubbed manifest server hands back. */
    let files: { contentType: string; embedded: string }[];

    /**
     * Seal a plaintext as a manifest file, labelled with its content type.
     * @param contentType the file's content type, as the manifest declares it
     * @param plaintext the file's plaintext
     * @returns the manifest file entry
     */
    async function file(
      contentType: string,
      plaintext: string,
    ): Promise<{ contentType: string; embedded: string }> {
      return {
        contentType,
        embedded: await encryptJwe(encodeUtf8(plaintext), key, { contentType }),
      };
    }

    beforeEach(async () => {
      key = generateKey();
      fragment = `shlink:/${toBase64Url(
        encodeUtf8(
          JSON.stringify({
            url: "https://app.example.org/shl/inv-1",
            key: keyToBase64Url(key),
            label: "Adult Sepsis Screening",
          }),
        ),
      )}`;

      files = [
        await file("application/fhir+json", JSON.stringify(INVITATION_BUNDLE)),
        await file(GRANT_CONTENT_TYPE, JSON.stringify(WELL_FORMED)),
      ];

      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockImplementation(() => Promise.resolve(Response.json({ files }))),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // The grant sits beside the payload. The Bundle the form is built from is untouched by it.
    it("surfaces the grant beside the FHIR payload, never inside it", async () => {
      const content = await shlCodec.decode(fragment);

      expect(content.apiAccess?.grant).toEqual({
        access_token: "opaque-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          "system/QuestionnaireResponse.c system/Provenance.c system/Task.r system/Task.u",
        aud: AUD,
        patient: "pt-demo",
      });
      expect(
        content.bundle.entry?.map((entry) => entry.resource?.resourceType),
      ).toEqual(["Questionnaire", "Task"]);
    });

    // The moment of reading is the only clock the window is measured against.
    it("records when the grant was received", async () => {
      const before = Date.now();
      const content = await shlCodec.decode(fragment);
      const after = Date.now();

      expect(content.apiAccess?.receivedAt).toBeGreaterThanOrEqual(before);
      expect(content.apiAccess?.receivedAt).toBeLessThanOrEqual(after);
    });

    /*
     * The grant is not content the reader asked to see, so its presence must not produce the
     * "some of this link was not shown" warning that a genuinely unrenderable file does.
     */
    it("does not report the grant file as content it could not show", async () => {
      const content = await shlCodec.decode(fragment);

      expect(content.warnings).toBeUndefined();
    });

    // ...but a file that really is neither payload nor grant is still reported.
    it("still reports a file that is neither the payload nor the grant", async () => {
      files.push(await file("application/pdf", "%PDF-1.7"));

      const content = await shlCodec.decode(fragment);

      expect(content.warnings?.join(" ")).toContain("application/pdf");
      expect(content.apiAccess).toBeDefined();
    });

    // `application/smart-api-access;charset=utf-8` is the same content type.
    it("recognises the grant content type with a charset parameter", async () => {
      files[1] = {
        ...files[1],
        contentType: `${GRANT_CONTENT_TYPE};charset=utf-8`,
      };

      const content = await shlCodec.decode(fragment);

      expect(content.apiAccess?.grant.access_token).toBe("opaque-access-token");
    });

    // A one-file manifest is the degraded form the producer falls back to. No channel, no error.
    it("yields no grant when the manifest carried only the invitation", async () => {
      files = [files[0]];

      const content = await shlCodec.decode(fragment);

      expect(content.apiAccess).toBeUndefined();
      expect(content.bundle.entry).toHaveLength(2);
    });

    // FR-020, at the codec boundary: a malformed grant is absent and blocks nothing.
    it("yields no grant, and still opens the invitation, when the grant is malformed", async () => {
      files[1] = await file(
        GRANT_CONTENT_TYPE,
        JSON.stringify({ ...WELL_FORMED, token_type: "DPoP" }),
      );

      const content = await shlCodec.decode(fragment);

      expect(content.apiAccess).toBeUndefined();
      expect(content.bundle.entry).toHaveLength(2);
    });

    // A grant file sealed under a different key is the same story: no channel, form unaffected.
    it("yields no grant, and still opens the invitation, when the grant will not decrypt", async () => {
      const otherKey = generateKey();
      files[1] = {
        contentType: GRANT_CONTENT_TYPE,
        embedded: await encryptJwe(
          encodeUtf8(JSON.stringify(WELL_FORMED)),
          otherKey,
          { contentType: GRANT_CONTENT_TYPE },
        ),
      };

      const content = await shlCodec.decode(fragment);

      expect(content.apiAccess).toBeUndefined();
      expect(content.bundle.entry).toHaveLength(2);
    });

    /*
     * The reverse of the first test, stated on its own because it is the failure that would do
     * real damage: a grant fed to the resource extractor is a token in the form's Bundle.
     */
    it("never lets the grant file reach the resource extractor", async () => {
      const content = await shlCodec.decode(fragment);

      expect(JSON.stringify(content.bundle)).not.toContain(
        "opaque-access-token",
      );
    });
  });
});
