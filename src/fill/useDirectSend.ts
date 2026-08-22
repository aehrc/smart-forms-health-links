import { useEffect, useState } from "react";

import {
  currentSendStatus,
  msUntilWindowCloses,
  sendDirect,
  type DirectSendTarget,
  type SendStatus,
} from "./directSend";

import type { QuestionnaireResponse } from "fhir/r4";

/**
 * The direct send as a piece of live state: where it is up to, and how to start it.
 *
 * ## Why the window needs a timer
 *
 * Deriving the state during render is not enough, and the gap is the whole of User Story 4. A
 * person opens an invitation, reads it, fills in a form, and thinks. Nothing about that
 * re-renders the page - no query settles, no route changes, nothing is clicked - so a state
 * derived once at mount is the state that stays on screen. If the grant's window closes in the
 * meantime, a live "send answers" button sits over a dead token until someone presses it. That is
 * exactly the dishonest surface FR-025 is about, and the fix is to schedule the transition for the
 * instant the window closes rather than wait for something else to happen.
 *
 * The timer is armed from {@link msUntilWindowCloses}, so it inherits the same measurement: the
 * grant's stated lifetime, counted from when the manifest was read. No polling, and no clock
 * comparison with the server.
 *
 * ## What it deliberately does not own
 *
 * The answers. They live in the renderer's store, and this hook takes them as an argument to
 * {@link DirectSend.send} instead of reaching for them - which keeps the whole of the send's state
 * machine testable without mounting a form.
 * @author John Grimes
 */

/** The live direct send: its current state, and the action that starts it. */
export interface DirectSend {
  /** Where the send is up to, or undefined when the invitation offers no direct channel. */
  readonly status: SendStatus | undefined;
  /** Send the answers. Does nothing when there is no channel to send them down. */
  readonly send: (answers: QuestionnaireResponse) => void;
}

/**
 * Track a direct send, closing its window on time.
 * @param target what the invitation offers by way of a direct send, if anything
 * @returns the current state and the action that starts a send
 * @example
 * const { status, send } = useDirectSend(target);
 * <DirectSendPanel status={status} onSend={() => send(getResponse())} … />
 */
export function useDirectSend(
  target: DirectSendTarget | undefined,
): DirectSend {
  const [attempted, setAttempted] = useState<SendStatus | undefined>();
  /*
   * The clock this component judges the window against. It advances exactly once, when the window
   * closes - which is the only moment at which the answer changes.
   */
  const [now, setNow] = useState(() => Date.now());

  /** Milliseconds until this grant's window closes, when it has one still to close. */
  let remaining: number | undefined;
  if (target) {
    remaining = msUntilWindowCloses(target.received, now);
  }

  useEffect(() => {
    if (remaining === undefined) {
      return;
    }

    // One millisecond past the boundary, so the grant is unambiguously expired when this fires.
    const timer = setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => clearTimeout(timer);
  }, [remaining]);

  return {
    status: target
      ? currentSendStatus({ received: target.received, attempted, now })
      : undefined,
    send: (answers: QuestionnaireResponse) => {
      if (!target) {
        return;
      }

      setAttempted({ state: "sending" });
      sendDirect({
        response: answers,
        received: target.received,
        requestIdentifier: target.requestIdentifier,
        serverTaskUrl: target.serverTaskUrl,
        patientDisplay: target.patientDisplay,
      })
        .then(setAttempted)
        /*
         * `sendDirect` classifies rather than throws, so the only way here is answers the
         * transaction could not be built from - which is still a send that did not happen, and
         * must not leave the surface stuck on "sending".
         */
        .catch((error: unknown) => {
          setAttempted({
            state: "failed",
            detail:
              `The answers could not be prepared for sending to ${target.host} ` +
              `(${error instanceof Error ? error.message : String(error)}), so nothing was sent.`,
          });
        });
    },
  };
}
