import type { Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { getResponse, removeEmptyAnswersFromResponse } from '@aehrc/smart-forms-renderer';
import type { AppConfig } from '@/lib/config';
import {
  canTrackRequests,
  canUseEncryptedReply,
  canUseOneShotWrite,
  canUseServerReturn,
  resolveExpiry,
  resolveLinkBaseUrl,
  resolveWriteSlotServerUrl
} from '@/lib/config';
import { fhirBinaryBlobStore, type BlobStore } from '@/fhir/blobStore';
import { declareResponseEndpoint, publishRequestTask } from '@/fhir/submit';
import type { SmartSession } from '@/auth/smartSession';
import { LINK_CODECS } from './registry';
import { defaultLabel, encodingCodec, ensureQuestionnaireCanonical } from './codec';
import {
  buildReplyBundle,
  buildRequestBundle,
  buildResponseBundle,
  buildWriteResponse,
  questionnaireCanonicalOf
} from './exchange';
import { encodeUtf8 } from './binary';
import { encryptReplyJwe, generateReplyKeyPair, type ReplyPrivateJwk } from './replyCrypto';
import { createReplySlot, putReply } from './replySlot';
import {
  isReplyDescriptorExpired,
  isWriteDescriptorExpired,
  type ReplyDescriptor,
  type WriteDescriptor
} from './replyDescriptor';
import { createWriteSlot, putResponseToSlot, type WriteSlotOutcome } from './writeSlot';
import { nominatedWriteTarget } from './writeTarget';

/**
 * Link creation — the boundary where the renderer's global form state and the app's config meet the
 * codecs. This is the only part of the link layer that depends on `@aehrc/smart-forms-renderer`.
 */

/** Whether the app is configured to host SHL payloads at all. */
export function canCreateHealthLinks(config: AppConfig): boolean {
  return config.blobServerUrl !== null;
}

/**
 * Where a SMART Health Link's encrypted payload gets hosted, per config.
 *
 * Note what this does *not* do: fall back to `formsServerUrl`. That server is a read-only
 * catalogue — writing blobs into it would put transactional data in a shared reference library.
 */
export function resolveBlobStore(config: AppConfig): BlobStore {
  if (!config.blobServerUrl) {
    throw new Error(
      'No `blobServerUrl` is configured, so there is nowhere to host the encrypted payload. ' +
        'Set it in config.json — it deliberately does not default to the forms server, which is ' +
        'a read-only catalogue.'
    );
  }

  switch (config.blobStore) {
    case 'fhir-binary':
      return fhirBinaryBlobStore(config.blobServerUrl);
  }
}

export interface CreateRequestOptions {
  /** Who the form is for, e.g. `Patient/123`. */
  subjectReference?: string;
  /** Who the form is for, in words — the part a filler can actually read. */
  subjectDisplay?: string;
  /** Overrides the expiry derived from `linkLifetimeDays`. */
  expiresAt?: number;
  /**
   * The launched session, when there is one. Supplies the server to publish the request `Task` to, and
   * authorises that write.
   *
   * It does **not** reach the reply slot or the write slot. Those are hosted on the transport tier and
   * fetched by a filler who holds no credentials; pointing them at an authenticated server would mint
   * a link that only the person who minted it can use.
   */
  session?: SmartSession | null;
  /** Who the request appears to come from, overriding `senderName`. The launched user, in practice. */
  requesterDisplay?: string;
  /**
   * Answers filled in from the record and kept by the clinician, when pre-population was used.
   *
   * Already pruned to the ticked rows by the time it arrives — this layer seals what it is given and
   * does not decide what belongs in it.
   */
  prePopulated?: QuestionnaireResponse;
}

export interface CreatedRequest {
  link: string;
  task: Task;
  /** When the link and its reply slot stop being usable, as Epoch seconds. */
  expiresAt?: number;
  /**
   * Channel C, when a slot was minted: where the reply will appear, and the key to open it.
   *
   * The private key exists nowhere else. It has to be persisted with the outstanding request or a
   * reply arriving later cannot be read by anyone, including us — see `src/lib/requestStore.ts`.
   */
  reply?: { url: string; privateJwk: ReplyPrivateJwk };
  /**
   * The published Task on the EHR, when one was written.
   *
   * Present for tracking alone as well as for channel B — {@link CreatedRequest.serverReturnOffered}
   * distinguishes them, because only the latter was named in the invitation.
   */
  serverTaskUrl?: string;
  /** Whether the invitation invites the filler to write to `serverTaskUrl`'s server directly. */
  serverReturnOffered: boolean;
  /**
   * Channel D, when a slot was minted: the capability that was handed out.
   *
   * Kept with the outstanding request so the requester can poll the slot later. Unlike the reply
   * key, none of this is irreplaceable — the slot is readable by anyone who can reach it — but
   * losing it means losing track of where the answers will appear.
   */
  write?: { url: string; etag: string; token: string };
}

/**
 * Build a "please fill this in" link, with whatever return channels are configured.
 *
 * The Questionnaire is embedded whole so the filler needs no forms-server access, which is what
 * pushes this onto the hosted-SHL path — hundreds of kilobytes cannot ride inside a QR code.
 *
 * By default the only return channel is the one that needs no arrangement at all: the filler mints
 * its own SMART Health Link and the requester scans it back. Nothing about that has to be described
 * in the invitation, so a default request is just the form.
 *
 * When the requester pre-filled the form, `prePopulated` rides along as a seed inside the same
 * payload. It changes nothing about the filler's position — they still hold only a link — but it does
 * change what the payload *is*, from a public questionnaire plus a name to an extract from a chart.
 * `publishRequestTask` is unaffected by design: it names the three fields it wants rather than
 * spreading what it is given, so no answer ever reaches the tracking Task on a shared server.
 *
 * Ordering matters for the channels that *are* described inside the payload, when they are enabled.
 * A slot URL cannot be added to a link that has already been sealed and uploaded, so the slot is
 * minted first, the Task published second, and only then is the Bundle built. The cost is that a
 * failure at the encryption step leaves an unused slot behind, which is harmless — a `Binary`
 * holding the word "pending".
 */
export async function createRequestLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  options: CreateRequestOptions = {}
): Promise<CreatedRequest> {
  const blobStore = resolveBlobStore(config);
  const expiresAt = options.expiresAt ?? resolveExpiry(config);
  /*
   * Fixed up front rather than left to `buildRequestBundle`, because channel B publishes a second copy
   * of this Task to a server and the two copies have to share one business identifier — otherwise a
   * response returned through either channel could not be matched to the other's record of the request.
   *
   * A launch's own identifier wins when it supplied one; see `nominatedWriteTarget`.
   */
  const nominated = nominatedWriteTarget(options.session, expiresAt);
  const requestId = nominated.requestId ?? crypto.randomUUID();

  /*
   * Channel C, when it is enabled. Off by default: the answers come back as a link the filler mints,
   * so there is nothing to describe and no slot to mint. With it on, the reply key generated here is
   * the only copy — see `CreatedRequest.reply`.
   */
  const keyPair = canUseEncryptedReply(config) ? await generateReplyKeyPair() : undefined;
  const replyUrl = keyPair ? await createReplySlot(blobStore) : undefined;
  const replyDescriptor: ReplyDescriptor | undefined =
    keyPair && replyUrl
      ? {
          replyUrl,
          replyMethod: 'PUT',
          publicJwk: keyPair.publicJwk,
          ...(expiresAt !== undefined ? { expiresAt } : {})
        }
      : undefined;

  /*
   * Channel D. Two ways to get one: a slot the launching EHR nominated, or one allocated on our own
   * blob store. Which of those wins, and why a nomination is not gated on `enableOneShotWrite`, is
   * decided by `nominatedWriteTarget` and reasoned about there.
   *
   * Self-minted slots are minted before the payload is sealed, because the invitation has to name a
   * resource that already exists and nothing can be added to a link once it is encrypted and
   * uploaded. A failure further down leaves an unanswered slot behind, which is harmless — an empty
   * `in-progress` QuestionnaireResponse. A nominated slot needs no such round trip: the EHR allocated
   * it before it launched us, which is why nothing is allocated here when one is in play.
   */
  const writeSlotServerUrl =
    !nominated.usesNomination && canUseOneShotWrite(config)
      ? resolveWriteSlotServerUrl(config)
      : null;
  const slot = writeSlotServerUrl
    ? await createWriteSlot(writeSlotServerUrl, {
        questionnaireCanonical: questionnaireCanonicalOf(questionnaire),
        requestId
      })
    : undefined;

  const writeDescriptor: WriteDescriptor | undefined =
    nominated.writeDescriptor ??
    (slot
      ? {
          writeUrl: slot.writeUrl,
          writeMethod: 'PUT',
          writeEtag: slot.writeEtag,
          writeToken: slot.writeToken,
          ...(expiresAt !== undefined ? { expiresAt } : {})
        }
      : undefined);

  /*
   * Publishing the Task and offering channel B are separate decisions, and conflating them would be a
   * mistake in both directions. Publishing only records that a request was sent, so `/requests` can
   * list it from any browser; channel B additionally tells the filler to write answers straight to that
   * server, unreviewed. So a Task may be published without channel B, but never the reverse — channel B
   * needs a Task to point at.
   */
  const serverReturn = canUseServerReturn(config);

  /*
   * A launch outranks configuration for the same reason it does everywhere else: it is the EHR saying
   * which record this clinician is working in, and it is backed by a token that configuration is not.
   */
  const taskServerUrl = options.session?.serverUrl ?? config.responseServerUrl;
  let serverTaskUrl: string | undefined;

  if (serverReturn) {
    /*
     * Fatal when channel B is on: the invitation is about to name this Task as somewhere the filler
     * may write, and naming one that does not exist would be worse than not offering the channel.
     */
    serverTaskUrl = await publishRequestTask(taskServerUrl!, questionnaire, {
      ...options,
      requestId
    });
  } else if (canTrackRequests(config, taskServerUrl)) {
    /*
     * Not fatal when publishing is only for tracking. The default return path — the filler mints a
     * link and the requester scans it back — needs nothing from this server, so an EHR that is down
     * would otherwise block a flow that does not depend on it. The request still works and is still
     * saved locally; it just shows as local-only in `/requests` until it is sent from a browser that
     * could reach the server.
     */
    try {
      serverTaskUrl = await publishRequestTask(taskServerUrl!, questionnaire, {
        ...options,
        requestId
      });
    } catch (cause) {
      console.warn('Could not publish the request Task for tracking; continuing without it.', cause);
    }
  }

  const { bundle, task } = buildRequestBundle(
    serverReturn ? declareResponseEndpoint(questionnaire, config.responseServerUrl!) : questionnaire,
    {
      requestId,
      subjectReference: options.subjectReference,
      subjectDisplay: options.subjectDisplay,
      // The launched user when signed in, `senderName` otherwise. An invitation that cannot say who
      // sent it is one a patient has every reason to decline.
      requesterDisplay: options.requesterDisplay ?? config.senderName ?? undefined,
      replyDescriptor,
      writeDescriptor,
      // Named in the invitation only when the filler is actually invited to write there. Tracking is
      // ours; there is no reason to tell a filler about a Task it must not touch.
      serverTaskUrl: serverReturn ? serverTaskUrl : undefined,
      prePopulated: options.prePopulated
    }
  );

  const codec = encodingCodec(config, LINK_CODECS);

  const link = await codec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config), blobStore, expiresAt }
  );

  return {
    link,
    task,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(keyPair && replyUrl ? { reply: { url: replyUrl, privateJwk: keyPair.privateJwk } } : {}),
    ...(serverTaskUrl ? { serverTaskUrl } : {}),
    serverReturnOffered: serverReturn,
    /*
     * Only a slot we allocated is reported back for local tracking, and a nominated one deliberately
     * is not. `sentRequests` uses this record to offer a "collect" action, and the answers in a
     * nominated slot belong to the EHR that allocated it — it will read them from its own record
     * system. Offering to collect them here would mean polling a server we do not own for a patient's
     * answers we were never the destination for.
     */
    ...(slot
      ? { write: { url: slot.writeUrl, etag: slot.writeEtag, token: slot.writeToken } }
      : {})
  };
}

/**
 * Build a "here are the answers" link from the form's current state.
 *
 * Empty and enableWhen-hidden answers are stripped first — partly hygiene, mostly size, since
 * everything removed here is payload that would otherwise count against the QR budget on the return
 * leg.
 *
 * `requestTask` is the Task that arrived with the request; passing it through is what lets the
 * requester match these answers to what it asked for.
 */
export async function createResponseLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  requestTask?: Task
): Promise<string> {
  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildResponseBundle(response, requestTask);

  const codec = encodingCodec(config, LINK_CODECS);

  return codec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config), blobStore: resolveBlobStore(config) }
  );
}

/**
 * Send the answers back through the request's encrypted reply channel.
 *
 * The filler's half of channel C, and the reason this app is a reference implementation on both sides
 * rather than only the requesting one. Everything happens on this device: the reply Bundle is built,
 * labelled patient-asserted, encrypted to the requester's public key, and only the ciphertext is
 * uploaded. The slot host — quite possibly a server nobody involved trusts — never sees plaintext.
 *
 * What this can and cannot confirm is worth being precise about, because the UI has to say it: a
 * successful return means the ciphertext reached the slot. It does **not** mean the requester has
 * collected it, and there is nothing to poll that would say otherwise.
 */
export async function sendEncryptedReply(
  questionnaire: Questionnaire,
  descriptor: ReplyDescriptor,
  requestTask?: Task
): Promise<void> {
  if (descriptor.replyMethod !== 'PUT') {
    throw new Error(
      `This request expects its reply to be delivered by "${descriptor.replyMethod}", which this app ` +
        'does not implement. Return the answers as a link instead.'
    );
  }

  if (isReplyDescriptorExpired(descriptor)) {
    throw new Error('This request has expired, so its reply slot will no longer accept answers.');
  }

  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildReplyBundle(response, { requestTask });

  await putReply(descriptor.replyUrl, await encryptReplyJwe(encodeUtf8(JSON.stringify(bundle)), descriptor.publicJwk));
}


/**
 * Send the answers through the request's one-shot write channel (channel D).
 *
 * The filler's half, and — like {@link sendEncryptedReply} — the reason this app is a reference
 * implementation on both sides rather than only the requesting one. Everything worth knowing about
 * what this does and does not claim:
 *
 *  - **It is conditional.** The `If-Match` the descriptor carries is what makes this a *single*
 *    write. A slot someone has already answered refuses the second write rather than silently
 *    overwriting it, and that outcome comes back as `taken` — not as a failure to retry.
 *  - **It confirms delivery to a slot and nothing more.** The requester still has to collect the
 *    answers and a human still has to review them before anything reaches a record. There is no
 *    signal available for either, so nothing here may imply one.
 *  - **The slot host sees the answers.** This is plaintext FHIR; channel C is what to use when the
 *    host must not.
 */
export async function sendOneShotWrite(
  questionnaire: Questionnaire,
  descriptor: WriteDescriptor,
  requestTask?: Task
): Promise<WriteSlotOutcome> {
  if (isWriteDescriptorExpired(descriptor)) {
    throw new Error('This request has expired, so its slot will no longer accept answers.');
  }

  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);

  return putResponseToSlot(descriptor, buildWriteResponse(response, { requestTask }));
}
