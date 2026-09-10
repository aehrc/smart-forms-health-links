/**
 * Channel D's slot: minted by the requester, written once by the filler.
 *
 * Three routes, and the split between them is the channel's trust model made concrete.
 *
 * ```text
 * POST /api/write-slots        session required   ──> { writeUrl, writeEtag, writeToken }
 * GET  /shl/slot/:id           public             ──> the QuestionnaireResponse
 * PUT  /shl/slot/:id           bearer + If-Match  ──> 200 once, 412 ever after
 * ```
 *
 * **Minting needs a session; writing does not.** Only a signed-in requester may create a slot,
 * because a slot is an offer to accept somebody's answers and an app that let anyone create them
 * would be an open relay. The filler, by construction, holds nothing but a link - so the write is
 * authorised by the token in that link and by nothing else.
 *
 * **Reading is public and deliberately so.** The filler polls to see whether the write landed, and
 * the requester polls to collect. Both hold the URL and neither can be asked to authenticate. What
 * makes that acceptable is that the URL is 128 bits of unguessable id, and that the slot is
 * transport rather than a record: it holds one unreviewed response for as long as it takes somebody
 * to collect it, and it never held anything else.
 *
 * **`If-Match` is required, not optional.** A write with no condition is refused even when the slot
 * is empty. The whole promise of the channel is that the second write fails, and a request that
 * declines to say which version it expects is not making that promise.
 * @author John Grimes
 */

import { readSessionCookie } from "../sessionCookie";
import { findActiveSessionIgnoringExpiry } from "../sessions";
import {
  etagFor,
  findWriteSlot,
  insertWriteSlot,
  writeToSlot,
} from "../shl/writeSlotStore";

import type { FastifyPluginCallback } from "fastify";

/** Content type slots are served and accepted as. */
const FHIR_JSON = "application/fhir+json";

/** Path prefix the public slot routes live under. */
export const SLOT_PATH_PREFIX = "/shl/slot";

/** What `POST /api/write-slots` answers with. */
export interface MintedWriteSlot {
  /** Absolute URL of the slot, for the invitation's write descriptor. */
  readonly writeUrl: string;
  /** The `If-Match` value a filler must send. */
  readonly writeEtag: string;
  /** The capability to write, once. */
  readonly writeToken: string;
}

/**
 * Read a bearer token from an `Authorization` header.
 * @param header the raw header, if there was one
 * @returns the token, or undefined when the header is absent or not a bearer
 */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Register the slot routes.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the routes are registered
 * @example
 * fastify.register(writeSlotRoutes);
 */
export const writeSlotRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;

  // `putResponseToSlot` sends `application/fhir+json`, which the default parser does not claim, so
  // without this a conformant filler is answered 415 rather than having its answers stored. Parsed
  // as JSON rather than kept as a buffer, because unlike the FHIR proxy this route inspects the
  // body: it has to refuse anything that is not a QuestionnaireResponse.
  fastify.addContentTypeParser(
    FHIR_JSON,
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  /**
   * Mint an empty slot for a request about to be sent.
   *
   * The body carries the empty `QuestionnaireResponse` the requester built, so that the slot is
   * seeded with the questionnaire canonical and the request identifier it belongs to rather than
   * with an anonymous placeholder. It is stored verbatim and handed back verbatim.
   */
  fastify.post("/api/write-slots", async (request, reply) => {
    const sessionId = readSessionCookie(request);
    const session =
      sessionId === undefined
        ? undefined
        : findActiveSessionIgnoringExpiry(fastify.appDb, sessionId);
    if (session === undefined) {
      return reply.code(401).send({ error: "no-session" });
    }

    const body = request.body as
      { content?: unknown; expiresAt?: unknown } | undefined;
    const content = body?.content;
    if (typeof content !== "object" || content === null) {
      return reply.code(400).send({ error: "invalid-request" });
    }
    const expiresAt =
      typeof body?.expiresAt === "number" && Number.isFinite(body.expiresAt)
        ? Math.floor(body.expiresAt)
        : null;

    const slot = insertWriteSlot(fastify.appDb, {
      content: JSON.stringify(content),
      expiresAt,
    });

    const answer: MintedWriteSlot = {
      writeUrl: new URL(`${SLOT_PATH_PREFIX}/${slot.id}`, config.appOrigin)
        .href,
      writeEtag: etagFor(slot.version),
      writeToken: slot.writeToken,
    };
    return reply.code(201).send(answer);
  });

  /**
   * Read a slot.
   *
   * The `ETag` travels with it, so a filler that did not keep the one from the link can still make
   * a conditional write, and so a requester polling for answers can tell a slot that has been
   * written from one that has not without parsing the body.
   */
  fastify.get(`${SLOT_PATH_PREFIX}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const slot = findWriteSlot(fastify.appDb, id);
    if (slot === undefined) {
      return reply.code(404).send({ error: "not-found" });
    }

    return reply
      .code(200)
      .header("content-type", FHIR_JSON)
      .header("etag", etagFor(slot.version))
      .header("cache-control", "no-store")
      .send(slot.content);
  });

  /**
   * Write the answers, at most once.
   *
   * The statuses are the ones a plain FHIR server would have given, because the filler's client was
   * written against one: `412` for a failed precondition, `403` for a bad token, `404` for a slot
   * that is gone. Keeping them means `putResponseToSlot` reads the same outcomes whether the slot
   * is hosted here or on somebody else's server, which is what lets a foreign invitation still be
   * answered.
   */
  fastify.put(`${SLOT_PATH_PREFIX}/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | undefined;
    if (typeof body !== "object" || body === null) {
      return reply.code(400).send({ error: "invalid-request" });
    }
    if (body.resourceType !== "QuestionnaireResponse") {
      return reply.code(400).send({ error: "not-a-questionnaire-response" });
    }

    const result = writeToSlot(fastify.appDb, {
      id,
      writeToken: bearerToken(request.headers.authorization),
      ifMatch: request.headers["if-match"],
      content: JSON.stringify(body),
    });

    switch (result.outcome) {
      case "written": {
        return reply
          .code(200)
          .header("content-type", FHIR_JSON)
          .header("etag", etagFor(result.slot.version))
          .send(result.slot.content);
      }
      case "taken": {
        return reply.code(412).send({ error: "already-written" });
      }
      case "refused": {
        return reply.code(403).send({ error: "forbidden" });
      }
      case "gone": {
        return reply.code(404).send({ error: "not-found" });
      }
    }
  });

  done();
};
