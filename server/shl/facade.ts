/**
 * The facade: `/shl/:id/fhir/*`, the write target a grant now points at.
 *
 * Before this, a grant handed the filler a SMART Backend Services token and pointed it straight
 * at the practice's FHIR base. The token's authority was the system's, so anyone holding the link
 * - or, for a QR on a wall, everyone who scanned it - held a credential that could create a
 * response for any patient on that server and update any Task. Binding the token to its
 * invitation needed something on the server side, which is exactly what the BFF became.
 *
 * ```text
 * POST /shl/:id/fhir                      our filler's transaction Bundle
 * POST /shl/:id/fhir/QuestionnaireResponse Platypus's bare conditional create
 * GET  /shl/:id/fhir/Task/:taskId          the pre-send read
 * PUT  /shl/:id/fhir/Task/:taskId          the status flip
 * ```
 *
 * ## Two wire shapes in, one upstream write out
 *
 * Our filler posts a transaction Bundle; Platypus posts a bare `QuestionnaireResponse` with an
 * `If-None-Exist`. Both are reduced to the answers they carry and rebuilt here through
 * {@link buildSubmissionTransaction}, the same function the filler uses, so the bytes that reach
 * the practice are identical whichever filler sent them. Platypus therefore inherits the
 * at-most-one rule and this app's idempotency without implementing either.
 *
 * Rebuilding rather than relaying is the point. The identifier that makes a second send a no-op,
 * and the `subject` that says whose answers these are, are **stamped from the invitation row**,
 * not taken from the request. A filler cannot write for a different patient, cannot answer a
 * different questionnaire, and cannot choose its own idempotency key, because none of those
 * values comes from anything it sent.
 *
 * ## The Task leg exists because the origin rule does
 *
 * `readDestinationTask` refuses to present a token to anything that is not on the grant's own
 * origin. Move `aud` here and serve only the create, and that read would never succeed - so
 * every send would quietly stop flipping the Task to `completed`. The two Task routes are what
 * keep that working, and the id in the path is checked against the invitation's own published
 * Task so the leg cannot be aimed at a different one.
 *
 * ## Four refusals, and what each one means
 *
 * A `404` for an invitation that is unknown, expired or gone, identical in every case, because
 * this route is no more an existence oracle than the manifest is. A `401` for a token that does
 * not verify, whatever is wrong with it. A `400` for answers to the wrong questionnaire. A `409`
 * only for a send that is genuinely in flight - a *replayed* send answers `200` from what was
 * stored the first time, because a filler has no honest copy for being told its delivered
 * answers are a conflict.
 * @author John Grimes
 */

import { buildSubmissionTransaction } from "../../src/fill/directSend";
import { bearerToken } from "../bearerToken";
import { findIssuerRegistration } from "../config";
import { isJsonObject } from "../json";
import { deriveGrantTokenKey, verifyGrantToken } from "./grantToken";
import {
  claimInvitationResponse,
  findInvitation,
  recordInvitationResponse,
  releaseInvitationResponseClaim,
} from "./invitationStore";
import {
  cachedAccessToken,
  invalidateAccessToken,
} from "../smart/backendServices";
import { discoverSmartConfiguration } from "../smart/discovery";

import type { IssuerRegistration } from "../config";
import type { AppDatabase } from "../db";
import type { Invitation } from "./invitationStore";
import type { MintOptions } from "../smart/backendServices";
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Bundle, QuestionnaireResponse, Task } from "fhir/r4";

/** Content type the facade speaks, in both directions. */
const FHIR_JSON = "application/fhir+json";

/** Path prefix of the facade, appended to the invitation to make the grant's `aud`. */
export const FACADE_SUFFIX = "/fhir";

/**
 * A FHIR resource id, as the `id` datatype defines it.
 *
 * The grammar permits `.`, so `.` and `..` are valid ids and also path traversal. Both are
 * refused, because this id is interpolated into an upstream URL.
 */
const RESOURCE_ID_PATTERN = /^[\w\-.]{1,64}$/;

/** Path segments that would move the address rather than name a resource. */
const TRAVERSAL_SEGMENTS = new Set([".", ".."]);

/**
 * The `aud` a grant for this invitation states.
 *
 * One function so the manifest and the routes cannot disagree about the value, and so the shape
 * exchanged with Platypus is stated in exactly one place. No query, no fragment, no userinfo:
 * their reader refuses a grant whose `aud` carries any of the three, and an invitation id is
 * base64url so it never needs escaping.
 * @param appOrigin the deployment's configured origin
 * @param invitationId the invitation the grant is for
 * @returns the absolute facade base URL
 * @example
 * facadeAud("https://links.example.org", "inv-abc"); // ".../shl/inv-abc/fhir"
 */
export function facadeAud(appOrigin: string, invitationId: string): string {
  return new URL(`/shl/${invitationId}${FACADE_SUFFIX}`, appOrigin).href;
}

/**
 * The id of the Task an invitation published.
 *
 * Read off the stored absolute URL rather than kept as a column: the URL is already there, and a
 * second copy would be a second thing to keep in step.
 * @param invitation the invitation row
 * @returns the Task's id, or undefined when the stored URL does not end in one
 */
function publishedTaskId(invitation: Invitation): string | undefined {
  const last = invitation.publishedTaskUrl.split("/").pop();
  return last !== undefined &&
    RESOURCE_ID_PATTERN.test(last) &&
    !TRAVERSAL_SEGMENTS.has(last)
    ? last
    : undefined;
}

/**
 * Compare two canonical URLs, ignoring the version a caller may have pinned.
 *
 * `http://example.org/Questionnaire/ccm|1.2.0` answers the same questionnaire as
 * `http://example.org/Questionnaire/ccm`, and refusing the versioned spelling would refuse a
 * conformant filler over a distinction the invitation never made.
 * @param left one canonical
 * @param right the other
 * @returns whether they name the same questionnaire
 */
function sameQuestionnaire(left: string, right: string): boolean {
  return withoutVersion(left) === withoutVersion(right);
}

/**
 * A canonical URL without the `|version` a caller may have pinned to it.
 * @param canonical the canonical, as it arrived
 * @returns the canonical alone
 */
function withoutVersion(canonical: string): string {
  return canonical.split("|", 1)[0].trim();
}

/** Everything the upstream leg of a request needs, once the invitation has been authorised. */
interface Upstream {
  /** The practice's FHIR base, from the invitation's issuer. */
  readonly base: string;
  /** What `cachedAccessToken` and `invalidateAccessToken` are keyed by. */
  readonly mint: MintOptions;
}

/**
 * Resolve the upstream leg for an invitation, or say why it cannot be resolved.
 * @param issuers the loaded issuer registry
 * @param invitation the invitation being written against
 * @returns the upstream leg, or undefined when the issuer is no longer usable
 */
async function resolveUpstream(
  issuers: readonly IssuerRegistration[],
  invitation: Invitation,
): Promise<Upstream | undefined> {
  const registration = findIssuerRegistration(issuers, invitation.issuer);
  if (registration === undefined) {
    return undefined;
  }
  try {
    const smart = await discoverSmartConfiguration(invitation.issuer);
    return {
      base: invitation.issuer.replace(/\/+$/, ""),
      mint: { registration, tokenEndpoint: smart.tokenEndpoint },
    };
  } catch {
    return undefined;
  }
}

/**
 * Make one request to the practice, presenting the system credential and retrying a refusal once.
 *
 * The retry is the same rule the FHIR proxy applies to a session: the server is the authority on
 * whether a token still works, and it has just said no, so the cached one is dropped and a fresh
 * one minted. Anything after that is the practice's answer and is reported as it stands.
 * @param upstream the practice's base and the mint it is reached with
 * @param request the path relative to that base, the method, and the body and headers to send
 * @param request.path
 * @param request.method
 * @param request.body
 * @param request.ifMatch
 * @returns the practice's response
 * @throws {Error} when the practice cannot be reached at all
 */
async function callUpstream(
  upstream: Upstream,
  request: {
    readonly path: string;
    readonly method: string;
    readonly body?: string;
    readonly ifMatch?: string;
  },
): Promise<Response> {
  const target = `${upstream.base}/${request.path}`;

  const attempt = async (accessToken: string): Promise<Response> =>
    fetch(target, {
      method: request.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: FHIR_JSON,
        ...(request.body === undefined ? {} : { "content-type": FHIR_JSON }),
        ...(request.ifMatch === undefined
          ? {}
          : { "if-match": request.ifMatch }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
    });

  const cached = await cachedAccessToken(upstream.mint);
  /*
   * Defence in depth: the manifest checks this when it hands out a grant, but a registration can
   * change between a link being opened and the answers arriving, and presenting a DPoP token in a
   * Bearer header would be a request that fails in a way nothing here could explain.
   */
  if (cached.token_type.trim().toLowerCase() !== "bearer") {
    throw new Error(
      `${upstream.base} issued a ${cached.token_type} token, which cannot be presented as a Bearer`,
    );
  }
  const first = await attempt(cached.access_token);
  if (first.status !== 401) {
    return first;
  }
  invalidateAccessToken(upstream.mint);
  const fresh = await cachedAccessToken(upstream.mint);
  return attempt(fresh.access_token);
}

/**
 * Read the `QuestionnaireResponse` a request is offering, from either accepted wire shape.
 *
 * A transaction Bundle is reduced to its first `QuestionnaireResponse` entry; a bare body is
 * taken as itself. Nothing else about the Bundle survives, which is the whole reason both shapes
 * can be accepted: what the filler wrapped its answers in never reaches the practice.
 * @param body the parsed request body
 * @returns the answers, or undefined when the body carries none
 */
function answersFrom(body: unknown): QuestionnaireResponse | undefined {
  if (!isJsonObject(body)) {
    return undefined;
  }
  if (body.resourceType === "QuestionnaireResponse") {
    return body as unknown as QuestionnaireResponse;
  }
  if (body.resourceType !== "Bundle") {
    return undefined;
  }
  const entries = (body as unknown as Bundle).entry ?? [];
  for (const entry of entries) {
    if (entry.resource?.resourceType === "QuestionnaireResponse") {
      return entry.resource;
    }
  }
  return undefined;
}

/**
 * Read the Task entry of a transaction Bundle, when the filler sent one to complete.
 *
 * Only the version it claims to have read is taken from the request; the Task itself is the one
 * the invitation published, addressed by the row rather than by anything the filler said.
 * @param body the parsed request body
 * @returns the `ifMatch` the filler offered, or undefined when it sent no Task entry
 */
function taskIfMatchFrom(body: unknown): string | undefined {
  if (!isJsonObject(body) || body.resourceType !== "Bundle") {
    return undefined;
  }
  for (const entry of (body as unknown as Bundle).entry ?? []) {
    if (entry.resource?.resourceType === "Task") {
      return entry.request?.ifMatch;
    }
  }
  return undefined;
}

/**
 * The Task the filler is completing, read from the practice so the `PUT` replaces a known version.
 * @param upstream the practice's base and mint
 * @param taskId the invitation's own published Task id
 * @param ifMatch the version the filler claims to have read, when it offered one
 * @returns the transaction entry for the Task leg, or undefined when there is none to send
 */
async function taskLeg(
  upstream: Upstream,
  taskId: string,
  ifMatch: string | undefined,
): Promise<
  | { readonly url: string; readonly resource: Task; readonly ifMatch: string }
  | undefined
> {
  if (ifMatch === undefined) {
    return undefined;
  }
  let response: Response;
  try {
    response = await callUpstream(upstream, {
      path: `Task/${taskId}`,
      method: "GET",
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isJsonObject(body) || body.resourceType !== "Task") {
    return undefined;
  }
  return {
    url: `Task/${taskId}`,
    resource: body as unknown as Task,
    ifMatch,
  };
}

/** What a write produced, ready to be shaped for whichever route was called. */
interface WriteOutcome {
  /** HTTP status to answer with. */
  readonly status: number;
  /** The created or previously created response, when there is one to report. */
  readonly resource?: QuestionnaireResponse;
  /** Relative reference to it, e.g. `QuestionnaireResponse/123`. */
  readonly reference?: string;
  /** An error code, when the write did not happen. */
  readonly error?: string;
}

/**
 * Read the created response and its location out of a transaction answer.
 * @param bundle the practice's transaction-response Bundle
 * @returns the created resource and its relative reference, when the answer names them
 */
function createdFrom(bundle: unknown): {
  resource?: QuestionnaireResponse;
  reference?: string;
  status: number;
} {
  const entries = isJsonObject(bundle)
    ? ((bundle as unknown as Bundle).entry ?? [])
    : [];
  for (const entry of entries) {
    const resource = entry.resource;
    if (resource?.resourceType !== "QuestionnaireResponse") {
      continue;
    }
    const location = entry.response?.location ?? entry.fullUrl;
    const reference =
      resource.id === undefined
        ? location
        : `QuestionnaireResponse/${resource.id}`;
    /*
     * A conditional create that matched answers `200`, and one that wrote answers `201`. Relaying
     * the practice's own distinction is what lets a conformant consumer tell "already there" from
     * "stored just now" without us inventing a rule for it.
     */
    const status =
      entry.response?.status?.startsWith("200") === true ? 200 : 201;
    return { resource, ...(reference ? { reference } : {}), status };
  }
  return { status: 201 };
}

/**
 * Register the facade routes.
 *
 * The plugin installs its own `application/fhir+json` parser: bodies are inspected here rather
 * than relayed, so unlike the FHIR proxy they have to be parsed. Registered without
 * `fastify-plugin`, so that parser applies to these routes alone.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the routes are registered
 * @example
 * fastify.register(facadeRoutes);
 */ /** Everything the facade's route handlers need, gathered once when the plugin is registered. */
interface FacadeContext {
  /** The open database. */
  readonly db: AppDatabase;
  /** The loaded issuer registry. */
  readonly issuers: readonly IssuerRegistration[];
  /** The derived key grant tokens are verified against. */
  readonly grantKey: Buffer;
}

/**
 * Authorise a request, or answer it.
 *
 * The order is deliberate: the row is read first, so an unknown, expired or deleted invitation
 * answers `404` before any token is looked at, and a verified token for a retired invitation
 * still gets nowhere. That is what makes a stateless token revocable.
 * @param context the database, registry and key
 * @param id the invitation id from the path
 * @param authorization the request's `Authorization` header
 * @param reply the reply to refuse on
 * @returns the invitation, or undefined when the reply has been sent
 */
function authorise(
  context: FacadeContext,
  id: string,
  authorization: string | undefined,
  reply: FastifyReply,
): Invitation | undefined {
  const invitation = findInvitation(context.db, id);
  if (invitation === undefined) {
    void reply.code(404).send({ error: "not-found" });
    return undefined;
  }
  if (
    !verifyGrantToken({
      key: context.grantKey,
      invitationId: id,
      token: bearerToken(authorization),
    })
  ) {
    void reply.code(401).send({ error: "invalid-token" });
    return undefined;
  }
  return invitation;
}

/**
 * Read back the response a previous send stored, so a replay can be answered from the record.
 * @param upstream the practice's base and mint
 * @param reference the stored relative reference
 * @returns the resource, when it can still be read
 */
async function reread(
  upstream: Upstream,
  reference: string,
): Promise<{ resource?: QuestionnaireResponse }> {
  try {
    const response = await callUpstream(upstream, {
      path: reference,
      method: "GET",
    });
    if (!response.ok) {
      return {};
    }
    const body: unknown = await response.json();
    return isJsonObject(body) && body.resourceType === "QuestionnaireResponse"
      ? { resource: body as unknown as QuestionnaireResponse }
      : {};
  } catch {
    return {};
  }
}

/**
 * The Task leg of the transaction, when the filler offered a version to replace.
 * @param upstream the practice's base and mint
 * @param invitation the invitation, for its own published Task
 * @param body the request body, for the `ifMatch` the filler read
 * @returns the `task` option for the builder, or nothing
 */
async function taskEntry(
  upstream: Upstream,
  invitation: Invitation,
  body: unknown,
): Promise<{ task?: Awaited<ReturnType<typeof taskLeg>> }> {
  const taskId = publishedTaskId(invitation);
  if (taskId === undefined) {
    return {};
  }
  const task = await taskLeg(upstream, taskId, taskIfMatchFrom(body));
  return task === undefined ? {} : { task };
}

/**
 * The patient's name to carry on the stamped `subject`, when the request offered a usable one.
 *
 * Kept only when the request already agrees about *which* patient, so the display travels with a
 * reference this app chose rather than decorating one the filler substituted. A display is not an
 * authorisation, but a display attached to the wrong reference would read as one.
 * @param answers the answers as they arrived
 * @param invitation the invitation, for the patient it named
 * @returns the display, or undefined
 */
function patientDisplayFrom(
  answers: QuestionnaireResponse,
  invitation: Invitation,
): string | undefined {
  if (invitation.patientId === null) {
    return undefined;
  }
  const subject = answers.subject;
  return subject?.reference === `Patient/${invitation.patientId}`
    ? subject.display
    : undefined;
}

/**
 * Forward the answers as one canonical transaction, at most once.
 * @param context the database, registry and key
 * @param invitation the invitation being written against
 * @param body the parsed request body, in either accepted shape
 * @returns what to answer with
 */
async function forward(
  context: FacadeContext,
  invitation: Invitation,
  body: unknown,
): Promise<WriteOutcome> {
  const answers = answersFrom(body);
  if (answers === undefined) {
    return { status: 400, error: "no-questionnaire-response" };
  }

  const canonical = answers.questionnaire;
  if (canonical === undefined || canonical.trim() === "") {
    return { status: 400, error: "no-questionnaire" };
  }
  if (
    invitation.questionnaireCanonical !== null &&
    !sameQuestionnaire(canonical, invitation.questionnaireCanonical)
  ) {
    return { status: 400, error: "wrong-questionnaire" };
  }

  const upstream = await resolveUpstream(context.issuers, invitation);
  if (upstream === undefined) {
    return { status: 502, error: "destination-unavailable" };
  }

  /*
   * The claim is taken before anything is sent, and it is the whole of the at-most-one rule: a
   * single conditional `UPDATE` cannot let two concurrent sends both through. A send that does not
   * get it is either a replay of one that landed, which is answered from what was stored, or a
   * genuine race, which is the one case that gets a `409`.
   */
  if (!claimInvitationResponse(context.db, invitation.id)) {
    const reference =
      findInvitation(context.db, invitation.id)?.responseReference ?? null;
    if (reference === null) {
      return { status: 409, error: "send-in-flight" };
    }
    return { status: 200, reference, ...(await reread(upstream, reference)) };
  }

  const patientDisplay = patientDisplayFrom(answers, invitation);

  // Stamped, never taken from the request: whose answers these are, and which request they
  // answer, are properties of the invitation rather than claims a filler gets to make.
  const bundle = buildSubmissionTransaction({
    response: answers,
    ...(invitation.patientId === null ? {} : { patient: invitation.patientId }),
    requestIdentifier: invitation.requestIdentifier,
    ...(patientDisplay === undefined ? {} : { patientDisplay }),
    ...(await taskEntry(upstream, invitation, body)),
  });

  let response: Response;
  try {
    response = await callUpstream(upstream, {
      path: "",
      method: "POST",
      body: JSON.stringify(bundle),
    });
  } catch {
    releaseInvitationResponseClaim(context.db, invitation.id);
    return { status: 502, error: "destination-unreachable" };
  }

  if (!response.ok) {
    releaseInvitationResponseClaim(context.db, invitation.id);
    return {
      status: response.status === 401 || response.status === 403 ? 403 : 502,
      error: "destination-refused",
    };
  }

  let answered: unknown;
  try {
    answered = await response.json();
  } catch {
    releaseInvitationResponseClaim(context.db, invitation.id);
    return { status: 502, error: "destination-answer-unreadable" };
  }

  const created = createdFrom(answered);
  if (created.reference === undefined) {
    /*
     * The practice took the transaction but named nothing it created. Nothing can be recorded, so
     * the claim is released rather than left holding an invitation whose answers cannot be found
     * again - a retry is a better outcome than a link that is permanently spent.
     */
    releaseInvitationResponseClaim(context.db, invitation.id);
    return { status: 502, error: "destination-answer-unreadable" };
  }
  recordInvitationResponse(context.db, invitation.id, created.reference);
  return {
    status: created.status,
    ...(created.resource === undefined ? {} : { resource: created.resource }),
    reference: created.reference,
  };
}

/**
 * Answer a write, in the shape the route that took it speaks.
 * @param reply the reply to send on
 * @param outcome what the write produced
 * @param shape whether the caller posted a transaction or a bare resource
 * @returns the reply
 */
function sendWrite(
  reply: FastifyReply,
  outcome: WriteOutcome,
  shape: "transaction" | "resource",
) {
  if (outcome.error !== undefined) {
    return reply.code(outcome.status).send({ error: outcome.error });
  }
  if (outcome.reference !== undefined) {
    void reply.header("content-location", outcome.reference);
  }
  reply.code(outcome.status).header("content-type", FHIR_JSON);

  if (shape === "resource") {
    return reply.send(
      outcome.resource ?? { resourceType: "QuestionnaireResponse" },
    );
  }
  /*
   * A transaction gets a transaction-response back, because that is what it asked for and what a
   * FHIR client will try to read. Synthesised rather than relayed: the practice answered the
   * transaction *we* built, whose entries are not the ones the filler sent.
   */
  const answer: Bundle = {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: [
      {
        ...(outcome.resource === undefined
          ? {}
          : { resource: outcome.resource }),
        response: {
          status: outcome.status === 200 ? "200 OK" : "201 Created",
          ...(outcome.reference === undefined
            ? {}
            : { location: outcome.reference }),
        },
      },
    ],
  };
  return reply.send(answer);
}

/**
 * Whether a body is the Task the path names.
 * @param body the parsed request body
 * @param taskId the invitation's published Task id
 * @returns true when the body is a Task carrying that id
 */
function isTask(body: unknown, taskId: string): boolean {
  return (
    isJsonObject(body) && body.resourceType === "Task" && body.id === taskId
  );
}

/**
 * Register the facade routes.
 *
 * The plugin installs its own `application/fhir+json` parser: bodies are inspected here rather
 * than relayed, so unlike the FHIR proxy they have to be parsed. Registered without
 * `fastify-plugin`, so that parser applies to these routes alone.
 * @param fastify the instance to register on, carrying `appConfig` and `appDb`
 * @param _options plugin options; none are used
 * @param done called once the routes are registered
 * @example
 * fastify.register(facadeRoutes);
 */
export const facadeRoutes: FastifyPluginCallback = (
  fastify,
  _options,
  done,
) => {
  const { appConfig: config } = fastify;
  const context: FacadeContext = {
    db: fastify.appDb,
    issuers: config.issuers,
    grantKey: deriveGrantTokenKey(config.cookieSecret),
  };

  for (const contentType of [FHIR_JSON, "application/json"]) {
    fastify.addContentTypeParser(
      contentType,
      { parseAs: "string" },
      (_request, body, parsed) => {
        try {
          parsed(null, JSON.parse(body as string));
        } catch (error) {
          /*
           * Fastify answers a bare parser error with a `500`, which says the failure was ours. A
           * body that is not JSON is the caller's, so the status is set here and the reason is
           * left unstated - the filler cannot act on our parser's opinion of its bytes.
           */
          const refusal = error as Error & { statusCode?: number };
          refusal.statusCode = 400;
          parsed(refusal);
        }
      },
    );
  }

  for (const [url, shape] of [
    [`/shl/:id${FACADE_SUFFIX}`, "transaction"],
    [`/shl/:id${FACADE_SUFFIX}/QuestionnaireResponse`, "resource"],
  ] as const) {
    fastify.post<{ Params: { id: string } }>(url, async (request, reply) => {
      const invitation = authorise(
        context,
        request.params.id,
        request.headers.authorization,
        reply,
      );
      if (invitation === undefined) {
        return reply;
      }
      return sendWrite(
        reply,
        await forward(context, invitation, request.body),
        shape,
      );
    });
  }

  /*
   * The invitation's own published Task, read and replaced.
   *
   * `:taskId` has to match the one the invitation published. It is not used to address anything -
   * the row decides that - so the check exists to refuse a request that thinks it is completing a
   * different Task rather than to silently complete the right one anyway.
   */
  for (const method of ["GET", "PUT"] as const) {
    fastify.route<{ Params: { id: string; taskId: string } }>({
      method,
      url: `/shl/:id${FACADE_SUFFIX}/Task/:taskId`,
      handler: async (request, reply) => {
        const invitation = authorise(
          context,
          request.params.id,
          request.headers.authorization,
          reply,
        );
        if (invitation === undefined) {
          return reply;
        }
        const taskId = publishedTaskId(invitation);
        if (taskId === undefined || taskId !== request.params.taskId) {
          return reply.code(404).send({ error: "not-found" });
        }
        if (method === "PUT" && !isTask(request.body, taskId)) {
          return reply.code(400).send({ error: "not-this-task" });
        }

        const upstream = await resolveUpstream(context.issuers, invitation);
        if (upstream === undefined) {
          return reply.code(502).send({ error: "destination-unavailable" });
        }

        const ifMatch = request.headers["if-match"];
        let response: Response;
        try {
          response = await callUpstream(upstream, {
            path: `Task/${taskId}`,
            method,
            ...(method === "PUT" ? { body: JSON.stringify(request.body) } : {}),
            ...(typeof ifMatch === "string" ? { ifMatch } : {}),
          });
        } catch {
          return reply.code(502).send({ error: "destination-unreachable" });
        }

        reply.code(response.status).header("content-type", FHIR_JSON);
        const etag = response.headers.get("etag");
        if (etag !== null) {
          void reply.header("etag", etag);
        }
        return reply.send(Buffer.from(await response.arrayBuffer()));
      },
    });
  }

  done();
};
