import type { WriteDescriptor } from './replyDescriptor';
import type { NominatedWriteSlot } from '@/auth/nominatedSlot';

/**
 * Where a request's answers should be written, when the launching EHR has said.
 *
 * Split out of `createRequestLink` so it can be exercised without it. That function imports
 * `@aehrc/smart-forms-renderer` — the layer where the renderer's global form state meets the codecs —
 * which pulls the `.woff2` esbuild has no loader for, and is why no check script imports it (see the
 * note in `scripts/e2ePopulate.ts`). The decision below is the part worth asserting: which slot a
 * patient will be told to send their answers to, and under which identifier. Keeping it here means a
 * check can prove it directly rather than a script working around a bundling constraint the rest of
 * the repo respects.
 */

/** What a launch's nomination determines, or the absence of one. */
export interface NominatedWriteTarget {
  /**
   * The identifier this request must be known by, or null to mint one.
   *
   * Non-null only when the EHR supplied one. It has *already* recorded a request under that value,
   * and the Task published back to it plus the answers written to its slot are the two things it will
   * match against that record; minting our own would leave every returned response correlating to
   * nothing on the system that asked for it.
   */
  readonly requestId: string | null;

  /** The write descriptor to put on the invitation, or undefined when there is no nomination. */
  readonly writeDescriptor: WriteDescriptor | undefined;

  /**
   * Whether a nomination is in play, and therefore whether this app must NOT allocate a slot of its
   * own. Distinct from `writeDescriptor !== undefined` only in that it says why.
   */
  readonly usesNomination: boolean;
}

/**
 * Read a launch's nominated write slot into the invitation's terms.
 *
 * A nomination outranks our own blob store — the same rule, and for the same reason, as the one
 * governing which server the request Task is published to: a launch is the record system saying where
 * this work belongs, backed by a token that configuration is not.
 *
 * Deliberately not gated on `enableOneShotWrite`, which is why this takes no config. That flag
 * answers "may this app allocate slots on its blob store", a question about our storage and our
 * liability for holding a patient's answers. Relaying an address the EHR allocated raises neither:
 * nothing lands here, and the EHR is the party that launched us and already holds the record. Gating
 * it would mean an EHR could nominate a slot and be silently ignored because of a flag about storage
 * it is not asking us to use.
 *
 * No `writeEtag` is set. The EHR allocated the resource and is at liberty to enforce single-use on it
 * however it likes — a version precondition, a write-once store, anything. A version we invented
 * would either be wrong or would forbid the write outright, and `putResponseToSlot` omits `If-Match`
 * entirely when there is no etag, which is what a slot we did not allocate needs.
 */
export function nominatedWriteTarget(
  session: { nominatedWriteSlot?: NominatedWriteSlot | null; nominatedRequestId?: string | null } | null | undefined,
  expiresAt: number | undefined
): NominatedWriteTarget {
  const slot = session?.nominatedWriteSlot ?? null;

  if (!slot) {
    return {
      requestId: session?.nominatedRequestId ?? null,
      writeDescriptor: undefined,
      usesNomination: false
    };
  }

  return {
    requestId: session?.nominatedRequestId ?? null,
    writeDescriptor: {
      writeUrl: slot.url,
      writeMethod: 'PUT',
      ...(slot.token !== null ? { writeToken: slot.token } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {})
    },
    usesNomination: true
  };
}
