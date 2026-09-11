/**
 * Tests for `server/shl/manifest.ts`: `POST /shl/:id`, the only public route that hands out
 * anything.
 *
 * Four properties are what this route is for.
 *
 *  1. **Two files, both sealed, correctly labelled.** A reader tells the invitation from the
 *     grant by `cty` before it decrypts anything, so the headers are part of the wire contract
 *     (`contracts/shl-wire.md`).
 *  2. **The grant is minted per fetch, never stored.** Two fetches of the same link produce two
 *     different tokens. That is what keeps the window short without shortening the link's life
 *     (research.md, "Token minting timing").
 *  3. **No existence oracle.** An unknown id, an expired invitation and a deleted row all
 *     answer identically, byte for byte. Anything else would let a scanner enumerate which
 *     links had ever been minted.
 *  4. **A mint failure degrades, it does not fail.** The invitation is still worth serving; the
 *     filler simply has no direct channel and falls back to returning a link (FR-017). The
 *     failure is counted and logged - without the request body, and without token material
 *     (FR-018).
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_ORIGIN,
  AWKWARD_ISSUER,
  COOKIE_SECRET,
  ISSUER,
  SMART_CONFIGURATION,
  closeHarness,
  createHarness,
  jsonResponse,
  urlOf,
} from "./support/testHarness";
import {
  deriveGrantTokenKey,
  verifyGrantToken,
} from "../../server/shl/grantToken";
import { insertInvitation } from "../../server/shl/invitationStore";
import {
  INVITATION_CONTENT_TYPE,
  grantMintFailureCount,
} from "../../server/shl/manifest";
import { cachedAccessToken } from "../../server/smart/backendServices";
import { decodeUtf8, encodeUtf8, fromBase64Url } from "../../src/link/binary";
import {
  decryptJwe,
  encryptJwe,
  generateKey,
  keyToBase64Url,
} from "../../src/link/jwe";

import type { TestHarness } from "./support/testHarness";
import type { Mock } from "vitest";

vi.mock("../../server/smart/backendServices", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../server/smart/backendServices")>();
  return { ...actual, cachedAccessToken: vi.fn() };
});

/** The invitation Bundle sealed into the stored payload. */
const INVITATION_BUNDLE = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { fullUrl: "urn:uuid:q", resource: { resourceType: "Questionnaire" } },
    { fullUrl: "urn:uuid:t", resource: { resourceType: "Task" } },
  ],
};

/** A manifest file, as the route serialises it. */
interface ManifestFile {
  contentType: string;
  embedded: string;
}

/** The grant file's plaintext. */
interface Grant {
  access_token: string;
  token_type: string;
  expires_in: number;
  aud: string;
  patient?: string;
}

/**
 * The protected header of a compact JWE.
 * @param compact the JWE
 * @returns the parsed header
 */
function headerOf(compact: string): Record<string, string> {
  return JSON.parse(
    decodeUtf8(fromBase64Url(compact.split(".", 1)[0])),
  ) as Record<string, string>;
}

describe("the SHL manifest", () => {
  let harness: TestHarness;
  let linkKey: Uint8Array;
  let mint: Mock<typeof cachedAccessToken>;
  /** How many tokens have been minted in this test, so each one is distinguishable. */
  let minted: number;

  beforeEach(() => {
    harness = createHarness();
    linkKey = generateKey();
    minted = 0;
    mint = vi.mocked(cachedAccessToken);
    mint.mockReset();
    mint.mockImplementation(() => {
      minted += 1;
      return Promise.resolve({
        access_token: `minted-token-${minted}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = urlOf(input);
        if (url.endsWith("/.well-known/smart-configuration")) {
          return Promise.resolve(jsonResponse(SMART_CONFIGURATION));
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeHarness(harness);
  });

  /**
   * Store an invitation for the manifest route to serve.
   * @param overrides fields to differ from the default invitation
   * @param overrides.patientId
   * @param overrides.expiresAt
   * @param overrides.issuer
   * @returns the stored invitation's id
   */
  async function storeInvitation(
    overrides: {
      patientId?: string | null;
      expiresAt?: number | null;
      issuer?: string;
    } = {},
  ): Promise<string> {
    const payloadCiphertext = await encryptJwe(
      encodeUtf8(JSON.stringify(INVITATION_BUNDLE)),
      linkKey,
      { contentType: INVITATION_CONTENT_TYPE },
    );
    return insertInvitation(harness.db, {
      linkKey: keyToBase64Url(linkKey),
      payloadCiphertext,
      label: "Chronic Condition Management Plan",
      expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 86_400,
      issuer: overrides.issuer ?? ISSUER,
      patientId:
        overrides.patientId === undefined ? "pt-1" : overrides.patientId,
      requestIdentifier: "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      publishedTaskUrl: `${ISSUER}/Task/task-1`,
      questionnaireCanonical: "http://example.org/Questionnaire/ccm",
    }).id;
  }

  /**
   * Fetch a manifest the way a filler does.
   * @param id the invitation id
   * @returns the injected response
   */
  async function fetchManifest(id: string) {
    return harness.server.inject({
      method: "POST",
      url: `/shl/${id}`,
      payload: { recipient: "Platypus Health" },
    });
  }

  /**
   * Fetch a manifest and hand back its files.
   * @param id the invitation id
   * @returns the files the manifest carried
   */
  async function manifestFiles(id: string): Promise<ManifestFile[]> {
    const response = await fetchManifest(id);
    return response.json<{ files: ManifestFile[] }>().files;
  }

  /**
   * The decrypted plaintext of one manifest file.
   * @param file the file to open
   * @returns its plaintext
   */
  async function open(file: ManifestFile): Promise<string> {
    return decodeUtf8(await decryptJwe(file.embedded, linkKey));
  }

  describe("the two files", () => {
    it("serves the invitation and the grant, labelled with their content types", async () => {
      const id = await storeInvitation();

      const response = await fetchManifest(id);
      const files = response.json<{ files: ManifestFile[] }>().files;

      expect(response.statusCode).toBe(200);
      expect(files.map((file) => file.contentType)).toEqual([
        "application/fhir+json",
        "application/smart-api-access",
      ]);
    });

    // A reader dispatches on `cty` before it decrypts, so the header carries it too.
    it("declares each file's content type in its JWE protected header", async () => {
      const id = await storeInvitation();

      const files = await manifestFiles(id);

      expect(headerOf(files[0].embedded)).toEqual({
        alg: "dir",
        enc: "A256GCM",
        cty: "application/fhir+json",
      });
      expect(headerOf(files[1].embedded)).toEqual({
        alg: "dir",
        enc: "A256GCM",
        cty: "application/smart-api-access",
      });
    });

    it("encrypts both files under the link key", async () => {
      const id = await storeInvitation();

      const files = await manifestFiles(id);

      expect(JSON.parse(await open(files[0]))).toEqual(INVITATION_BUNDLE);
      expect(JSON.parse(await open(files[1]))).toMatchObject({
        token_type: "Bearer",
      });
    });

    // The payload is sealed once at mint; a fetch must not re-encrypt it.
    it("serves the stored invitation ciphertext verbatim", async () => {
      const id = await storeInvitation();
      const stored = harness.db
        .prepare<[string], { payloadCiphertext: string }>(
          "SELECT payloadCiphertext FROM invitations WHERE id = ?",
        )
        .get(id);

      const files = await manifestFiles(id);

      expect(files[0].embedded).toBe(stored?.payloadCiphertext);
    });

    // Every file is embedded: there is no second host to fetch from, by design (FR-013).
    it("embeds both files rather than pointing at a location", async () => {
      const id = await storeInvitation();

      const response = await fetchManifest(id);
      const files = response.json<{
        files: (ManifestFile & { location?: string })[];
      }>().files;

      for (const file of files) {
        expect(file.embedded).toMatch(/^[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/);
        expect(file.location).toBeUndefined();
      }
    });
  });

  describe("the grant", () => {
    /*
     * The three members the facade changed. `aud` is this app, because the practice's credential
     * no longer leaves the server; `scope` is what the facade permits rather than what the backend
     * client is registered for; and `access_token` is a capability for this invitation, which is
     * why it is asserted by verifying it rather than by comparing it to a fixture.
     */
    it("names the facade as the destination and the invitation's patient", async () => {
      const id = await storeInvitation();

      const files = await manifestFiles(id);
      const grant = JSON.parse(await open(files[1])) as Grant;

      expect(grant).toMatchObject({
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          "system/QuestionnaireResponse.c system/Provenance.c " +
          "system/Task.r system/Task.u",
        aud: `${APP_ORIGIN}/shl/${id}/fhir`,
        patient: "pt-1",
      });
      expect(
        verifyGrantToken({
          key: deriveGrantTokenKey(COOKIE_SECRET),
          invitationId: id,
          token: grant.access_token,
        }),
      ).toBe(true);
    });

    /*
     * The rule that broke development and that no test could see: `aud` used to be the practice's
     * `https` FHIR base, and is now this app's own origin - which on a developer's machine is
     * `http://localhost:3000`. `buildGrant` refuses a destination a bearer token cannot safely be
     * presented to, so the manifest degraded to one file and the direct-send channel silently
     * became a scan-back. Loopback is a secure origin (`src/link/secureOrigin.ts`), and this is
     * the test that says so.
     */
    it("states a grant for a loopback development origin", async () => {
      await closeHarness(harness);
      harness = createHarness({ appOrigin: "http://localhost:3000" });
      const id = await storeInvitation();

      const files = await manifestFiles(id);
      const grant = JSON.parse(await open(files[1])) as Grant;

      expect(files).toHaveLength(2);
      expect(grant.aud).toBe(`http://localhost:3000/shl/${id}/fhir`);
    });

    // Still refused for an origin that is neither https nor loopback.
    it("states no grant for a plain http origin that is not loopback", async () => {
      await closeHarness(harness);
      harness = createHarness({ appOrigin: "http://links.example.org" });
      const id = await storeInvitation();

      const files = await manifestFiles(id);

      expect(files.map((file) => file.contentType)).toEqual([
        "application/fhir+json",
      ]);
    });

    // The token names one invitation. Presented against any other, it authorises nothing.
    it("mints a token that verifies for no other invitation", async () => {
      const id = await storeInvitation();
      const other = await storeInvitation();

      const files = await manifestFiles(id);
      const grant = JSON.parse(await open(files[1])) as Grant;

      expect(
        verifyGrantToken({
          key: deriveGrantTokenKey(COOKIE_SECRET),
          invitationId: other,
          token: grant.access_token,
        }),
      ).toBe(false);
    });

    // `patient` is present iff the request named one; an empty string would not be "absent".
    it("carries no patient property when the request named no patient", async () => {
      const id = await storeInvitation({ patientId: null });

      const files = await manifestFiles(id);
      const grant = JSON.parse(await open(files[1])) as Grant;

      expect("patient" in grant).toBe(false);
    });

    /*
     * The deployment's configured lifetime is a ceiling, not a claim: stating longer than the
     * authorisation server granted would send a filler to a destination that will refuse it.
     */
    /*
     * The upstream credential's lifetime used to be the ceiling, because it *was* the token in
     * the grant. It no longer is: the token is ours, so the window is the deployment's to state
     * and a practice handing out five-minute tokens no longer shortens what a filler is offered.
     * The facade mints upstream per write, so a short-lived credential is refreshed rather than
     * inherited.
     */
    it("states the deployment's lifetime whatever the practice's token says", async () => {
      const id = await storeInvitation();
      mint.mockResolvedValue({
        access_token: "short-lived",
        token_type: "Bearer",
        expires_in: 300,
      });

      const files = await manifestFiles(id);

      expect((JSON.parse(await open(files[1])) as Grant).expires_in).toBe(3600);
    });

    // Nor longer than the deployment configured, which is the other half of FR-016.
    it("never states a longer lifetime than the deployment configured", async () => {
      const id = await storeInvitation({ issuer: AWKWARD_ISSUER });
      mint.mockResolvedValue({
        access_token: "long-lived",
        token_type: "Bearer",
        expires_in: 86_400,
      });

      const files = await manifestFiles(id);

      // The second registered issuer configures a 900-second grant lifetime.
      expect((JSON.parse(await open(files[1])) as Grant).expires_in).toBe(900);
    });

    // The whole point of minting at fetch time rather than at mint time.
    /*
     * Still the whole point of minting at fetch time rather than at mint time, but the property is
     * now about the *window* rather than about the bytes. A capability token is a signature over
     * an invitation and an expiry, so two fetches in the same second legitimately produce the same
     * token - they mean the same thing. Two fetches an hour apart state two different windows, and
     * that is what lets a link live for thirty days while what it carries lasts an hour.
     */
    it("states a window from the moment of each fetch", async () => {
      // `Date` alone: faking the timer functions too would stall the harness's own async work.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const id = await storeInvitation();

        const first = await manifestFiles(id);
        vi.setSystemTime(Date.now() + 30 * 60 * 1000);
        const second = await manifestFiles(id);

        const firstGrant = JSON.parse(await open(first[1])) as Grant;
        const secondGrant = JSON.parse(await open(second[1])) as Grant;

        expect(secondGrant.access_token).not.toBe(firstGrant.access_token);
        // Both are for this invitation, half an hour apart.
        for (const grant of [firstGrant, secondGrant]) {
          expect(
            verifyGrantToken({
              key: deriveGrantTokenKey(COOKIE_SECRET),
              invitationId: id,
              token: grant.access_token,
            }),
          ).toBe(true);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    // The practice is still consulted on every fetch, which is what makes a dead issuer degrade.
    it("checks the practice's credential on every fetch", async () => {
      const id = await storeInvitation();

      await manifestFiles(id);
      await manifestFiles(id);

      expect(mint).toHaveBeenCalledTimes(2);
    });
  });

  describe("refusals", () => {
    it("answers 404 not-found for an id that was never minted", async () => {
      const response = await fetchManifest("never-existed");

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not-found" });
    });

    // Identical, so a fetch cannot be used to discover which links were ever minted.
    it("answers an expired invitation exactly as it answers an unknown one", async () => {
      const expired = await storeInvitation({
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });

      const expiredResponse = await fetchManifest(expired);
      const unknownResponse = await fetchManifest("never-existed");

      expect(expiredResponse.statusCode).toBe(unknownResponse.statusCode);
      expect(expiredResponse.body).toBe(unknownResponse.body);
    });

    /*
     * The third case, and the only one no route can produce today: a row that was minted and
     * is now gone. Nothing deletes an invitation, so this pins the answer before there is
     * anything to break it - the moment an expiry sweep arrives, or an operator removes a row
     * by hand, the answer has to stay this one. Platypus depends on it: a 404 before the link's
     * own `exp` reads as "not available right now", and the channel retires on `exp`, on a
     * delete on the device, or on a delivery, never on a status
     * (aehrc/smart-forms-health-links#16).
     */
    it("answers a deleted invitation exactly as it answers an unknown one", async () => {
      const deleted = await storeInvitation();
      const removed = harness.db
        .prepare("DELETE FROM invitations WHERE id = ?")
        .run(deleted);
      // Proves the id was real, so the identical answer below is about deletion and not a typo.
      expect(removed.changes).toBe(1);

      const deletedResponse = await fetchManifest(deleted);
      const unknownResponse = await fetchManifest("never-existed");

      expect(deletedResponse.statusCode).toBe(unknownResponse.statusCode);
      expect(deletedResponse.body).toBe(unknownResponse.body);
    });

    it("mints nothing for a refused fetch", async () => {
      await fetchManifest("never-existed");

      expect(mint).not.toHaveBeenCalled();
    });
  });

  describe("when the token cannot be minted", () => {
    beforeEach(() => {
      mint.mockRejectedValue(
        new Error("Backend Services token request was refused: HTTP 400"),
      );
    });

    // The invitation is still worth serving: the filler falls back to returning a link.
    it("still serves the invitation, as a one-file manifest", async () => {
      const id = await storeInvitation();

      const response = await fetchManifest(id);
      const files = response.json<{ files: ManifestFile[] }>().files;

      expect(response.statusCode).toBe(200);
      expect(files).toHaveLength(1);
      expect(files[0].contentType).toBe("application/fhir+json");
      expect(JSON.parse(await open(files[0]))).toEqual(INVITATION_BUNDLE);
    });

    it("increments the operator-visible failure counter", async () => {
      const id = await storeInvitation();
      const before = grantMintFailureCount();

      await fetchManifest(id);
      await fetchManifest(id);

      expect(grantMintFailureCount()).toBe(before + 2);
    });

    it("logs the failure against the issuer it happened on", async () => {
      const id = await storeInvitation();

      await fetchManifest(id);

      expect(harness.logLines.join("\n")).toContain(ISSUER);
      expect(harness.logLines.join("\n")).toMatch(/grant/i);
    });

    /*
     * A token response this app cannot honestly restate as a Bearer grant is a mint failure, not
     * something to paper over: emitting `token_type: "Bearer"` for a token that is not one would
     * send the filler to the destination with the wrong scheme.
     */
    it("degrades rather than restating a token that is not a Bearer token", async () => {
      const id = await storeInvitation();
      mint.mockResolvedValue({
        access_token: "not-a-bearer",
        token_type: "DPoP",
        expires_in: 3600,
      });

      const files = await manifestFiles(id);

      expect(files).toHaveLength(1);
    });

    // `aud` is where a Bearer token will be presented; http would present it in the clear.
    it("degrades rather than naming a destination that is not https", async () => {
      const insecure = insertInvitation(harness.db, {
        linkKey: keyToBase64Url(linkKey),
        payloadCiphertext: await encryptJwe(
          encodeUtf8(JSON.stringify(INVITATION_BUNDLE)),
          linkKey,
          { contentType: INVITATION_CONTENT_TYPE },
        ),
        label: "Insecure",
        expiresAt: Math.floor(Date.now() / 1000) + 86_400,
        issuer: "http://ehr.example.org/fhir",
        patientId: null,
        requestIdentifier: "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3302",
        publishedTaskUrl: "http://ehr.example.org/fhir/Task/task-2",
        questionnaireCanonical: "http://example.org/Questionnaire/ccm",
      }).id;
      mint.mockResolvedValue({
        access_token: "would-travel-in-the-clear",
        token_type: "Bearer",
        expires_in: 3600,
      });

      const files = await manifestFiles(insecure);

      expect(files).toHaveLength(1);
    });
  });

  describe("what the route never says", () => {
    // Accepted because the specification defines it; ignored because we host one payload.
    it("accepts a recipient and never writes it anywhere", async () => {
      const id = await storeInvitation();

      const response = await harness.server.inject({
        method: "POST",
        url: `/shl/${id}`,
        payload: { recipient: "Doctor Nefarious of Nowhere" },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.logLines.join("\n")).not.toContain("Doctor Nefarious");
    });

    it("serves a manifest for a request that carries no body at all", async () => {
      const id = await storeInvitation();

      const response = await harness.server.inject({
        method: "POST",
        url: `/shl/${id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ files: ManifestFile[] }>().files).toHaveLength(2);
    });

    // The token exists in the response only inside the encrypted file (FR-018).
    it("puts the minted token nowhere but inside the sealed grant", async () => {
      const id = await storeInvitation();

      const response = await fetchManifest(id);

      expect(response.body).not.toContain("minted-token-1");
      expect(harness.logLines.join("\n")).not.toContain("minted-token-1");
      expect(harness.logLines.join("\n")).not.toContain(
        keyToBase64Url(linkKey),
      );
    });

    // Nothing about the grant is written to the database (data-model.md: transient).
    it("stores nothing about the grant", async () => {
      const id = await storeInvitation();

      await fetchManifest(id);
      const row = harness.db
        .prepare<[string], Record<string, unknown>>(
          "SELECT * FROM invitations WHERE id = ?",
        )
        .get(id);

      expect(JSON.stringify(row)).not.toContain("minted-token-1");
    });
  });
});
