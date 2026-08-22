import { useEffect, useState } from "react";

import {
  checksPriorSubmission,
  currentSendStatus,
  msUntilWindowCloses,
  readPriorSubmission,
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
 * ## Why opening the link asks the destination a question
 *
 * A link can be reopened, on the same device or another one, after the answers have already been
 * sent. Nothing in the link says so - it is the same fragment either way - so the only way to
 * know is to ask the destination what the published Task says now
 * ({@link readPriorSubmission}). Until it answers, the state is `checking`: the form renders, and
 * the send affordance is withheld rather than shown and then taken away. An answer of "already
 * there" is the terminal sent state, which is what the spec's edge case asks for - "the filler
 * shows the terminal sent state, not a fresh form". Anything else, including a read that failed,
 * offers the send.
 *
 * The check is identified by the credential and the Task it is about, not by the target object:
 * `directSendTarget` builds a fresh one on every render, so keying the read on object identity
 * would re-present the token to the destination every time anything on the page changed.
 *
 * ## What it deliberately does not own
 *
 * The answers. They live in the renderer's store, and this hook takes them as an argument to
 * {@link DirectSend.send} instead of reaching for them - which keeps the whole of the send's state
 * machine testable without mounting a form.
 * @author John Grimes
 */

/** A resolved prior-submission check, and which check it was the answer to. */
interface PriorSubmissionAnswer {
  /** The credential and Task the answer is about. */
  readonly key: string;
  /** Whether the destination already holds this invitation's answers. */
  readonly already: boolean;
}

/** The live direct send: its current state, and the action that starts it. */
export interface DirectSend {
  /** Where the send is up to, or undefined when the invitation offers no direct channel. */
  readonly status: SendStatus | undefined;
  /** Send the answers. Does nothing when there is no channel to send them down. */
  readonly send: (answers: QuestionnaireResponse) => void;
}

/**
 * Track a direct send, closing its window on time and recognising one already made.
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
  const [answer, setAnswer] = useState<PriorSubmissionAnswer | undefined>();
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

  const received = target?.received;
  const serverTaskUrl = target?.serverTaskUrl;
  /** What identifies this check: the credential presented, and the Task it asks about. */
  const key =
    received && serverTaskUrl
      ? `${received.grant.access_token}\u0000${serverTaskUrl}`
      : undefined;
  /** Whether a check may be made at all - and, once the window closes, may not be. */
  const checkable = checksPriorSubmission(target, now);

  useEffect(() => {
    if (!checkable || !received || serverTaskUrl === undefined) {
      return;
    }

    /*
     * The window can close while this read is in flight, which unmounts the check rather than the
     * component: `live` is what stops a late answer overwriting the closed state.
     */
    let live = true;
    readPriorSubmission({ received, serverTaskUrl })
      .then((already) => {
        if (live) {
          setAnswer({ key: key ?? "", already });
        }
      })
      /*
       * `readPriorSubmission` classifies rather than throws, so there is nothing here to be told
       * about. Unknown is "offer the send" either way, and the one thing that must not happen is
       * the surface staying on "checking" for good.
       */
      .catch(() => {
        if (live) {
          setAnswer({ key: key ?? "", already: false });
        }
      });

    return () => {
      live = false;
    };
  }, [checkable, key, received, serverTaskUrl]);

  /*
   * The check's finding is a *baseline* rather than a state of its own: an attempt made on this
   * device always describes what happened more precisely than a Task read does, and
   * {@link currentSendStatus} still has the last word about the window.
   */
  let baseline: SendStatus | undefined;
  if (target) {
    const resolved = answer?.key === key ? answer : undefined;
    if (resolved?.already === true) {
      baseline = {
        state: "sent",
        detail: `${target.host} has already accepted these answers.`,
      };
    } else if (checkable && resolved === undefined) {
      baseline = { state: "checking" };
    }
  }

  return {
    status: target
      ? currentSendStatus({
          received: target.received,
          attempted: attempted ?? baseline,
          now,
        })
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
