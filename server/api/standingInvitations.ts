/**
 * `/api/standing-invitations`: the walk-in code a practice prints once.
 *
 * `POST /api/invitations` mints a link for one named person and expects one answer back. This
 * route mints a link for nobody in particular:
 *
 * ```text
 * POST   /api/standing-invitations            create one, print its QR
 * GET    /api/standing-invitations            list this practice's codes, and their scan counts
 * POST   /api/standing-invitations/:id/revoke  stop a printed code resolving
 * POST   /api/standing-invitations/:id/refresh seal the current copy of its form into it
 * ```
 *
 * **Refresh keeps the printed code.** A code seals a copy of its form when it is created, and
 * every scan is served that copy, so editing the form upstream changes nothing on the wall.
 * Refresh reads the form again by the id it was sealed with and re-seals the payload with the
 * same key under the same id. Those two are the whole printed link, so the QR stays valid and only
 * what it serves changes. It refuses a form whose `url` or `version` differs, because the sealed
 * Task names the form by that canonical.
 *
 * The mint does the same three things in the same order as the per-request one - read the
 * Questionnaire, publish the Task, store the row - and it reuses those steps rather than
 * reimplementing them, so a failed publish is a `502` with nothing stored here either.
 *
 * Four things it deliberately does *not* do, each because there is no patient yet.
 *
 * **No subject.** Nothing is sealed into the payload about who is filling it in, because at the
 * moment the poster is printed nobody is.
 *
 * **No pre-population.** There is no record to fill the form from.
 *
 * **No write slot.** Channel D pre-allocates one resource per invitation, and a standing link has
 * no idea how many it will need.
 *
 * **No `publishedTaskUrl` in the sealed Bundle.** This is the subtle one. The sealed copy of the
 * Task normally carries the published Task's own address, which is how both return channels flip
 * it to `completed`. Here the published Task is the *standing* request, which serves every walk-in
 * who ever scans the poster - so the first person to answer must not finish it. Omitting the
 * address is what stops them, and it costs nothing else: `buildInvitationBundle` treats every
 * field as optional, and the direct send already degrades cleanly when there is no Task to read
 * (FR-022).
 * @author John Grimes
 */

import { randomBytes } from "node:crypto";

import { decodeUtf8, encodeUtf8, toBase64Url } from "../../src/link/binary";
import { defaultLabel } from "../../src/link/codec";
import {
  asPublishedTask,
  buildInvitationBundle,
  invitationRequesterDisplay,
} from "../../src/link/invitationBundle";
import {
  KEY_BYTES,
  decryptJwe,
  encryptJwe,
  keyFromBase64Url,
  keyToBase64Url,
} from "../../src/link/jwe";
import { findIssuerRegistration } from "../config";
import { isJsonObject } from "../json";
import { readSessionCookie } from "../sessionCookie";
import { deleteSession, findActiveSessionIgnoringExpiry } from "../sessions";
import {
  DEFAULT_LINK_LIFETIME_SECONDS,
  MAX_LABEL_LENGTH,
  SHL_PREFIX,
  publishTask,
  readQuestionnaire,
  type ShlPayload,
} from "./invitations";
import { INVITATION_CONTENT_TYPE } from "../shl/manifest";
import {
  findStandingInvitation,
  insertStandingInvitation,
  listStandingInvitations,
  replaceStandingInvitationPayload,
  revokeStandingInvitation,
} from "../shl/standingInvitationStore";
import { freshSession } from "../smart/sessionAuthority";

import type { ActiveSession } from "../sessions";
import type { StandingInvitationSummary } from "../shl/standingInvitationStore";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import type { Bundle, Questionnaire } from "fhir/r4";

/** The outcome of the staff gate: a usable session, or the refusal to answer with. */
type SessionGate =
  | { readonly ok: true; readonly session: ActiveSession }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: "no-session" | "session-expired";
    };

/** What the SPA sends to create a walk-in code. */
export interface CreateStandingInvitationBody {
  /** Id of the Questionnaire on the launched server. */
  readonly questionnaireId: string;
  /**
   * When the printed code stops working, in epoch seconds.
   *
   * Independent of the one-hour credential inside it, and that separation is the point: a poster
   * on a wall has to keep working for months while the token a scan receives lasts an hour. The
   * default is the same 30 days a per-request link gets.
   */
  readonly expiresAt?: number;
  /** The deployment's configured sender name, used only when the launch disclosed no user. */
  readonly senderName?: string;
}

/** One walk-in code, as the staff-facing list shows it. */
export interface StandingInvitationView {
  /** The row id, also the last segment of its manifest URL. */
  readonly id: string;
  /** The `shlink:/` link, so the QR can be printed again without minting a second code. */
  readonly shlink: string;
  /** Where the link's manifest is served from. */
  readonly manifestUrl: string;
  /** The label, normally the questionnaire title. */
  readonly label: string;
  /** Canonical URL of the questionnaire, or null when it declared none. */
  readonly questionnaireCanonical: string | null;
  /** When the code stops working, in epoch seconds, or null when it never does. */
  readonly expiresAt: number | null;
  /** When staff withdrew it, in epoch seconds, or null while it is live. */
  readonly revokedAt: number | null;
  /** When it was created, in epoch seconds. */
  readonly createdAt: number;
  /** Absolute URL of the standing Task published on the issuer. */
  readonly taskUrl: string;
  /** How many scans have minted an invitation from it. */
  readonly scans: number;
  /** How many of those produced answers the practice accepted. */
  readonly answered: number;
}

/** What `POST /api/standing-invitations` answers with. */
export type CreateStandingInvitationResponse = StandingInvitationView;

/**
 * Read the create body.
 * @param body the parsed request body
 * @returns the request, or undefined when it names no questionnaire
 */
function parseBody(body: unknown): CreateStandingInvitationBody | undefined {
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
    ...(typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? { expiresAt: Math.floor(expiresAt) }
      : {}),
    ...(typeof body.senderName === "string" && body.senderName.trim() !== ""
      ? { senderName: body.senderName.trim() }
      : {}),
  };
}

/**
 * Register the walk-in code routes.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the routes are registered
 * @example
 * fastify.register(standingInvitationRoutes);
 */
export const standingInvitationRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;
  const origin = config.appOrigin.replace(/\/+$/, "");

  /**
   * Restate a stored row as the SPA sees it, rebuilding its link from the key we kept.
   * @param row the stored row, with its scan counts
   * @returns the view
   */
  function asView(row: StandingInvitationSummary): StandingInvitationView {
    const manifestUrl = `${origin}/shl/${row.id}`;
    const payload: ShlPayload = {
      url: manifestUrl,
      key: row.linkKey,
      ...(row.expiresAt === null ? {} : { exp: row.expiresAt }),
      label: row.label,
    };
    return {
      id: row.id,
      shlink: `${SHL_PREFIX}${toBase64Url(encodeUtf8(JSON.stringify(payload)))}`,
      manifestUrl,
      label: row.label,
      questionnaireCanonical: row.questionnaireCanonical,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
      taskUrl: row.publishedTaskUrl,
      scans: row.scans,
      answered: row.answered,
    };
  }

  /**
   * The session this request may act with, or why it may not act at all.
   *
   * Every route here is a staff route, so the gate is the same one `POST /api/invitations` uses:
   * a cookie, a row, a token refreshed if it needed refreshing, and an issuer still in the
   * registry. Factored out because three routes need it and a gate that is written three times is
   * a gate that ends up different in one of them.
   * @param request the incoming request
   * @returns the fresh session, or the refusal to answer with
   */
  async function sessionFor(request: FastifyRequest): Promise<SessionGate> {
    const db = fastify.appDb;
    const sessionId = readSessionCookie(request);
    const stored =
      sessionId === undefined
        ? undefined
        : findActiveSessionIgnoringExpiry(db, sessionId);
    if (stored === undefined) {
      return { ok: false, status: 401, error: "no-session" };
    }
    const session = await freshSession(
      { db, issuers: config.issuers, log: request.log },
      stored,
    );
    if (session === undefined) {
      deleteSession(db, stored.id);
      return { ok: false, status: 401, error: "session-expired" };
    }
    if (findIssuerRegistration(config.issuers, session.issuer) === undefined) {
      return { ok: false, status: 401, error: "session-expired" };
    }
    return { ok: true, session };
  }

  fastify.post("/api/standing-invitations", async (request, reply) => {
    const db = fastify.appDb;
    const gate = await sessionFor(request);
    if (!gate.ok) {
      return reply.code(gate.status).send({ error: gate.error });
    }
    const session = gate.session;

    const body = parseBody(request.body);
    if (body === undefined) {
      return reply.code(400).send({ error: "invalid-request" });
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
     * Pinned across both builds of the Task, as the per-request mint pins them, so the standing
     * request the practice can see and the one sealed into the poster are the same request.
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
    };

    /*
     * Built once, and sealed with no `publishedTaskUrl`, which is what stops the first walk-in
     * completing the standing request on everybody else's behalf. See this module's header. The
     * per-request mint builds twice because its second copy carries a Task address, a seed and a
     * write slot; a standing link has none of the three, so the published copy and the sealed copy
     * are the same Task.
     */
    let invitation;
    try {
      invitation = buildInvitationBundle(questionnaire, shared);
    } catch (error) {
      return reply.code(400).send({
        error: "questionnaire-not-invitable",
        detail:
          error instanceof Error ? error.message : "unusable questionnaire",
      });
    }

    // Tagged twice: once so the practice sees it among everything else this app has asked for,
    // and once so `/requests` knows not to report a standing request as awaiting answers.
    const taskUrl = await publishTask(
      session,
      JSON.stringify(asPublishedTask(invitation.task, true)),
      request.log,
    );
    if (typeof taskUrl !== "string") {
      return reply.code(502).send(taskUrl);
    }

    const expiresAt =
      body.expiresAt ??
      Math.floor(Date.now() / 1000) + DEFAULT_LINK_LIFETIME_SECONDS;

    const linkKey = new Uint8Array(randomBytes(KEY_BYTES));
    const payloadCiphertext = await encryptJwe(
      encodeUtf8(JSON.stringify(invitation.bundle)),
      linkKey,
      { contentType: INVITATION_CONTENT_TYPE },
    );

    const row = insertStandingInvitation(db, {
      linkKey: keyToBase64Url(linkKey),
      payloadCiphertext,
      label: defaultLabel(questionnaire).slice(0, MAX_LABEL_LENGTH),
      expiresAt,
      issuer: session.issuer,
      requestIdentifier: invitation.requestIdentifier,
      publishedTaskUrl: taskUrl,
      questionnaireCanonical: questionnaire.url ?? null,
    });

    return reply.code(201).send(asView({ ...row, scans: 0, answered: 0 }));
  });

  fastify.get("/api/standing-invitations", async (request, reply) => {
    const gate = await sessionFor(request);
    if (!gate.ok) {
      return reply.code(gate.status).send({ error: gate.error });
    }
    const rows = listStandingInvitations(fastify.appDb, gate.session.issuer);
    return reply.send({
      standingInvitations: rows.map((row) => asView(row)),
    });
  });

  fastify.post<{ Params: { id: string } }>(
    "/api/standing-invitations/:id/revoke",
    async (request, reply) => {
      const gate = await sessionFor(request);
      if (!gate.ok) {
        return reply.code(gate.status).send({ error: gate.error });
      }
      /*
       * Scoped to the session's issuer, so a deployment serving two practices cannot let one
       * withdraw the other's poster. An id belonging to somebody else is reported as unknown,
       * which is also what it is from here.
       */
      const revoked = revokeStandingInvitation(
        fastify.appDb,
        request.params.id,
        gate.session.issuer,
      );
      if (!revoked) {
        return reply.code(404).send({ error: "not-found" });
      }
      return reply.send({ revoked: true });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/standing-invitations/:id/refresh",
    async (request, reply) => {
      const gate = await sessionFor(request);
      if (!gate.ok) {
        return reply.code(gate.status).send({ error: gate.error });
      }
      const session = gate.session;

      // Unknown, withdrawn, expired and another practice's code are one answer, as for revoke.
      const row = findStandingInvitation(fastify.appDb, request.params.id);
      if (row === undefined || row.issuer !== session.issuer) {
        return reply.code(404).send({ error: "not-found" });
      }

      const key = keyFromBase64Url(row.linkKey);
      let bundle: Bundle;
      try {
        bundle = JSON.parse(
          decodeUtf8(await decryptJwe(row.payloadCiphertext, key)),
        ) as Bundle;
      } catch (error) {
        request.log.error(
          { err: error, standingId: row.id },
          "standing payload unreadable",
        );
        return reply.code(500).send({ error: "payload-unreadable" });
      }
      const entry = (bundle.entry ?? []).find(
        (candidate) => candidate.resource?.resourceType === "Questionnaire",
      );
      const sealed = entry?.resource as Questionnaire | undefined;
      if (entry === undefined || sealed?.id === undefined) {
        return reply.code(500).send({ error: "payload-unreadable" });
      }

      const current = await readQuestionnaire(session, sealed.id, request.log);
      if ("error" in current) {
        return reply.code(502).send(current);
      }

      /*
       * The sealed Task names the form as `url|version`, in `focus` and in `input`, and walk-in
       * answers cite the same canonical. A different form, or a new version of this one, would
       * leave the Task pointing at something the payload no longer holds - so that is a new code,
       * not a refresh.
       */
      if (current.url !== sealed.url || current.version !== sealed.version) {
        return reply.code(409).send({
          error: "questionnaire-identity-changed",
          sealed: `${sealed.url ?? ""}|${sealed.version ?? ""}`,
          current: `${current.url ?? ""}|${current.version ?? ""}`,
        });
      }

      if (JSON.stringify(current) === JSON.stringify(sealed)) {
        return reply.send({ refreshed: false });
      }

      entry.resource = current;
      const replacement = await encryptJwe(
        encodeUtf8(JSON.stringify(bundle)),
        key,
        { contentType: INVITATION_CONTENT_TYPE },
      );
      const replaced = replaceStandingInvitationPayload(
        fastify.appDb,
        row.id,
        session.issuer,
        row.payloadCiphertext,
        replacement,
      );
      if (!replaced) {
        return reply.code(409).send({ error: "changed-meanwhile" });
      }
      return reply.send({ refreshed: true });
    },
  );

  done();
};
