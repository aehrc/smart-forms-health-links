/**
 * `POST /api/invitations`: mint a link that carries the direct-return channel.
 *
 * This is the only route that writes to the launched server on the requester's behalf, and the
 * order it does things in is the contract (`contracts/http-api.md`):
 *
 * ```text
 * read the Questionnaire ──> publish the Task ──> store the row ──> answer with the link
 *          │                        │
 *          └── 502 ─────────────────┴── 502, nothing stored
 * ```
 *
 * **The Task is published before anything is hosted.** A link whose Task was never written
 * would invite a filler to complete something that does not exist on the destination, and the
 * only honest recovery from that is not to have minted it. So a failed publish is a `502` with
 * no row, no ciphertext and no link - the edge case the specification calls out.
 *
 * **The payload is sealed once.** The invitation Bundle is encrypted at mint time under a fresh
 * 256-bit key and stored as ciphertext; the server keeps the key only because the grant file has
 * to be encrypted under it later, at each manifest fetch. The plaintext Bundle is never stored.
 *
 * **The link carries no `U` flag.** `U` means "one file, fetched by GET", which is not what this
 * app hosts. The absence of a flag is the statement that the URL resolves to a manifest, and it
 * matches the Platypus fixture this contract is written against (`contracts/shl-wire.md`).
 * @author John Grimes
 */

import { randomBytes } from "node:crypto";

import { encodeUtf8, toBase64Url } from "../../src/link/binary";
import { defaultLabel } from "../../src/link/codec";
import {
  buildInvitationBundle,
  invitationRequesterDisplay,
  asPublishedTask,
} from "../../src/link/invitationBundle";
import { KEY_BYTES, encryptJwe, keyToBase64Url } from "../../src/link/jwe";
import { findIssuerRegistration } from "../config";
import { isJsonObject } from "../json";
import { readSessionCookie } from "../sessionCookie";
import { deleteSession, findActiveSessionIgnoringExpiry } from "../sessions";
import { insertInvitation } from "../shl/invitationStore";
import { INVITATION_CONTENT_TYPE } from "../shl/manifest";
import { etagFor, insertWriteSlot } from "../shl/writeSlotStore";
import { freshSession } from "../smart/sessionAuthority";

import type { ActiveSession } from "../sessions";
import type { FastifyBaseLogger, FastifyPluginCallback } from "fastify";
import type { Questionnaire } from "fhir/r4";

/** Prefix of a SMART Health Link. */
const SHL_PREFIX = "shlink:/";

/** The SMART Health Links specification caps `label` at 80 characters. */
const MAX_LABEL_LENGTH = 80;

/** How long a link stays openable when the requester does not say (data-model.md). */
const DEFAULT_LINK_LIFETIME_SECONDS = 30 * 86_400;

/** What the SPA sends to mint an invitation. */
export interface CreateInvitationBody {
  /** Id of the Questionnaire on the launched server. */
  readonly questionnaireId: string;
  /** Destination patient, when the request names one. */
  readonly patientId?: string;
  /** That patient's name, which is the part a filler can actually read. */
  readonly patientDisplay?: string;
  /**
   * The deployment's configured sender name.
   *
   * A fallback only: it is used when the launch disclosed no user, and never in preference to
   * one. A caller cannot use it to make an invitation appear to come from someone else.
   */
  readonly senderName?: string;
  /** Link expiry in epoch seconds. Defaults to 30 days from now. */
  readonly expiresAt?: number;
  /**
   * Whether to pre-allocate a channel D write slot for this request.
   *
   * The SPA's `enableOneShotWrite` flag, passed through rather than read here, because it is a
   * statement about what this deployment offers rather than about what the caller is allowed to
   * ask for. Minting a slot needs a session either way.
   */
  readonly offerWriteSlot?: boolean;
  /**
   * Answers the requester filled in from the record, already pruned to what they kept.
   *
   * Sealed into the invitation and deliberately *not* published with the Task: it is record content
   * and the published copy is a record that a request happened, not a second copy of the chart.
   */
  readonly prePopulated?: unknown;
}

/** What `POST /api/invitations` answers with. */
export interface CreateInvitationResponse {
  /** The `shlink:/` link, ready to be rendered as a QR code. */
  readonly shlink: string;
  /** Where that link's manifest is served from, on this origin. */
  readonly manifestUrl: string;
  /** When the link stops being openable, in epoch seconds. */
  readonly expiresAt: number;
  /** Absolute URL of the Task published on the issuer. */
  readonly taskUrl: string;
  /**
   * The durable `urn:uuid:` business identifier on the published Task.
   *
   * Beyond the fields `contracts/http-api.md` lists, and additive rather than a change: it is
   * already readable on the published Task the response points at, and the SPA needs it to name
   * the request back to the requester and to match returned answers to it.
   */
  readonly requestIdentifier: string;
}

/** The `shlink:/` payload, exactly as `contracts/shl-wire.md` fixes it. */
interface ShlPayload {
  /** The manifest URL. */
  readonly url: string;
  /** The 256-bit content encryption key, base64url. */
  readonly key: string;
  /** Expiry in epoch seconds, when the link has one. */
  readonly exp?: number;
  /** Human-readable label, capped at {@link MAX_LABEL_LENGTH}. */
  readonly label?: string;
}

/** A FHIR read or write that did not produce what the mint needed. */
interface UpstreamFailure {
  /** The error code to answer with. */
  readonly error: "questionnaire-unreadable" | "task-publish-failed";
  /** What went wrong, in terms safe to put in a response body. */
  readonly detail: string;
}

/**
 * Make one FHIR request with the session's authority.
 * @param session the session whose access token authorises the request
 * @param url the absolute URL on the issuer
 * @param method the HTTP method
 * @param body the serialised resource, for a write
 * @returns the response
 * @throws {TypeError} when the server cannot be reached
 */
async function fhirRequest(
  session: ActiveSession,
  url: string,
  method: string,
  body?: string,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      accept: "application/fhir+json",
      ...(body === undefined
        ? {}
        : { "content-type": "application/fhir+json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Read the Questionnaire the invitation is for.
 * @param session the session whose authority reads it
 * @param questionnaireId its id on the launched server
 * @param log the request logger
 * @returns the Questionnaire, or the failure to answer with
 */
async function readQuestionnaire(
  session: ActiveSession,
  questionnaireId: string,
  log: FastifyBaseLogger,
): Promise<Questionnaire | UpstreamFailure> {
  const url = `${session.issuer.replace(/\/+$/, "")}/Questionnaire/${encodeURIComponent(questionnaireId)}`;
  let response: Response;
  try {
    response = await fhirRequest(session, url, "GET");
  } catch (error) {
    log.error(
      { err: error, issuer: session.issuer },
      "questionnaire read failed",
    );
    return {
      error: "questionnaire-unreadable",
      detail: `the launched server could not be reached`,
    };
  }
  if (!response.ok) {
    return {
      error: "questionnaire-unreadable",
      detail: `the launched server answered HTTP ${response.status} for Questionnaire/${questionnaireId}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!isJsonObject(body) || body.resourceType !== "Questionnaire") {
    return {
      error: "questionnaire-unreadable",
      detail: `Questionnaire/${questionnaireId} did not come back as a Questionnaire`,
    };
  }
  return body as unknown as Questionnaire;
}

/**
 * Publish the request Task to the launched server (FR-010).
 * @param session the session whose authority writes it
 * @param task the Task to create, serialised
 * @param log the request logger
 * @returns the absolute URL of the created Task, or the failure to answer with
 */
async function publishTask(
  session: ActiveSession,
  task: string,
  log: FastifyBaseLogger,
): Promise<string | UpstreamFailure> {
  const base = session.issuer.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fhirRequest(session, `${base}/Task`, "POST", task);
  } catch (error) {
    log.error({ err: error, issuer: session.issuer }, "task publish failed");
    return {
      error: "task-publish-failed",
      detail: "the launched server could not be reached",
    };
  }
  if (!response.ok) {
    return {
      error: "task-publish-failed",
      detail: `the launched server answered HTTP ${response.status} to the Task write`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  /*
   * The address is derived from the issuer base and the created id rather than taken from
   * `Location`, which servers spell inconsistently (relative, versioned, or behind a different
   * host name). The filler has to be able to compare this URL's origin against the grant's
   * `aud` origin, so it must be the issuer's own.
   */
  const id = isJsonObject(body) ? body.id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    return {
      error: "task-publish-failed",
      detail: "the launched server accepted the Task but reported no id for it",
    };
  }
  return `${base}/Task/${id}`;
}

/**
 * Read the mint request body.
 * @param body the parsed request body
 * @returns the request, or undefined when it names no questionnaire
 */
function parseBody(body: unknown): CreateInvitationBody | undefined {
  if (!isJsonObject(body)) {
    return undefined;
  }
  const questionnaireId = body.questionnaireId;
  if (typeof questionnaireId !== "string" || questionnaireId.trim() === "") {
    return undefined;
  }
  const expiresAt = body.expiresAt;
  return {
    questionnaireId: questionnaireId.trim(),
    ...(typeof body.patientId === "string" && body.patientId.trim() !== ""
      ? { patientId: body.patientId.trim() }
      : {}),
    ...(typeof body.patientDisplay === "string" &&
    body.patientDisplay.trim() !== ""
      ? { patientDisplay: body.patientDisplay.trim() }
      : {}),
    ...(typeof body.senderName === "string" && body.senderName.trim() !== ""
      ? { senderName: body.senderName.trim() }
      : {}),
    ...(typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? { expiresAt: Math.floor(expiresAt) }
      : {}),
  };
}

/**
 * Register the mint route.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the route is registered
 * @example
 * fastify.register(invitationRoutes);
 */
export const invitationRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;

  fastify.post("/api/invitations", async (request, reply) => {
    const db = fastify.appDb;
    const sessionId = readSessionCookie(request);
    const stored =
      sessionId === undefined
        ? undefined
        : findActiveSessionIgnoringExpiry(db, sessionId);
    if (stored === undefined) {
      return reply.code(401).send({ error: "no-session" });
    }
    const session = await freshSession(
      { db, issuers: config.issuers, log: request.log },
      stored,
    );
    if (session === undefined) {
      deleteSession(db, stored.id);
      return reply.code(401).send({ error: "session-expired" });
    }

    const body = parseBody(request.body);
    if (body === undefined) {
      return reply.code(400).send({ error: "invalid-request" });
    }
    if (findIssuerRegistration(config.issuers, session.issuer) === undefined) {
      return reply.code(401).send({ error: "session-expired" });
    }

    const questionnaire = await readQuestionnaire(
      session,
      body.questionnaireId,
      request.log,
    );
    if ("error" in questionnaire) {
      return reply.code(502).send(questionnaire);
    }

    /*
     * Pinned across both builds of the Task: the copy published to the issuer and the copy
     * embedded in the invitation must carry the same business identifier and the same authoring
     * instant, or a filler would complete a different request from the one being tracked.
     */
    const requestId = crypto.randomUUID();
    const authoredOn = new Date().toISOString();
    const shared = {
      requestId,
      authoredOn,
      requesterDisplay: invitationRequesterDisplay(
        session.userDisplay,
        body.senderName,
      ),
      subjectReference:
        body.patientId === undefined ? undefined : `Patient/${body.patientId}`,
      subjectDisplay: body.patientDisplay,
    };

    let toPublish;
    try {
      toPublish = buildInvitationBundle(questionnaire, shared);
    } catch (error) {
      return reply.code(400).send({
        error: "questionnaire-not-invitable",
        detail:
          error instanceof Error ? error.message : "unusable questionnaire",
      });
    }

    /*
     * Published through `asPublishedTask`, which does two things the embedded copy must not.
     * It stamps the tag `/requests` searches on - without it a request lands on the server and
     * never appears as sent - and it drops `focus`, which named the Questionnaire by canonical.
     * That reference is right inside the invitation Bundle, which carries the Questionnaire with
     * it, and dangling on a server that may not hold the definition.
     */
    const taskUrl = await publishTask(
      session,
      JSON.stringify(asPublishedTask(toPublish.task)),
      request.log,
    );
    if (typeof taskUrl !== "string") {
      return reply.code(502).send(taskUrl);
    }

    const linkExpiresAt =
      body.expiresAt ??
      Math.floor(Date.now() / 1000) + DEFAULT_LINK_LIFETIME_SECONDS;

    /*
     * Channel D, when this deployment offers it. Minted before the payload is sealed, because the
     * invitation has to name a slot that already exists and nothing can be added to a link once it
     * is encrypted. A failure further down leaves an unanswered slot behind, which is harmless: an
     * empty in-progress resource that expires with the link it was minted for.
     *
     * The slot is seeded with the request's identifier and the questionnaire it answers, so that
     * answers collected from it can be matched back to the request rather than to whichever browser
     * happened to fetch them.
     */
    const slot =
      body.offerWriteSlot === true
        ? insertWriteSlot(db, {
            content: JSON.stringify({
              resourceType: "QuestionnaireResponse",
              status: "in-progress",
              questionnaire: questionnaire.url,
              identifier: {
                system: "urn:ietf:rfc:3986",
                value: `urn:uuid:${requestId}`,
              },
            }),
            expiresAt: linkExpiresAt,
          })
        : undefined;

    const invitation = buildInvitationBundle(questionnaire, {
      ...shared,
      publishedTaskUrl: taskUrl,
      ...(isJsonObject(body.prePopulated) && {
        prePopulated: body.prePopulated as never,
      }),
      ...(slot && {
        writeDescriptor: {
          writeUrl: new URL(`/shl/slot/${slot.id}`, config.appOrigin).href,
          writeMethod: "PUT" as const,
          writeEtag: etagFor(slot.version),
          writeToken: slot.writeToken,
          expiresAt: linkExpiresAt,
        },
      }),
    });

    const linkKey = new Uint8Array(randomBytes(KEY_BYTES));
    const payloadCiphertext = await encryptJwe(
      encodeUtf8(JSON.stringify(invitation.bundle)),
      linkKey,
      { contentType: INVITATION_CONTENT_TYPE },
    );

    const label = defaultLabel(questionnaire).slice(0, MAX_LABEL_LENGTH);
    const expiresAt = linkExpiresAt;

    const row = insertInvitation(db, {
      linkKey: keyToBase64Url(linkKey),
      payloadCiphertext,
      label,
      expiresAt,
      issuer: session.issuer,
      patientId: body.patientId ?? null,
      requestIdentifier: invitation.requestIdentifier,
      publishedTaskUrl: taskUrl,
      // Kept in the clear so the facade can refuse answers to a different questionnaire
      // without decrypting the payload on every write.
      questionnaireCanonical: questionnaire.url ?? null,
    });

    const manifestUrl = `${config.appOrigin.replace(/\/+$/, "")}/shl/${row.id}`;
    const payload: ShlPayload = {
      url: manifestUrl,
      key: row.linkKey,
      exp: expiresAt,
      label,
    };
    const answer: CreateInvitationResponse = {
      shlink: `${SHL_PREFIX}${toBase64Url(encodeUtf8(JSON.stringify(payload)))}`,
      manifestUrl,
      expiresAt,
      taskUrl,
      requestIdentifier: invitation.requestIdentifier,
    };
    return reply.code(201).send(answer);
  });

  done();
};
