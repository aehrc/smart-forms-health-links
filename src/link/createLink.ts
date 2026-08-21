import {
  getResponse,
  removeEmptyAnswersFromResponse,
} from "@aehrc/smart-forms-renderer";

import { encodeUtf8 } from "./binary";
import {
  defaultLabel,
  encodingCodec,
  ensureQuestionnaireCanonical,
} from "./codec";
import {
  buildReplyBundle,
  buildRequestBundle,
  buildResponseBundle,
} from "./exchange";
import { LINK_CODECS } from "./registry";
import { encryptReplyJwe, type ReplyPrivateJwk } from "./replyCrypto";
import {
  isReplyDescriptorExpired,
  type ReplyDescriptor,
} from "./replyDescriptor";
import { putReply } from "./replySlot";

import type { AppConfig } from "@/lib/config";
import type { Questionnaire, Task } from "fhir/r4";

import { type BlobStore } from "@/fhir/blobStore";
import { resolveExpiry, resolveLinkBaseUrl } from "@/lib/config";

/**
 * Link creation — the boundary where the renderer's global form state and the app's config meet the
 * codecs. This is the only part of the link layer that depends on `@aehrc/smart-forms-renderer`.
 *
 * TODO(phase-4): T031 replaces the two functions below and reworks minting onto
 * `POST /api/invitations`, which hosts the encrypted payload on the BFF (FR-013) instead of on a
 * third-party blob server. The `blobServerUrl` and `blobStore` configuration keys that used to
 * answer "where does the payload live" were deleted with the rest of anonymous mode in T022, so
 * until T031 lands there is nowhere for the browser to host one and minting is unavailable. T032
 * then deletes `src/fhir/blobStore.ts`, `src/link/replySlot.ts` and `src/link/collectReply.ts`
 * outright, along with the reply-slot half of this module.
 */

/**
 * Whether this app can mint SMART Health Links.
 *
 * TODO(phase-4): T031. Always false until minting moves to `POST /api/invitations`; the surfaces
 * that ask show an explanation rather than a mint button that could not work.
 */
export function canCreateHealthLinks(): boolean {
  return false;
}

/**
 * Where a SMART Health Link's encrypted payload gets hosted.
 *
 * TODO(phase-4): T031 replaces this with the BFF's own hosting. Throws in the meantime: there is
 * no configured blob server any more, and inventing one would put transactional data on a server
 * nobody chose.
 */
export function resolveBlobStore(): BlobStore {
  throw new Error(
    "Minting a SMART Health Link is not available in this build: hosting for the encrypted " +
      "payload moves to this app's own server, which is not implemented yet.",
  );
}

export interface CreateRequestOptions {
  /** Who the form is for, e.g. `Patient/123`. */
  subjectReference?: string;
  /** Who the form is for, in words — the part a filler can actually read. */
  subjectDisplay?: string;
  /** Overrides the expiry derived from `linkLifetimeDays`. */
  expiresAt?: number;
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
}

/**
 * Build a "please fill this in" link.
 *
 * The Questionnaire is embedded whole so the filler needs no forms-server access, which is what
 * pushes this onto the hosted-SHL path — hundreds of kilobytes cannot ride inside a QR code.
 *
 * TODO(phase-4): T031. Channel B (`sdc-questionnaire-endpoint` declaration) and channel C (the
 * encrypted reply slot) are gone with the configuration keys that enabled them, and Task
 * publishing moves server-side where it can use the session's authority (FR-010). What is left
 * here builds the invitation Bundle and asks the codec to seal it, which is the half T031 keeps -
 * it will call `POST /api/invitations` instead of hosting the payload from the browser, so
 * {@link resolveBlobStore} throws until then and this function cannot currently complete.
 */
export async function createRequestLink(
  questionnaire: Questionnaire,
  config: AppConfig,
  options: CreateRequestOptions = {},
): Promise<CreatedRequest> {
  const blobStore = resolveBlobStore();
  const expiresAt = options.expiresAt ?? resolveExpiry(config);
  /*
   * The business identifier shared by the embedded Task and the copy published to the launched
   * server. It is the only correlation key that survives the round trip: `urn:uuid` references
   * are relative to a Bundle that no longer exists by the time answers come back, and the two
   * copies of the Task have different server ids.
   */
  const requestId = crypto.randomUUID();

  const { bundle, task } = buildRequestBundle(questionnaire, {
    requestId,
    subjectReference: options.subjectReference,
    subjectDisplay: options.subjectDisplay,
    requesterDisplay: config.senderName ?? undefined,
  });

  const codec = encodingCodec(config, LINK_CODECS);

  const link = await codec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    { baseUrl: resolveLinkBaseUrl(config), blobStore, expiresAt },
  );

  return {
    link,
    task,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    serverReturnOffered: false,
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
  requestTask?: Task,
): Promise<string> {
  const trimmed = removeEmptyAnswersFromResponse(questionnaire, getResponse());
  const response = ensureQuestionnaireCanonical(trimmed, questionnaire);
  const { bundle } = buildResponseBundle(response, requestTask);

  const codec = encodingCodec(config, LINK_CODECS);

  return codec.encode(
    { bundle, label: defaultLabel(questionnaire) },
    {
      baseUrl: resolveLinkBaseUrl(config),
      blobStore: resolveBlobStore(),
    },
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
