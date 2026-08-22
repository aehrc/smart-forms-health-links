// @vitest-environment jsdom
/**
 * The closing of the direct-send window, and what the filler is offered once it has closed.
 *
 * Three properties, and they are separable.
 *
 * **The clock.** Expiry is `expires_in` counted from the moment the grant arrived, never a
 * comparison against a timestamp the server chose. Two clocks that disagree are the normal case,
 * not the exceptional one: the token endpoint, the resource server and the phone in someone's
 * hand are three machines, and the spec's clock-skew edge case says the filler's answer comes
 * from the only measurement it can make itself - how long ago it read the manifest.
 *
 * **Silence.** An expired grant issues nothing. Not a probe, not a Task read, not an optimistic
 * attempt that fails informatively. FR-025's "only while the grant is unexpired" is a statement
 * about requests, so the assertion is on the fetch spy's call count rather than on the state
 * name.
 *
 * **The promotion.** A closed window is only honest if it leaves somewhere to go. So the panel
 * says the window closed, offers no send affordance at all, and {@link promotesScanBack} tells
 * the surrounding surface to make the scan-back return the primary action (FR-025, FR-028).
 *
 * The last group covers the case the other two cannot: the window closing while the page sits
 * open. A filler who spends four minutes on a form whose grant lasted one must not be looking at
 * a live send button, and nothing re-renders the page on its own - so the hook schedules the
 * transition.
 * @author John Grimes
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DirectSendTarget,
  SendState,
  SendStatus,
} from "@/fill/directSend";
import type { ReceivedGrant } from "@/link/apiAccess";
import type { QuestionnaireResponse } from "fhir/r4";
import type { Root } from "react-dom/client";
import type { Mock } from "vitest";

import {
  canSend,
  currentSendStatus,
  msUntilWindowCloses,
  promotesScanBack,
  sendDirect,
  suppressesOtherChannels,
} from "@/fill/directSend";
import DirectSendPanel from "@/fill/DirectSendPanel";
import { useDirectSend } from "@/fill/useDirectSend";

/** The moment the manifest was read, and the only clock any of this is measured against. */
const RECEIVED_AT = 1_700_000_000_000;

/** One hour, in the grant's own units. */
const ONE_HOUR = 3600;

const HOST = "ehr.example.org";

/**
 * A grant as it arrived.
 * @param expiresIn the stated lifetime in seconds; omitted for a grant that stated none
 * @param receivedAt when it arrived; defaults to {@link RECEIVED_AT}
 * @returns the received grant
 */
function received(expiresIn?: number, receivedAt = RECEIVED_AT): ReceivedGrant {
  return {
    grant: {
      access_token: "opaque-access-token",
      token_type: "Bearer",
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      aud: `https://${HOST}/fhir`,
      patient: "pt-demo",
    },
    receivedAt,
  };
}

/** The answers a send would carry. */
const ANSWERS: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: "http://example.org/Questionnaire/q|1.0.0",
  authored: "2026-08-22T01:02:03.000Z",
};

/**
 * A target built over a received grant.
 * @param grant the grant and the moment it arrived
 * @returns everything a send needs
 */
function target(grant: ReceivedGrant): DirectSendTarget {
  return {
    received: grant,
    host: HOST,
    requestIdentifier: "urn:uuid:request-1",
    serverTaskUrl: `https://${HOST}/fhir/Task/task-1`,
    patientDisplay: "Jane Citizen",
  };
}

/**
 * A target whose invitation named no published Task.
 *
 * Opening an invitation that names one reads it, to see whether the answers are already there.
 * That read is a different property, tested in `reopenedInvitation.test.ts`; leaving it out keeps
 * a send as the only thing on the surface that can issue a request, which is what makes the fetch
 * counts in the last group below statements about the clock.
 * @param grant the grant and the moment it arrived
 * @returns the target, with no Task to ask about
 */
function unpublished(grant: ReceivedGrant): DirectSendTarget {
  return { ...target(grant), serverTaskUrl: undefined };
}

describe("when the window closes", () => {
  /*
   * The measurement itself. `expires_in` is a duration, and the only instant it can be counted
   * from is the one this device observed - which is why a grant received a day ago with the same
   * stated lifetime as one received a second ago is not in the same state.
   */
  it("counts the window from the moment the grant arrived, not from any server's clock", () => {
    const justNow = received(ONE_HOUR, RECEIVED_AT);
    const yesterday = received(ONE_HOUR, RECEIVED_AT - 86_400_000);

    expect(msUntilWindowCloses(justNow, RECEIVED_AT)).toBe(ONE_HOUR * 1000);
    expect(msUntilWindowCloses(yesterday, RECEIVED_AT)).toBeUndefined();
  });

  /*
   * A backend whose clock runs an hour fast, or an hour slow, changes nothing. There is no
   * timestamp from the token response in this calculation to be skewed - the spec's clock-skew
   * edge case, stated as a test.
   */
  it("is unaffected by a local clock that disagrees with the server's", () => {
    const skewedForward = received(ONE_HOUR, RECEIVED_AT + 3_600_000);
    const skewedBack = received(ONE_HOUR, RECEIVED_AT - 3_600_000);

    // Whatever the receipt instant was, the window is exactly the stated lifetime long.
    expect(msUntilWindowCloses(skewedForward, RECEIVED_AT + 3_600_000)).toBe(
      ONE_HOUR * 1000,
    );
    expect(msUntilWindowCloses(skewedBack, RECEIVED_AT - 3_600_000)).toBe(
      ONE_HOUR * 1000,
    );
  });

  // Nothing to schedule, and nothing to have expired: the destination is the only authority.
  it("reports no window at all for a grant that stated no lifetime", () => {
    expect(msUntilWindowCloses(received(), RECEIVED_AT)).toBeUndefined();
    expect(
      msUntilWindowCloses(received(), RECEIVED_AT + 86_400_000 * 365),
    ).toBeUndefined();
  });

  // The boundary. One millisecond before closing is open; one after is not.
  it("stays open right up to the closing instant", () => {
    const grant = received(ONE_HOUR);
    const closesAt = RECEIVED_AT + ONE_HOUR * 1000;

    expect(currentSendStatus({ received: grant, now: closesAt }).state).toBe(
      "idle",
    );
    expect(
      currentSendStatus({ received: grant, now: closesAt + 1 }).state,
    ).toBe("expired");
  });
});

describe("what the window's closing does to a send state", () => {
  const OPEN = RECEIVED_AT + 60_000;
  const CLOSED = RECEIVED_AT + ONE_HOUR * 1000 + 1;

  // Nothing attempted yet, window open: the send is offered.
  it("offers a send while nothing has been attempted and the window is open", () => {
    const status = currentSendStatus({
      received: received(ONE_HOUR),
      now: OPEN,
    });

    expect(status.state).toBe("idle");
    expect(canSend(status)).toBe(true);
  });

  /*
   * The case a render-time derivation gets wrong. A failed send leaves a retry button on screen;
   * if the window closes underneath it, the retry has to go - a request from a closed window is
   * the one thing FR-025 forbids.
   */
  it("withdraws the retry left by a failed send once the window closes", () => {
    const failed: SendStatus = { state: "failed", detail: "could not connect" };

    expect(
      canSend(
        currentSendStatus({
          received: received(ONE_HOUR),
          attempted: failed,
          now: OPEN,
        }),
      ),
    ).toBe(true);

    const afterwards = currentSendStatus({
      received: received(ONE_HOUR),
      attempted: failed,
      now: CLOSED,
    });
    expect(afterwards.state).toBe("expired");
    expect(canSend(afterwards)).toBe(false);
  });

  /*
   * The mirror image, and the reason expiry is not simply layered over everything. A send that
   * was accepted stays accepted: the answers are in the record at the destination, and the clock
   * running out afterwards does not un-write them. Telling the filler the window closed would
   * read as though the send had not happened.
   */
  it("leaves an accepted send alone when the window closes afterwards", () => {
    const sent: SendStatus = {
      state: "sent",
      detail: `${HOST} accepted the answers.`,
    };

    expect(
      currentSendStatus({
        received: received(ONE_HOUR),
        attempted: sent,
        now: CLOSED,
      }),
    ).toEqual(sent);
  });

  // A refusal is the more specific and more useful explanation, so it survives too.
  it("leaves a refusal alone when the window closes afterwards", () => {
    const refused: SendStatus = {
      state: "refused",
      detail: `${HOST} would not authorise this link to write the answers.`,
    };

    expect(
      currentSendStatus({
        received: received(ONE_HOUR),
        attempted: refused,
        now: CLOSED,
      }),
    ).toEqual(refused);
  });

  // A send in flight is not rewritten mid-request; its own answer decides what happened.
  it("leaves a send in flight alone", () => {
    const sending: SendStatus = { state: "sending" };

    expect(
      currentSendStatus({
        received: received(ONE_HOUR),
        attempted: sending,
        now: CLOSED,
      }),
    ).toEqual(sending);
  });

  // A grant with no stated window is offered however long the page has been open (FR-025).
  it("keeps offering a send for a grant that stated no window", () => {
    const status = currentSendStatus({
      received: received(),
      now: RECEIVED_AT + 86_400_000 * 365,
    });

    expect(status.state).toBe("idle");
    expect(canSend(status)).toBe(true);
  });
});

describe("what an expired window issues", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * The whole of FR-025's first half, as a count. Not one request: no Task read to find out
   * whether the send would have worked, and no POST to let the destination decide.
   */
  it("issues no request whatsoever", async () => {
    const status = await sendDirect({
      response: ANSWERS,
      received: received(ONE_HOUR),
      requestIdentifier: "urn:uuid:request-1",
      serverTaskUrl: `https://${HOST}/fhir/Task/task-1`,
      now: RECEIVED_AT + ONE_HOUR * 1000 + 1,
    });

    expect(status.state).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The same for a window that closed while the form was being filled in.
  it("issues no request when the window closed during the filling", async () => {
    const status = await sendDirect({
      response: ANSWERS,
      received: received(60),
      requestIdentifier: "urn:uuid:request-1",
      now: RECEIVED_AT + 240_000,
    });

    expect(status.state).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what the filler is shown once the window has closed", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /**
   * Render the panel in whatever state the window has left it in.
   * @param status where the send is up to
   * @returns the container it was rendered into
   */
  function render(status: SendStatus): HTMLElement {
    act(() => {
      root.render(
        createElement(DirectSendPanel, { host: HOST, status, onSend: vi.fn() }),
      );
    });
    return container;
  }

  const expired = currentSendStatus({
    received: received(ONE_HOUR),
    now: RECEIVED_AT + ONE_HOUR * 1000 + 1,
  });

  // No affordance at all: not a disabled button, not a "try anyway".
  it("offers no send affordance", () => {
    expect(render(expired).querySelectorAll("button")).toHaveLength(0);
  });

  // ...and says why, in terms of the window rather than of an error.
  it("says the window has closed, naming the destination", () => {
    const text = render(expired).textContent ?? "";

    expect(text).toContain(HOST);
    expect(text).toMatch(/closed/i);
    expect(text).not.toMatch(/error|failed|refused/i);
  });

  // A closed window with nowhere to go is not honest, it is a dead end. So it points at the way out.
  it("points at the scan-back return", () => {
    expect(render(expired).textContent).toMatch(/returned as a link/i);
  });

  /*
   * The signal the surrounding surface acts on. `expired` and `refused` are the two states where
   * the direct channel is shut for good and nothing was delivered, so they are the two that make
   * the scan-back return the primary action. A retryable failure does not: its primary action is
   * the retry.
   */
  it("promotes the scan-back return, and only from a channel that is shut with nothing delivered", () => {
    const promoted: Record<SendState, boolean> = {
      idle: false,
      // Nothing is known yet, so nothing is promoted: the check must not rearrange the surface.
      checking: false,
      sending: false,
      sent: false,
      failed: false,
      expired: true,
      refused: true,
    };

    for (const [state, expected] of Object.entries(promoted)) {
      expect(promotesScanBack({ state: state as SendState })).toBe(expected);
    }
  });

  // An expired window has delivered nothing, so every other channel stays open.
  it("suppresses no other channel", () => {
    expect(suppressesOtherChannels(expired)).toBe(false);
  });
});

describe("the window closing while the page is open", () => {
  let container: HTMLElement;
  let root: Root;
  let fetchMock: Mock<typeof fetch>;
  /** The status the probe last saw, so the test can assert on it without a render tree. */
  let observed: SendStatus | undefined;

  /**
   * A probe that does nothing but expose what {@link useDirectSend} currently reports.
   * @param props the component props
   * @param props.sendTo the target whose window is being watched
   * @returns nothing; the status is recorded for the test to assert on
   */
  function Probe(props: { readonly sendTo: DirectSendTarget }): null {
    observed = useDirectSend(props.sendTo).status;
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    observed = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /*
   * The behaviour a render-time derivation cannot provide. Nothing happens on this page between
   * the grant arriving and the window closing - no click, no navigation, no query - so if the
   * transition is not scheduled it never happens, and a live send button sits there over a dead
   * grant.
   */
  it("turns a live send into a closed window with no interaction at all", () => {
    act(() => {
      root.render(createElement(Probe, { sendTo: unpublished(received(60)) }));
    });

    expect(observed?.state).toBe("idle");

    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    expect(observed?.state).toBe("expired");
    expect(observed?.detail).toMatch(/closed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Before the window closes, nothing changes: the transition is scheduled, not polled.
  it("leaves the send offered until the stated lifetime has actually elapsed", () => {
    act(() => {
      root.render(createElement(Probe, { sendTo: unpublished(received(60)) }));
    });

    act(() => {
      vi.advanceTimersByTime(59_000);
    });

    expect(observed?.state).toBe("idle");
  });

  // A grant that stated no lifetime schedules nothing, and stays offered.
  it("schedules no closing for a grant that stated no lifetime", () => {
    act(() => {
      root.render(createElement(Probe, { sendTo: unpublished(received()) }));
    });

    act(() => {
      vi.advanceTimersByTime(86_400_000);
    });

    expect(observed?.state).toBe("idle");
  });

  /*
   * A grant that had already expired when the link was opened is closed on the first render. This
   * one keeps its published Task deliberately: a closed window reads nothing either, so the fetch
   * count covers the prior-submission check as well as the send (FR-025).
   */
  it("reports a window that had already closed before the page loaded", () => {
    act(() => {
      root.render(
        createElement(Probe, {
          sendTo: target(received(60, RECEIVED_AT - 120_000)),
        }),
      );
    });

    expect(observed?.state).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
