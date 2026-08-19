import type { Questionnaire } from 'fhir/r4';
import { fetchQuestionnaireByCanonical } from '@/fhir/formsServer';
import type { OutstandingRequest } from '@/lib/requestStore';
import { decodeUtf8 } from './binary';
import { bundleFromJson } from './codec';
import { parseResponseBundle, responseCanonical, type ResponsePayload } from './exchange';
import { decryptReplyJwe } from './replyCrypto';
import { pollReply } from './replySlot';
import { pollWriteSlot } from './writeSlot';

/**
 * The requester's half of channel C: collect an encrypted reply and turn it into something reviewable.
 *
 * This is the step that keeps the whole design inside the specs. SMART Health Links define no
 * submission channel, so nothing was ever *pushed* here — a filler parked ciphertext in a slot, and this
 * pulls it, decrypts it locally, and hands it to a human. Only after that does anything get written.
 *
 * {@link collectAnswers} extends the same shape to channel D, where the slot holds a plain
 * `QuestionnaireResponse` instead of ciphertext. The difference ends at the fetch: both produce a
 * {@link ResponsePayload} for the same review screen, and neither writes anything.
 */

export type CollectOutcome =
  | { status: 'pending' }
  /** The slot is gone: deleted, or expired and swept. A request nobody answered ends here. */
  | { status: 'gone' }
  | { status: 'ready'; payload: ResponsePayload; questionnaire: Questionnaire };

/**
 * Decrypt a reply and pull the answers out of it.
 *
 * Separate from the fetch so the crypto can be exercised without a slot, and so a reply captured by
 * other means can still be opened.
 */
export async function decodeReply(jwe: string, request: OutstandingRequest): Promise<ResponsePayload> {
  if (!request.reply) {
    throw new Error('This request has no reply key stored, so its reply cannot be decrypted.');
  }

  return parseResponseBundle(
    bundleFromJson(decodeUtf8(await decryptReplyJwe(jwe, request.reply.privateJwk)), 'reply')
  );
}

/**
 * Check a request's reply slot and, if answered, resolve the form the answers belong to.
 *
 * The Questionnaire is resolved from the response's canonical against the forms server rather than
 * carried in the reply — re-sending hundreds of kilobytes of questionnaire back would be absurd when the
 * requester is the party that already has it.
 */
export async function collectReply(
  request: OutstandingRequest,
  formsServerUrl: string,
  signal?: AbortSignal
): Promise<CollectOutcome> {
  if (!request.reply) {
    return { status: 'gone' };
  }

  const poll = await pollReply(request.reply.url, signal);
  if (poll.status !== 'ready') {
    return { status: poll.status };
  }

  const payload = await decodeReply(poll.jwe, request);

  const canonical = responseCanonical(payload.response, request.questionnaireCanonical);
  if (!canonical) {
    throw new Error(
      'The reply does not say which questionnaire it answers, so the form cannot be resolved.'
    );
  }

  return {
    status: 'ready',
    payload,
    questionnaire: await fetchQuestionnaireByCanonical(formsServerUrl, canonical, signal)
  };
}


/**
 * Collect the answers a request is waiting on, whichever slot it offered.
 *
 * Channel C first when a request offers both. A reply is encrypted to a key only this browser holds,
 * so it is the stronger evidence of who sent it; a write slot is a resource anyone who could reach
 * the host could have written. Preferring the weaker one when the stronger is present would be an
 * odd thing to do silently.
 *
 * There is deliberately no merging of the two. If both slots somehow hold answers, that is a fact a
 * human should see rather than something to reconcile automatically — collecting channel C leaves
 * the write slot untouched and still readable.
 */
export async function collectAnswers(
  request: OutstandingRequest,
  formsServerUrl: string,
  signal?: AbortSignal
): Promise<CollectOutcome> {
  if (request.reply) {
    return collectReply(request, formsServerUrl, signal);
  }

  return collectWrittenAnswers(request, formsServerUrl, signal);
}

/**
 * The requester's half of channel D: read what a filler wrote into the slot.
 *
 * No decryption, and no Bundle to take apart — the capability addressed one resource, so one resource
 * is what comes back. It is normalised into the same {@link ResponsePayload} the other channels
 * produce, with no `task` and no `provenance`, because there was nowhere to put either. What carries
 * the attribution instead is `meta.security` = `PATAST` on the response itself, which is why
 * `asNewResource` must keep it.
 */
export async function collectWrittenAnswers(
  request: OutstandingRequest,
  formsServerUrl: string,
  signal?: AbortSignal
): Promise<CollectOutcome> {
  if (!request.write) {
    return { status: 'gone' };
  }

  const poll = await pollWriteSlot(request.write.url, signal);
  if (poll.status !== 'ready') {
    return { status: poll.status };
  }

  const canonical = responseCanonical(poll.response, request.questionnaireCanonical);
  if (!canonical) {
    throw new Error(
      'The answers do not say which questionnaire they answer, so the form cannot be resolved.'
    );
  }

  return {
    status: 'ready',
    payload: { response: poll.response },
    questionnaire: await fetchQuestionnaireByCanonical(formsServerUrl, canonical, signal)
  };
}
