/**
 * `POST /shl/:id`: the SMART Health Link manifest, and the only public route that hands
 * anything out.
 *
 * A fetch produces two encrypted files - the invitation Bundle, sealed once when the link was
 * minted, and an API access grant minted right now:
 *
 * ```text
 * POST /shl/inv-abc123          ──> { files: [ {cty: application/fhir+json},
 *   { "recipient": "…" }                       {cty: application/smart-api-access} ] }
 * ```
 *
 * Four decisions are worth stating.
 *
 * **The grant is minted per fetch and stored nowhere.** That is what lets a link live for
 * thirty days while the token inside it lives for an hour: the window is short without the link
 * being short (research.md, "Token minting timing"). Two fetches therefore produce two
 * different tokens, which is a property the tests assert rather than an accident.
 *
 * **Unknown and expired are the same answer.** `findInvitation` collapses them, and this route
 * keeps them collapsed: identical status, identical body. Distinguishing them would turn the
 * route into an oracle for which links had ever been minted.
 *
 * **A mint failure degrades rather than fails.** The invitation is still worth serving - the
 * filler simply has no direct channel and falls back to returning a link - so the manifest goes
 * out with one file, the failure is counted ({@link grantMintFailureCount}) and it is logged
 * against its issuer (FR-017).
 *
 * **The request body is never parsed.** `recipient` is accepted because the specification
 * defines it, and this app has nothing to do with it: one payload, one key, no per-recipient
 * variation. Discarding the body unread is the strongest form of "never logged" available
 * (FR-018).
 * @author John Grimes
 */

import { buildGrant, GRANT_CONTENT_TYPE } from "../../src/link/apiAccess";
import { encodeUtf8 } from "../../src/link/binary";
import { encryptJwe, keyFromBase64Url } from "../../src/link/jwe";
import { findIssuerRegistration } from "../config";
import { findInvitation } from "../shl/invitationStore";
import { mintAccessToken } from "../smart/backendServices";
import { discoverSmartConfiguration } from "../smart/discovery";

import type { FastifyPluginCallback } from "fastify";

/** Content type of the invitation file: the Questionnaire and Task, as a FHIR Bundle. */
export const INVITATION_CONTENT_TYPE = "application/fhir+json";

/**
 * How many grant mints have failed since the process started.
 *
 * Module-level rather than per-instance because it describes the process, which is what an
 * operator is watching. Read through {@link grantMintFailureCount}.
 */
let grantMintFailures = 0;

/** One file of a manifest. Always embedded: there is no second host to fetch from. */
export interface ManifestFile {
  /** The file's content type, matching the `cty` in its JWE header. */
  readonly contentType: string;
  /** The JWE compact serialisation, encrypted under the link key. */
  readonly embedded: string;
}

/** What `POST /shl/:id` answers with. */
export interface Manifest {
  /** The invitation file, then the grant file when one could be minted. */
  readonly files: readonly ManifestFile[];
}

/**
 * How many grant mints have failed since the process started.
 *
 * The counter an operator watches when direct return stops working across the board (FR-017).
 * Every increment is also a log line naming the issuer it happened on.
 * @returns the running total
 * @example
 * fastify.log.info({ grantMintFailures: grantMintFailureCount() }, "manifest health");
 */
export function grantMintFailureCount(): number {
  return grantMintFailures;
}

/**
 * Register the manifest route.
 *
 * The plugin removes its own content type parsers and installs one that discards whatever
 * arrives, so the request body is never parsed, retained or logged. Because the plugin is
 * registered without `fastify-plugin`, that applies to this route alone.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the route is registered
 * @example
 * fastify.register(manifestRoutes);
 */
export const manifestRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;

  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (_request, _body, parsed) => {
      // The body is read off the socket and dropped. Nothing downstream can log what it said.
      parsed(null);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/shl/:id",
    async (request, reply) => {
      const invitation = findInvitation(fastify.appDb, request.params.id);
      if (invitation === undefined) {
        return reply.code(404).send({ error: "not-found" });
      }

      const key = keyFromBase64Url(invitation.linkKey);
      const files: ManifestFile[] = [
        {
          contentType: INVITATION_CONTENT_TYPE,
          embedded: invitation.payloadCiphertext,
        },
      ];

      try {
        const registration = findIssuerRegistration(
          config.issuers,
          invitation.issuer,
        );
        if (registration === undefined) {
          throw new Error(
            `${invitation.issuer} is no longer a registered issuer`,
          );
        }
        const smart = await discoverSmartConfiguration(invitation.issuer);
        const token = await mintAccessToken({
          registration,
          tokenEndpoint: smart.tokenEndpoint,
        });
        const grant = buildGrant({
          accessToken: token.access_token,
          tokenType: token.token_type,
          expiresIn: token.expires_in,
          aud: invitation.issuer,
          patientId: invitation.patientId,
          grantTtlSeconds: registration.grantTtlSeconds,
        });
        if (grant === undefined) {
          throw new Error(
            "the token response cannot be stated as a Bearer grant for an https destination",
          );
        }
        files.push({
          contentType: GRANT_CONTENT_TYPE,
          embedded: await encryptJwe(encodeUtf8(JSON.stringify(grant)), key, {
            contentType: GRANT_CONTENT_TYPE,
          }),
        });
      } catch (error) {
        grantMintFailures += 1;
        request.log.error(
          {
            err: error,
            issuer: invitation.issuer,
            grantMintFailures,
          },
          "grant mint failed; serving the invitation without a grant file",
        );
      }

      const manifest: Manifest = { files };
      return reply.send(manifest);
    },
  );

  done();
};
