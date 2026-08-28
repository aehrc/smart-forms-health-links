import { isSafeWriteUrl } from '@/link/replyDescriptor';

/**
 * The write slot a launching EHR may nominate, and the rule for whether to believe it.
 *
 * Separate from `smartSession.ts` on purpose. That module owns `fhirclient` and is deliberately the
 * only one that does; this is a pure reading of two strings, and keeping it here means the decision
 * — whether a patient will be told to send their answers to a given address — can be exercised
 * without standing up an OAuth flow to reach it.
 */

/**
 * A write slot on the launching EHR's own server, offered through the launch context.
 *
 * This is the EHR saying "put the answers here, with this". It is deliberately the same shape the
 * invitation's write descriptor already carries, minus the parts only the allocator can know: no
 * `writeEtag`, because a slot the EHR allocated is at whatever version the EHR left it at and it is
 * the EHR's job to enforce single-use on its own resource, not ours to guess a version to gate on.
 */
export interface NominatedWriteSlot {
  /** Absolute `https` URL of the QuestionnaireResponse to write. Validated before it is ever named. */
  readonly url: string;

  /** Bearer capability for exactly that slot. Absent when the EHR left the slot unauthenticated. */
  readonly token: string | null;
}

/**
 * Interpret the launch context's nominated write slot.
 *
 * The keys these come from are snake_case (`write_slot_url`, `write_slot_token`), because that is the
 * convention every other SMART launch-context parameter follows (`need_patient_banner`,
 * `smart_web_messaging_handle`) and an authorisation server adding one should not have to guess at a
 * different style for ours.
 *
 * An unsafe address is dropped here rather than carried and refused later: the same rule
 * {@link isSafeWriteUrl} enforces on an address arriving in link content applies to one arriving in a
 * launch, and a session that reports no slot produces an invitation that honestly offers no channel.
 * Silently substituting our own blob store instead would send a patient's answers somewhere the EHR
 * did not ask for, which is worse than offering one fewer way to reply.
 */
export function nominatedWriteSlotFrom(
  url: string | undefined | null,
  token: string | undefined | null
): NominatedWriteSlot | null {
  if (!url) {
    return null;
  }

  if (!isSafeWriteUrl(url)) {
    console.warn(
      `The launch nominated "${url}" as a write slot, which is not an address a filler may be sent to. ` +
        'Ignoring it; this request will offer no one-shot write channel.'
    );
    return null;
  }

  return { url, token: token ?? null };
}
