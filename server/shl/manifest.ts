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
 * **The token is a capability for this invitation, and `aud` is the facade.** The practice's
 * system credential never leaves this server. What the filler is handed is signed here, names one
 * invitation, and is only accepted by `/shl/:id/fhir` - so a leaked link no longer exposes the
 * practice's FHIR base to whoever holds it. The upstream credential is still minted on this path,
 * because that is what discovers a dead issuer before somebody fills a form in, and because it
 * warms the cache for the write that usually follows.
 *
 * **Unknown and expired are the same answer.** `findInvitation` collapses them, and this route
 * keeps them collapsed: identical status, identical body. Distinguishing them would turn the
 * route into an oracle for which links had ever been minted. A revoked walk-in code joins them.
 *
 * **A walk-in code mints an invitation on every fetch.** The id in the path is usually an
 * invitation. For the code a practice prints on its counter it is a *standing* invitation, which
 * is not answerable itself: it is the thing scans are minted from. So a fetch mints one ordinary
 * invitation, serves the standing link's own sealed payload, and points the grant at the child:
 *
 * ```text
 * POST /shl/standing-xyz  ──> invitation file: the standing payload, unchanged
 *                             grant file:      aud = /shl/{fresh child}/fhir
 * ```
 *
 * Two people scanning the same poster therefore write to two different addresses under two
 * different tokens, and the at-most-one-response rule holds for each of them separately. Neither
 * of them has to know any of this - `directSendTarget` reads the destination out of `aud`, which
 * it already did.
 *
 * That makes minting a row something an anonymous caller can cause, which is why
 * {@link SCAN_CAP} exists. A printed code is public by construction, so the only thing between a
 * photographed poster and unbounded storage is a ceiling on the rate.
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

import {
  buildGrant,
  GRANT_CONTENT_TYPE,
  SUBMISSION_SCOPES,
} from "../../src/link/apiAccess";
import { encodeUtf8 } from "../../src/link/binary";
import { encryptJwe, keyFromBase64Url } from "../../src/link/jwe";
import { findIssuerRegistration } from "../config";
import { facadeAud } from "./facade";
import { deriveGrantTokenKey, mintGrantToken } from "./grantToken";
import {
  countRecentScans,
  findStandingInvitation,
} from "./standingInvitationStore";
import { findInvitation, insertInvitation } from "../shl/invitationStore";
import { cachedAccessToken } from "../smart/backendServices";
import { discoverSmartConfiguration } from "../smart/discovery";

import type { AppDatabase } from "../db";
import type { Invitation } from "../shl/invitationStore";
import type { FastifyPluginCallback } from "fastify";

/** How many scans one walk-in code may mint within {@link SCAN_WINDOW_SECONDS}. */
export const SCAN_CAP = 60;

/** The window the scan cap is measured over, in seconds. */
export const SCAN_WINDOW_SECONDS = 3600;

/** Content type of the invitation file: the Questionnaire and Task, as a FHIR Bundle. */
export const INVITATION_CONTENT_TYPE = "application/fhir+json";

/**
 * The invitation a manifest fetch is for, or why there is not one.
 *
 * `"too-many-scans"` is the one refusal here that is not a 404, and stating it is not a leak:
 * you only reach it by holding a code that already resolved, so it discloses nothing you did not
 * already know. Saying so plainly is better than a 404 that would tell a practice's own poster it
 * had stopped existing.
 */
type Resolved = Invitation | "not-found" | "too-many-scans";

/**
 * Resolve the id in the path to an invitation answers can be written against.
 *
 * An ordinary invitation resolves to itself. A walk-in code resolves to a **new** invitation
 * minted for this scan, carrying the standing link's payload, key, label, lifetime and issuer -
 * everything except its identity.
 *
 * Two fields are deliberately not inherited. `requestIdentifier` is minted fresh, because it is
 * the conditional-create key upstream and two walk-ins sharing one would mean the second person's
 * answers were absorbed as a replay of the first person's. `patientId` stays null, because at the
 * moment of the scan the practice holds no record of whoever is holding the phone.
 * @param db the database
 * @param id the id from the manifest URL
 * @param now current time in epoch seconds, injectable for tests
 * @returns the invitation to serve, or why there is none
 * @example
 * const resolved = resolveInvitation(fastify.appDb, request.params.id);
 */
export function resolveInvitation(
  db: AppDatabase,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
): Resolved {
  const invitation = findInvitation(db, id, now);
  if (invitation !== undefined) {
    return invitation;
  }

  const standing = findStandingInvitation(db, id, now);
  if (standing === undefined) {
    return "not-found";
  }
  if (
    countRecentScans(db, standing.id, now - SCAN_WINDOW_SECONDS) >= SCAN_CAP
  ) {
    return "too-many-scans";
  }

  return insertInvitation(
    db,
    {
      linkKey: standing.linkKey,
      payloadCiphertext: standing.payloadCiphertext,
      label: standing.label,
      expiresAt: standing.expiresAt,
      issuer: standing.issuer,
      patientId: null,
      requestIdentifier: `urn:uuid:${crypto.randomUUID()}`,
      publishedTaskUrl: standing.publishedTaskUrl,
      questionnaireCanonical: standing.questionnaireCanonical,
      standingId: standing.id,
    },
    now,
  );
}

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
  const grantKey = deriveGrantTokenKey(config.cookieSecret);

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
      const resolved = resolveInvitation(fastify.appDb, request.params.id);
      if (resolved === "not-found") {
        return reply.code(404).send({ error: "not-found" });
      }
      if (resolved === "too-many-scans") {
        return reply.code(429).send({ error: "too-many-scans" });
      }
      const invitation = resolved;

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
        /*
         * The practice's own credential is still minted here, and it is still what a failure to
         * mint degrades on - but it is no longer what the filler is given. Minting it now warms
         * the cache for the write that is about to follow and, more importantly, keeps this the
         * moment a dead issuer is discovered: a grant handed out for a destination that cannot
         * be reached would be found out only after somebody had filled the form in.
         */
        const smart = await discoverSmartConfiguration(invitation.issuer);
        const upstream = await cachedAccessToken({
          registration,
          tokenEndpoint: smart.tokenEndpoint,
        });
        /*
         * `buildGrant` used to refuse a token this app could not present as a Bearer, and that
         * refusal is what degraded the manifest to one file. The grant's own token is now always
         * a Bearer because this app signs it, so the check has to be made here instead - the
         * facade presents the *practice's* token in an `Authorization: Bearer` header, and a
         * destination issuing anything else is one no write would succeed against.
         */
        if (upstream.token_type.trim().toLowerCase() !== "bearer") {
          throw new Error(
            `${invitation.issuer} issued a ${upstream.token_type} token, which cannot be ` +
              "presented as a Bearer",
          );
        }

        const ttl = registration.grantTtlSeconds;
        const grant = buildGrant({
          /*
           * A capability token for this invitation, not the practice's system credential. The
           * window is ours to state now, because the token is ours to sign - the upstream
           * credential's own lifetime no longer has anything to do with what the filler holds.
           */
          accessToken: mintGrantToken({
            key: grantKey,
            invitationId: invitation.id,
            expiresAt: Math.floor(Date.now() / 1000) + ttl,
          }),
          tokenType: "Bearer",
          expiresIn: ttl,
          /*
           * What the *facade* permits, which is narrower than what the backend client is
           * registered for. The registered scopes describe the system's authority; these four
           * describe the one submission this link is for, which is what a consumer deciding
           * whether to use the grant actually needs to know.
           */
          scope: SUBMISSION_SCOPES.join(" "),
          aud: facadeAud(config.appOrigin, invitation.id),
          patientId: invitation.patientId,
          grantTtlSeconds: ttl,
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
