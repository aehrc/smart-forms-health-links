import { JOSE_CONTENT_TYPE, type BlobStore } from '@/fhir/blobStore';
import { encodeUtf8 } from './binary';
import { looksLikeReplyJwe } from './replyCrypto';

/**
 * The reply slot: somewhere a filler can park one encrypted reply for the requester to collect.
 *
 * Deliberately the smallest contract that closes the loop — one unconditional write, one read:
 *
 *   mint    POST {blobServerUrl}/Binary   Content-Type: application/jose   body: "pending"
 *   reply   PUT  {replyUrl}               Content-Type: application/jose   body: <reply JWE>
 *   poll    GET  {replyUrl}               -> "pending" | <reply JWE>
 *
 * That is exactly the surface a FHIR server already offers, so channel C needs **no new
 * infrastructure tier** — the same `blobServerUrl` that hosts the outbound payload hosts the return
 * one. It is also strictly less client code than a token-and-grant handshake, which matters because
 * every third-party filler has to implement it.
 *
 * ## What this trades away
 *
 * A plain FHIR slot cannot gate writes. Anyone who can reach the server can overwrite a slot, and on
 * HAPI resource ids are sequential, so they need not even have seen the link. What they cannot do is
 * *read* a reply: it is encrypted to the requester's public key, and the private half never leaves the
 * requester. So the exposure is destruction, not disclosure — the same bound Platypus states for a
 * leaked invitation, reached by a different route. `ReplyDescriptor.replyToken` is reserved for hosts
 * that can do better, and needs no change to this wire format.
 *
 * These functions take an absolute URL rather than going through {@link BlobStore}, because a filler
 * holds a URL for a server it has no configuration for at all. Only minting needs a store.
 */

/** Marks the content of a slot that has not been answered yet. */
export const REPLY_SLOT_PENDING_PREFIX = 'pending';

/**
 * Body written into a newly minted slot.
 *
 * Unique per slot, and it has to be. A fixed sentinel makes every slot after the first byte-identical
 * to one the server already holds, and a server that deduplicates creates rejects it outright:
 *
 *   HAPI-2840: Can not create resource duplicating existing resource: Binary/137287130
 *
 * So the second request ever minted against such a server would fail to get a slot. The same
 * constraint already applies to the test Patient in `scripts/e2eShl.ts`.
 *
 * Nothing reads this value — {@link looksLikeReplyJwe} decides "answered" structurally — so it is free
 * to vary.
 */
export function replySlotPlaceholder(): string {
  return `${REPLY_SLOT_PENDING_PREFIX}:${crypto.randomUUID()}`;
}

export type ReplyPoll =
  | { status: 'pending' }
  | { status: 'ready'; jwe: string }
  | { status: 'gone' };

/**
 * Mint an empty reply slot and return its URL.
 *
 * The placeholder write is what reserves the URL: it has to exist before the invitation can name it,
 * and a FHIR server assigns the id. Its content type is already `application/jose` so that the slot
 * serves a reply back verbatim once written — the same bare-`GET`-returns-raw-bytes behaviour the SHL
 * `U` flag depends on, documented in `src/fhir/blobStore.ts`.
 */
export async function createReplySlot(blobStore: BlobStore): Promise<string> {
  return blobStore.put(encodeUtf8(replySlotPlaceholder()), JOSE_CONTENT_TYPE);
}

/**
 * Deliver an encrypted reply to a slot.
 *
 * A blind overwrite, by design: the slot's whole purpose is to hold the latest reply, and a filler
 * correcting and resending should replace rather than accumulate. The requester correlates by *which
 * slot* the reply arrived in, so nothing depends on the slot's history.
 */
export async function putReply(replyUrl: string, jwe: string): Promise<void> {
  const response = await fetch(replyUrl, {
    method: 'PUT',
    headers: { 'Content-Type': JOSE_CONTENT_TYPE },
    body: encodeUtf8(jwe) as BodyInit
  });

  if (!response.ok) {
    throw new Error(
      `Could not deliver the reply to ${replyUrl} (${response.status} ${response.statusText}). ` +
        'The answers have not been sent.'
    );
  }
}

/**
 * Check a slot for a reply.
 *
 * No `Accept` header, for the reason `shlCodec.ts` documents: a FHIR server hands back a `Binary`
 * resource wrapper for `application/fhir+json`, whereas what is wanted here is the stored bytes.
 *
 * A 404 or 410 is reported as `gone` rather than as an error. A slot that has been deleted or has
 * expired is a normal end state for a request nobody answered, and the caller should say so plainly
 * instead of showing a failed fetch.
 */
export async function pollReply(replyUrl: string, signal?: AbortSignal): Promise<ReplyPoll> {
  const response = await fetch(replyUrl, { signal });

  if (response.status === 404 || response.status === 410) {
    return { status: 'gone' };
  }

  if (!response.ok) {
    throw new Error(
      `Could not check for a reply (${response.status} ${response.statusText}).`
    );
  }

  const body = (await response.text()).trim();
  return looksLikeReplyJwe(body) ? { status: 'ready', jwe: body } : { status: 'pending' };
}
