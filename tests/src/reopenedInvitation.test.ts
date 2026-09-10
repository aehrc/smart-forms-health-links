// @vitest-environment jsdom
/**
 * Reopening an invitation whose answers are already in the record.
 *
 * The spec's edge case is one sentence - "the same invitation opened after the response was
 * already sent: the filler shows the terminal sent state, not a fresh form" - and it exists
 * because the alternative is actively misleading. A reopened link that renders the whole form
 * again with a live send button invites someone to type their answers a second time and be told
 * they were accepted, when the conditional create means the second transaction changed nothing
 * but a duplicate Provenance.
 *
 * ## The evidence, and why `status` alone is not it
 *
 * The only thing a filler can ask the destination is: what does the published Task say? A
 * `completed` Task is not sufficient evidence on its own, because the enumerated edge case
 * "the published request task was cancelled or completed by the clinic before the send" describes
 * exactly that Task arising with nothing ever sent. The distinguishing fact is the
 * `questionnaire-response` output: this app's submission transaction is the only thing that
 * writes `completed` *together with* that output ({@link buildSubmissionTransaction}), and a
 * clinic closing a request off in its own system leaves no such reference. So the test matrix
 * below pairs each status with the presence and absence of the output.
 *
 * A cancelled Task never reads as sent, whatever outputs it carries. Cancellation is not a state
 * a send produces, and treating it as one would hide the form from a filler who had sent nothing.
 *
 * ## Failing open, and failing silent
 *
 * Unknown means "offer the send". An unreadable Task - 500, 404, a dropped connection, something
 * that is not a Task - is not evidence of a prior submission, and refusing to let someone send
 * because a status read failed would lose the answers over a nicety. The one case that issues no
 * request at all is a closed window: FR-025 is a statement about requests, so the assertions
 * there are on the fetch spy's call count.
 * @author John Grimes
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectSendTarget, SendStatus } from "@/fill/directSend";
import type { ReceivedGrant } from "@/link/apiAccess";
import type { Task, TaskOutput } from "fhir/r4";
import type { Root } from "react-dom/client";
import type { Mock } from "vitest";

import {
  canSend,
  promotesScanBack,
  readDestinationTask,
  readPriorSubmission,
  suppressesOtherChannels,
} from "@/fill/directSend";
import DirectSendPanel from "@/fill/DirectSendPanel";
import { useDirectSend } from "@/fill/useDirectSend";

const HOST = "ehr.example.org";

/** The grant's destination, and the only origin its token may be presented to. */
const AUD = `https://${HOST}/fhir`;

/** The published Task the invitation names, on the destination's own origin. */
const TASK_URL = `${AUD}/Task/task-1`;

/** One hour, in the grant's own units. */
const ONE_HOUR = 3600;

/** The output a send leaves behind: the answers, named on the Task it completed. */
const RESPONSE_OUTPUT: TaskOutput = {
  type: { text: "questionnaire-response" },
  valueReference: { reference: "QuestionnaireResponse/qr-1" },
};

/**
 * A grant that arrived just now and has most of its hour left.
 * @returns the received grant
 */
function liveGrant(): ReceivedGrant {
  return {
    grant: {
      access_token: "opaque-access-token",
      token_type: "Bearer",
      expires_in: ONE_HOUR,
      aud: AUD,
      patient: "pt-demo",
    },
    receivedAt: Date.now(),
  };
}

/**
 * A grant whose stated window closed an hour ago.
 * @returns the received grant
 */
function closedGrant(): ReceivedGrant {
  return {
    ...liveGrant(),
    receivedAt: Date.now() - (ONE_HOUR + ONE_HOUR) * 1000,
  };
}

/**
 * The published Task as the destination holds it.
 * @param status the Task's status
 * @param output its outputs, when it carries any
 * @returns the Task
 */
function publishedTask(status: Task["status"], output?: TaskOutput[]): Task {
  return {
    resourceType: "Task",
    id: "task-1",
    meta: { versionId: "3" },
    status,
    intent: "order",
    ...(output ? { output } : {}),
  };
}

/**
 * A FHIR JSON response, as the destination would answer a Task read.
 * @param body the resource
 * @param init status and headers
 * @returns the response
 */
function fhirResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    status: 200,
    ...init,
    headers: {
      "Content-Type": "application/fhir+json",
      ETag: 'W/"3"',
      ...init.headers,
    },
  });
}

/**
 * A target as an opened invitation would produce one.
 * @param options the grant, and the published Task URL when the invitation named one
 * @param options.received the grant and the moment it arrived
 * @param options.serverTaskUrl the published Task URL, explicitly undefined for none
 * @returns everything a send needs
 */
function target(
  options: {
    received?: ReceivedGrant;
    serverTaskUrl?: string | undefined;
  } = {},
): DirectSendTarget {
  return {
    received: options.received ?? liveGrant(),
    host: HOST,
    requestIdentifier: "urn:uuid:request-1",
    serverTaskUrl:
      "serverTaskUrl" in options ? options.serverTaskUrl : TASK_URL,
    patientDisplay: "Jane Citizen",
  };
}

/**
 * Ask whether this invitation's answers are already there.
 * @param options the grant and the published Task URL to ask about
 * @param options.received the grant and the moment it arrived
 * @param options.serverTaskUrl the published Task URL to read
 * @returns true when the Task shows a prior submission
 */
async function priorSubmission(
  options: { received?: ReceivedGrant; serverTaskUrl?: string } = {},
): Promise<boolean> {
  return readPriorSubmission({
    received: options.received ?? liveGrant(),
    serverTaskUrl: options.serverTaskUrl ?? TASK_URL,
  });
}

describe("reading whether the destination already holds these answers", () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * The positive case, and the only one there is: the Task this app's own transaction completed,
   * naming the answers it stored.
   */
  it("reads a completed Task naming the answers as a prior submission", async () => {
    fetchMock.mockResolvedValue(
      fhirResponse(publishedTask("completed", [RESPONSE_OUTPUT])),
    );

    expect(await priorSubmission()).toBe(true);

    // Read with the grant's own credential, and only from the grant's own origin.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TASK_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer opaque-access-token",
    );
  });

  /*
   * The published Task is read twice in one page - once here, when the link is opened, and once
   * immediately before a send - and Aidbox answers a conditional `GET` with a 500 while still
   * sending a strong `ETag`. Left cacheable, the first read would make the second one a
   * revalidation the destination cannot answer, the Task entry would be dropped, and requests
   * would silently stop reading as completed on `/requests`.
   */
  it("reads without letting the browser cache or revalidate", async () => {
    fetchMock.mockResolvedValue(fhirResponse(publishedTask("requested")));

    await priorSubmission();
    await readDestinationTask({
      grant: liveGrant().grant,
      serverTaskUrl: TASK_URL,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.cache).toBe("no-store");
    }
  });

  /*
   * The distinction the whole check turns on. A clinic that closed the request off in its own
   * system leaves a completed Task with no answers attached, and a filler holding that link has
   * still sent nothing - so the send stays on offer (spec edge case: the task completed by the
   * clinic before the send).
   */
  it("does not read a Task the clinic completed without answers as a prior submission", async () => {
    fetchMock.mockResolvedValue(fhirResponse(publishedTask("completed")));

    expect(await priorSubmission()).toBe(false);
  });

  // An output slot of some other kind is not the answers either.
  it("does not read an unrelated output as the answers", async () => {
    fetchMock.mockResolvedValue(
      fhirResponse(
        publishedTask("completed", [
          { type: { text: "note" }, valueString: "spoke to the patient" },
        ]),
      ),
    );

    expect(await priorSubmission()).toBe(false);
  });

  // ...nor is a response slot with nothing in it.
  it("does not read an empty answers slot as the answers", async () => {
    fetchMock.mockResolvedValue(
      fhirResponse(
        publishedTask("completed", [
          { type: { text: "questionnaire-response" } },
        ]),
      ),
    );

    expect(await priorSubmission()).toBe(false);
  });

  /*
   * Cancellation is not something a send produces, so it is never evidence of one - even in the
   * pathological case where the Task carries a response output from somewhere else. Reading it
   * as sent would hide the form from a filler who had sent nothing at all.
   */
  it("never reads a Task finished any other way as a prior submission", async () => {
    for (const status of [
      "cancelled",
      "rejected",
      "failed",
      "entered-in-error",
    ] as const) {
      fetchMock.mockResolvedValue(
        fhirResponse(publishedTask(status, [RESPONSE_OUTPUT])),
      );

      expect(await priorSubmission()).toBe(false);
    }
  });

  // An open request is the ordinary case: nothing has been sent.
  it("does not read an open Task as a prior submission", async () => {
    for (const status of ["draft", "requested", "in-progress"] as const) {
      fetchMock.mockResolvedValue(fhirResponse(publishedTask(status)));

      expect(await priorSubmission()).toBe(false);
    }
  });

  /*
   * Failing open. The destination has been observed answering this read with a 500, and a status
   * read that did not work is not a reason to withhold a send.
   */
  it("treats an unreadable Task as no evidence at all", async () => {
    for (const status of [500, 404, 401, 403] as const) {
      fetchMock.mockResolvedValue(
        fhirResponse({ resourceType: "OperationOutcome" }, { status }),
      );

      expect(await priorSubmission()).toBe(false);
    }
  });

  // The same for a connection that never got there.
  it("treats an unreachable destination as no evidence at all", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await priorSubmission()).toBe(false);
  });

  // ...and for an answer that is not a Task, or not JSON.
  it("treats an answer that is not a Task as no evidence at all", async () => {
    fetchMock.mockResolvedValue(
      fhirResponse({ resourceType: "Patient", id: "pt-demo" }),
    );
    expect(await priorSubmission()).toBe(false);

    fetchMock.mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/fhir+json" },
      }),
    );
    expect(await priorSubmission()).toBe(false);
  });

  /*
   * The origin rule applies to this read exactly as it applies to the pre-send one: the token is
   * presented to the destination or to nowhere.
   */
  it("presents the token to no origin but the destination's", async () => {
    expect(
      await priorSubmission({
        serverTaskUrl: "https://elsewhere.example.org/fhir/Task/task-1",
      }),
    ).toBe(false);
    expect(
      await priorSubmission({
        serverTaskUrl: "http://ehr.example.org/fhir/Task/task-1",
      }),
    ).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * FR-025's guarantee, as a count. A closed window issues nothing whatsoever - not even a read
   * to find out what the Task says.
   */
  it("issues no request at all once the grant's window has closed", async () => {
    expect(await priorSubmission({ received: closedGrant() })).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what a reopened invitation shows the filler", () => {
  let container: HTMLElement;
  let root: Root;
  let fetchMock: Mock<typeof fetch>;
  /** The status the probe last saw, so the test can assert on it without a render tree. */
  let observed: SendStatus | undefined;

  /**
   * A probe that does nothing but expose what {@link useDirectSend} currently reports.
   * @param props the component props
   * @param props.sendTo the target the invitation offers
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
  });

  /**
   * Open the invitation, letting the check settle.
   * @param sendTo the target the invitation offers
   * @returns nothing; {@link observed} carries the resulting status
   */
  async function open(sendTo: DirectSendTarget = target()): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, { sendTo }));
      // Inside the same act, so the Task read has settled by the time the status is read.
      await Promise.resolve();
    });
  }

  /*
   * The gap this closes. The check is a network round trip, so there is a moment before the
   * answer arrives - and showing a live "send answers" button in that moment, then taking it
   * away, is worse than showing nothing: someone reaches for it. So the affordance is withheld
   * and the state says why (Nielsen heuristic 1).
   */
  it("withholds the send affordance until the check resolves", async () => {
    let arrive: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        arrive = resolve;
      }),
    );

    await open();

    expect(observed?.state).toBe("checking");
    expect(canSend(observed as SendStatus)).toBe(false);
    // The form and the scan-back return keep rendering throughout: a slow check blocks nothing.
    expect(suppressesOtherChannels(observed as SendStatus)).toBe(false);
    expect(promotesScanBack(observed as SendStatus)).toBe(false);

    await act(async () => {
      arrive?.(fhirResponse(publishedTask("completed", [RESPONSE_OUTPUT])));
      await Promise.resolve();
    });

    expect(observed?.state).toBe("sent");
  });

  /*
   * The edge case itself. The answers are in the record at the destination, so the invitation
   * shows what a completed send shows - and {@link suppressesOtherChannels} is what takes the
   * form away rather than leaving a second copy of it to be typed.
   */
  it("shows the terminal accepted state for answers already in the record", async () => {
    fetchMock.mockResolvedValue(
      fhirResponse(publishedTask("completed", [RESPONSE_OUTPUT])),
    );

    await open();

    expect(observed?.state).toBe("sent");
    expect(observed?.detail).toMatch(/already/i);
    expect(observed?.detail).toContain(HOST);
    expect(canSend(observed as SendStatus)).toBe(false);
    expect(suppressesOtherChannels(observed as SendStatus)).toBe(true);
  });

  // Failing open, through the hook: an unreadable Task leaves the send on offer.
  it("offers the send when the Task cannot be read", async () => {
    for (const status of [500, 404] as const) {
      fetchMock.mockResolvedValue(
        fhirResponse({ resourceType: "OperationOutcome" }, { status }),
      );

      await open();

      expect(observed?.state).toBe("idle");
      expect(canSend(observed as SendStatus)).toBe(true);
    }
  });

  // ...as does a Task the clinic completed itself, with no answers attached.
  it("offers the send when the Task was completed without answers", async () => {
    fetchMock.mockResolvedValue(fhirResponse(publishedTask("completed")));

    await open();

    expect(observed?.state).toBe("idle");
    expect(canSend(observed as SendStatus)).toBe(true);
  });

  // ...and a cancelled one, which is the clinic's decision and not a delivery.
  it("offers the send when the clinic cancelled the request", async () => {
    fetchMock.mockResolvedValue(fhirResponse(publishedTask("cancelled")));

    await open();

    expect(observed?.state).toBe("idle");
    expect(canSend(observed as SendStatus)).toBe(true);
  });

  /*
   * An invitation that named no published Task has nothing to ask about, so it asks nothing and
   * offers the send immediately - no "checking" state to sit through.
   */
  it("checks nothing when the invitation named no published Task", async () => {
    await open(target({ serverTaskUrl: undefined }));

    expect(observed?.state).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * FR-025 again, at the surface this time: a closed window issues no request, and what it shows
   * is the closed window rather than a check it never made.
   */
  it("issues no request when the window closed before the link was reopened", async () => {
    await open(target({ received: closedGrant() }));

    expect(observed?.state).toBe("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * The check is identified by the token and the Task, not by the object the caller allocated
   * this render. `directSendTarget` builds a fresh one every render, so a check keyed on object
   * identity would re-read the Task on every state change the page makes.
   */
  it("checks once, however often the caller re-renders", async () => {
    fetchMock.mockResolvedValue(fhirResponse(publishedTask("requested")));
    const received = liveGrant();

    await open(target({ received }));
    await open(target({ received }));
    await open(target({ received }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the panel while the check is in flight", () => {
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
   * Render the panel in the checking state.
   * @returns the container it was rendered into
   */
  function render(): HTMLElement {
    act(() => {
      root.render(
        createElement(DirectSendPanel, {
          host: HOST,
          status: { state: "checking" },
          onSend: vi.fn(),
        }),
      );
    });
    return container;
  }

  // No affordance at all while the answer is unknown: not a disabled button, not a live one.
  it("offers no send affordance", () => {
    expect(render().querySelectorAll("button")).toHaveLength(0);
  });

  /*
   * ...and says what it is doing, rather than showing a blank space. The one thing it must not
   * do is claim an outcome it has not got.
   */
  it("says it is checking, naming the destination, and claims nothing", () => {
    const text = render().textContent ?? "";

    expect(text).toMatch(/checking/i);
    expect(text).toContain(HOST);
    expect(text).not.toMatch(/accepted|sent to|closed|error/i);
  });
});
