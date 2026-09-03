import {
  getResponse,
  removeEmptyAnswersFromResponse,
} from "@aehrc/smart-forms-renderer";

import { bespokeCodec } from "./bespokeCodec";
import { encodeUtf8 } from "./binary";
import { defaultLabel, ensureQuestionnaireCanonical } from "./codec";
import {
  buildReplyBundle,
  buildResponseBundle,
  buildWriteResponse,
} from "./exchange";
import { JOSE_CONTENT_TYPE } from "./jwe";
import { encryptReplyJwe } from "./replyCrypto";
import {
  isReplyDescriptorExpired,
  isWriteDescriptorExpired,
  type ReplyDescriptor,
  type WriteDescriptor,
} from "./replyDescriptor";
import { putResponseToSlot, type WriteSlotOutcome } from "./writeSlot";

import type { Questionnaire, QuestionnaireResponse, Task } from "fhir/r4";

import {
  canUseOneShotWrite,
  resolveExpiry,
  resolveLinkBaseUrl,
  type AppConfig,
} from "@/lib/config";
import { sessionEndedError } from "@/lib/session";

/**
 * Link creation, from the browser's side.
 *
 * The two directions are minted in two different places, and the reason is hosting.
 *
 * An **invitation** is no longer minted by this code; it is *asked for*. The component that mints
 * is the component that hosts (FR-013), and that is the BFF: it holds the session's authority to
 * publish the request Task, it hosts the encrypted payload, and it mints a fresh grant on every
 * manifest fetch. So {@link createRequestLink} is one `POST` to `/api/invitations` and some
 * presentation of the answer.
 *
 * A **return** is minted here, because there is nowhere else it could be. Whoever fills a form
 * holds a link and nothing else, and the server's public surface takes no payloads
 * (`contracts/http-api.md`), so {@link createResponseLink} uses the one transport that needs no
 * host: the answers, compressed into the fragment. That is a weaker confidentiality position than
 * a hosted encrypted payload and the surface showing the link says so.
 *
 * What went with the move to server-side minting is worth stating, because both were real
 * features:
 *
 *  - **Channel B**, where an invitation declared a `sdc-questionnaire-endpoint` and invited a
 *    filler to write to it anonymously, is replaced by the grant. A filler now writes with a
 *    token that expires, scoped to four operations, rather than to an open endpoint.
 *  - **Channel C**, the encrypted reply slot, is no longer minted. Its requester half - creating
 *    a slot, holding the private key in one browser, polling - is gone with it. The *filler*
 *    half stays: {@link sendEncryptedReply} still honours a reply channel declared by somebody
 *    else's invitation, because refusing to would strand a Platypus user's answers (FR-029).
 * @author John Grimes
 */

/** Where the BFF mints invitations. */
export const INVITATIONS_ENDPOINT = "/api/invitations";

/** Details of the request being made, beyond which form it is for. */
export interface CreateRequestOptions {
  /** Who the form is for, e.g. `Patient/pt-1`. */
  subjectReference?: string;
  /** Who the form is for, in words - the part a filler can actually read. */
  subjectDisplay?: string;
  /** Overrides the expiry derived from `linkLifetimeDays`. */
  expiresAt?: number;
  /**
   * Answers filled in from the record before sending, already pruned to what the clinician kept.
   *
   * Sent to the BFF rather than sealed here, because the BFF is what seals the payload. It is the
   * one piece of record content that travels outward on this route, which is why the surface that
   * offers it makes the clinician tick each answer they are willing to disclose.
   */
  prePopulated?: QuestionnaireResponse;
}

/** What the BFF answers a mint with, plus the viewer URL built from it. */
export interface CreatedRequest {
  /** Viewer URL carrying the link in its fragment: what goes into the QR code. */
  link: string;
  /** The bare `shlink:/…`, for anyone who wants the link itself. */
  shlink: string;
  /** Where the link's manifest is served from. */
  manifestUrl: string;
  /** When the link stops being openable, in epoch seconds. */
  expiresAt: number;
  /** Absolute URL of the request Task published on the launched server. */
  taskUrl: string;
  /** The durable `urn:uuid:` identifier correlating this request with its answers. */
  requestIdentifier: string;
}

/** The mint response, before the viewer URL is built onto it. */
interface MintResponse {
  shlink: string;
  manifestUrl: string;
  expiresAt: number;
  taskUrl: string;
  requestIdentifier: string;
}

/**
 * Whether a parsed body is a mint response.
 * @param value the parsed body
 * @returns true when every field is present and of the right type
 */
function isMintResponse(value: unknown): value is MintResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.shlink === "string" &&
    typeof candidate.manifestUrl === "string" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.taskUrl === "string" &&
    typeof candidate.requestIdentifier === "string"
  );
}

/**
 * The patient id inside a subject reference.
 *
 * The picker hands back `Patient/pt-1`; the mint API takes the id alone, because it builds the
 * reference itself against the launched server.
 * @param subjectReference a reference, or undefined
 * @returns the id, or undefined when no subject was named
 */
function patientIdOf(subjectReference?: string): string | undefined {
  const trimmed = subjectReference?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  return trimmed.split("/").findLast(Boolean);
}

/**
 * Describe a failed mint in terms a requester can act on.
 * @param status the HTTP status the BFF answered with
 * @param body the parsed error body, when there was one
 * @returns the message to show
 */
function mintFailureMessage(status: number, body: unknown): string {
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as Record<string, unknown>).error)
      : undefined;
  switch (error) {
    case "task-publish-failed": {
      return (
        "The request could not be recorded on the server you are signed in to, so no link was " +
        "created. Nothing has been sent, and nothing is hosted."
      );
    }
    case "questionnaire-unreadable": {
      return "This form could not be read from the server you are signed in to, so no link was created.";
    }
    case "questionnaire-not-invitable": {
      return (
        "This form has no canonical URL, so an invitation to it could not say which form to " +
        "fill in. Nothing was created."
      );
    }
    default: {
      return `The link could not be created (${status}).`;
    }
  }
}

/**
 * Ask the BFF to mint a "please fill this in" link.
 *
 * The Questionnaire is read, the request Task is published and the encrypted payload is hosted
 * on the server, under the session's authority. What comes back is a `shlink:/` that resolves to
 * a two-file manifest: the invitation, and a grant minted fresh at every fetch.
 * @param questionnaireId id of the Questionnaire on the launched server
 * @param config the app configuration, for the link origin, sender name and lifetime
 * @param options who the form is for, and any expiry override
 * @returns the minted link and what was created alongside it
 * @throws {Error} when the mint is refused; marked as session-ended when the session has gone,
 *   so the surface offers a re-launch rather than an error
 * @example
 * const created = await createRequestLink("q-715", config, {
 *   subjectReference: "Patient/pt-1",
 *   subjectDisplay: "Jane Citizen",
 * });
 */
export async function createRequestLink(
  questionnaireId: string,
  config: AppConfig,
  options: CreateRequestOptions = {},
): Promise<CreatedRequest> {
  const patientId = patientIdOf(options.subjectReference);
  const subjectDisplay = options.subjectDisplay?.trim();
  const expiresAt = options.expiresAt ?? resolveExpiry(config);

  const response = await fetch(INVITATIONS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      questionnaireId,
      ...(patientId === undefined ? {} : { patientId }),
      ...(subjectDisplay === undefined || subjectDisplay === ""
        ? {}
        : { patientDisplay: subjectDisplay }),
      ...(config.senderName === null ? {} : { senderName: config.senderName }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      // Channel D is minted server-side, because the slot has to exist before the payload is
      // sealed and only the BFF can host it. The flag travels rather than the slot.
      ...(canUseOneShotWrite(config) ? { offerWriteSlot: true } : {}),
      ...(options.prePopulated === undefined
        ? {}
        : { prePopulated: options.prePopulated }),
    }),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.status === 401) {
    throw sessionEndedError(
      "The session has ended, so nothing was created. Sign in again to send this request.",
    );
  }
  if (!response.ok || !isMintResponse(body)) {
    throw new Error(mintFailureMessage(response.status, body));
  }

  /*
   * The QR carries a viewer URL rather than the bare `shlink:/`, which is the form the SHL
   * specification itself uses: a scanner that knows nothing about the scheme still opens
   * something, and the fragment never leaves the device.
   */
  const base = resolveLinkBaseUrl(config).replace(/\/+$/, "");

  return { ...body, link: `${base}/view#${body.shlink}` };
}

/**
 * Build a "here are the answers" link from the form's current state.
 *
 * The fallback channel, and the only one available to whoever is filling the form: they mint this,
 * show it to the requester, and the requester scans it and accepts under their own session
 * (FR-028). It is what the surface promotes when a direct send is not possible - an expired grant,
 * a refused credential, or an invitation that carried no grant at all - so it must work with no
 * session, no host and no network.
 *
 * Hence the inline transport. The whole payload is compressed into the fragment, which costs
 * confidentiality against anyone who sees the QR code and buys the ability to hand answers back
 * from a device that has no account anywhere. `ShareLinkPanel` states the trade where the link is
 * shown.
 *
 * Empty and enableWhen-hidden answers are stripped first - partly hygiene, mostly size, since
 * everything removed here is payload that would otherwise count against the QR budget.
 *
 * `requestTask` is the Task that arrived with the request; passing it through is what lets the
 * requester match these answers to what it asked for.
 * @param questionnaire the form the answers belong to
 * @param config the app configuration, for the link origin
 * @param requestTask the Task that arrived with the request, when there was one
 * @returns the link
 * @throws {Error} when the answers cannot be compressed into a link
 * @example
 * setLink(await createResponseLink(questionnaire, config, task));
 */
export async function createResponseLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  requestTask?: Task,
): Promise<string> {
  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildResponseBundle(response, requestTask);

  return bespokeCodec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config) },
  );
}

/**
 * Deliver an encrypted reply to a slot somebody else minted.
 *
 * A blind overwrite, by design: the slot's whole purpose is to hold the latest reply, and a
 * filler correcting and resending should replace rather than accumulate. The requester
 * correlates by *which slot* the reply arrived in, so nothing depends on the slot's history.
 * @param replyUrl the absolute slot URL from the invitation's descriptor
 * @param jwe the encrypted reply
 * @returns nothing; resolves once the slot has accepted the ciphertext
 * @throws {Error} when the slot refused the write
 */
async function putReply(replyUrl: string, jwe: string): Promise<void> {
  const response = await fetch(replyUrl, {
    method: "PUT",
    headers: { "Content-Type": JOSE_CONTENT_TYPE },
    body: encodeUtf8(jwe) as BodyInit,
  });

  if (!response.ok) {
    throw new Error(
      `Could not deliver the reply to ${replyUrl} (${response.status} ${response.statusText}). ` +
        "The answers have not been sent.",
    );
  }
}

/**
 * Send the answers back through the request's encrypted reply channel.
 *
 * The filler's half of channel C, kept after this app stopped minting such channels of its own.
 * An invitation from another producer - Platypus, or an older build of this app - may still
 * declare one, and refusing to honour it would strand the answers of someone who did nothing
 * wrong (FR-029).
 *
 * Everything happens on this device: the reply Bundle is built, labelled patient-asserted,
 * encrypted to the requester's public key, and only the ciphertext is uploaded. The slot host -
 * quite possibly a server nobody involved trusts - never sees plaintext.
 *
 * What this can and cannot confirm is worth being precise about, because the UI has to say it: a
 * successful return means the ciphertext reached the slot. It does **not** mean the requester has
 * collected it, and there is nothing to poll that would say otherwise.
 * @param questionnaire the form that was answered
 * @param descriptor the reply channel the invitation declared
 * @param requestTask the Task that arrived with the request, when there was one
 * @returns nothing; resolves once the ciphertext has reached the slot
 * @throws {Error} when the channel uses a delivery method this app does not implement, when it
 *   has expired, or when the slot refused the write
 */
export async function sendEncryptedReply(
  questionnaire: Questionnaire,
  descriptor: ReplyDescriptor,
  requestTask?: Task,
): Promise<void> {
  if (descriptor.replyMethod !== "PUT") {
    throw new Error(
      `This request expects its reply to be delivered by "${descriptor.replyMethod}", which this app ` +
        "does not implement. Return the answers as a link instead.",
    );
  }

  if (isReplyDescriptorExpired(descriptor)) {
    throw new Error(
      "This request has expired, so its reply slot will no longer accept answers.",
    );
  }

  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildReplyBundle(response, { requestTask });

  await putReply(
    descriptor.replyUrl,
    await encryptReplyJwe(
      encodeUtf8(JSON.stringify(bundle)),
      descriptor.publicJwk,
    ),
  );
}

/**
 * Send the completed answers to a channel D slot.
 *
 * The fallback path, and the one that still works when the direct send cannot. Two failures are
 * distinguished on purpose: an expired descriptor is refused here, before anything is sent, because
 * telling somebody their answers went nowhere is worse than telling them the window has closed; and
 * `putResponseToSlot` reports "taken" separately from "refused", because a slot that has already
 * been written usually means the answers arrived and this is a duplicate.
 * @param questionnaire the form that was filled in
 * @param descriptor the slot from the invitation
 * @param requestTask the invitation's Task, for the subject display and the request identifier
 * @returns what the slot did with the answers
 * @throws {Error} when the descriptor has expired, or the slot could not be reached at all
 * @example
 * const outcome = await sendOneShotWrite(questionnaire, channels.write, payload.task);
 */
export async function sendOneShotWrite(
  questionnaire: Questionnaire,
  descriptor: WriteDescriptor,
  requestTask?: Task,
): Promise<WriteSlotOutcome> {
  if (isWriteDescriptorExpired(descriptor)) {
    throw new Error(
      "This request has expired, so its slot will no longer accept answers.",
    );
  }

  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);

  return putResponseToSlot(
    descriptor,
    buildWriteResponse(response, { requestTask }),
  );
}
