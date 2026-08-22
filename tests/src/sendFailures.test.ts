// @vitest-environment jsdom
/**
 * What the filler is told when a send does not land, and what is left to do about it.
 *
 * FR-026 draws one line through the middle of every failure: a refusal is the end of this
 * channel, and everything else is worth another go. The difference is not cosmetic. A 401 or a
 * 403 says the credential the link carried will not be honoured, and no amount of retrying
 * changes a credential - offering a retry there would be inviting someone to keep pressing a
 * button that cannot work. A dropped connection says nothing about the credential at all.
 *
 * The second line is the one that matters most, and it is negative: **no failure path may read as
 * a delivery**. This is easy to get wrong by accident, because "sent" is a word that appears in
 * both "the answers were sent" and "the answers have not been sent", so the assertions here are
 * on what a person would take away from the rendered surface, not on substrings of a state name.
 *
 * The third is that the answers survive. Nothing here is worth anything if a refusal loses four
 * minutes of typing, so every failure state leaves the form mounted and the scan-back return
 * available.
 *
 * Rendering rather than asserting on the status object is deliberate in the refusal and failure
 * cases: a state machine that classifies perfectly while the panel shows a green tick would pass
 * every test that stopped at the classification.
 * @author John Grimes
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendStatus } from "@/fill/directSend";
import type { ReceivedGrant } from "@/link/apiAccess";
import type { QuestionnaireResponse } from "fhir/r4";
import type { Root } from "react-dom/client";
import type { Mock } from "vitest";

import {
  canSend,
  promotesScanBack,
  sendDirect,
  suppressesOtherChannels,
} from "@/fill/directSend";
import DirectSendPanel from "@/fill/DirectSendPanel";

const HOST = "ehr.example.org";
const AUD = `https://${HOST}/fhir`;
const RECEIVED_AT = 1_700_000_000_000;

/** A live grant: every failure below is the destination's doing, not the clock's. */
const RECEIVED: ReceivedGrant = {
  grant: {
    access_token: "opaque-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    aud: AUD,
    patient: "pt-demo",
  },
  receivedAt: RECEIVED_AT,
};

const ANSWERS: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "completed",
  questionnaire: "http://example.org/Questionnaire/q|1.0.0",
  authored: "2026-08-22T01:02:03.000Z",
};

let fetchMock: Mock<typeof fetch>;

/**
 * Attempt a send against whatever the fetch mock is currently answering with.
 * @param received the grant to send under; defaults to the live one
 * @returns the state the send ended in
 */
async function send(received = RECEIVED): Promise<SendStatus> {
  return sendDirect({
    response: ANSWERS,
    received,
    requestIdentifier: "urn:uuid:request-1",
    now: RECEIVED_AT + 60_000,
  });
}

/** One way a send can fail, and the state it ended in. */
interface Failure {
  /** How the failure is named in the assertion, so a regression says which case broke. */
  readonly label: string;
  /** What the send reported. */
  readonly status: SendStatus;
}

/**
 * Every way a send can fail, as the states they actually produce.
 *
 * Produced by running real sends against a mocked destination rather than by writing the states
 * out: a hand-written list of `SendStatus` values would keep passing after the classification
 * that produces them changed.
 * @returns each failure's label and the state the send ended in
 */
async function everyFailure(): Promise<Failure[]> {
  fetchMock.mockResolvedValue(new Response("", { status: 401 }));
  const refusedUnauthorised = await send();

  fetchMock.mockResolvedValue(new Response("", { status: 403 }));
  const refusedForbidden = await send();

  fetchMock.mockResolvedValue(
    new Response("", { status: 500, statusText: "Internal Server Error" }),
  );
  const serverError = await send();

  fetchMock.mockResolvedValue(
    new Response("", {
      status: 307,
      headers: { Location: "https://elsewhere.example.org/fhir" },
    }),
  );
  const redirected = await send();

  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  const unreachable = await send();

  const notHttps = await send({
    ...RECEIVED,
    grant: { ...RECEIVED.grant, aud: "http://ehr.example.org/fhir" },
  });

  const expired = await sendDirect({
    response: ANSWERS,
    received: RECEIVED,
    requestIdentifier: "urn:uuid:request-1",
    now: RECEIVED_AT + 3601 * 1000,
  });

  return [
    { label: "401", status: refusedUnauthorised },
    { label: "403", status: refusedForbidden },
    { label: "500", status: serverError },
    { label: "redirect", status: redirected },
    { label: "network", status: unreachable },
    { label: "not https", status: notHttps },
    { label: "expired", status: expired },
  ];
}

describe("when the destination refuses the link's credential", () => {
  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * Both statuses mean the same thing to a filler holding a link: this token is not going to be
   * accepted. 401 is "not authenticated", 403 is "not permitted", and neither is a distinction a
   * patient can act on, so both close the channel.
   */
  it("closes the channel for a 401 and for a 403 alike", async () => {
    for (const httpStatus of [401, 403]) {
      fetchMock.mockResolvedValue(new Response("", { status: httpStatus }));

      const status = await send();

      expect(status.state).toBe("refused");
      expect(canSend(status)).toBe(false);
    }
  });

  // The answers are still on the device, so nothing else may be closed off (FR-026).
  it("keeps the answers and every other way back", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));

    const status = await send();

    expect(suppressesOtherChannels(status)).toBe(false);
    expect(promotesScanBack(status)).toBe(true);
  });

  /*
   * A refusal after a refusal is the same refusal. The channel is closed, so a second attempt is
   * not offered - and the state machine, not the button's absence, is what has to say so.
   */
  it("offers no second attempt", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));

    await send();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(canSend({ state: "refused" })).toBe(false);
  });
});

describe("when the send fails for some other reason", () => {
  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A network that never reached the destination says nothing about the credential.
  it("keeps the send available after an unreachable destination", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const status = await send();

    expect(status.state).toBe("failed");
    expect(canSend(status)).toBe(true);
    expect(suppressesOtherChannels(status)).toBe(false);
  });

  // Nor does a server error: the token was accepted, the write was not completed.
  it("keeps the send available after a server error", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );

    const status = await send();

    expect(status.state).toBe("failed");
    expect(canSend(status)).toBe(true);
  });

  /*
   * A retryable failure does not promote the fallback. Its primary action is the retry, and
   * pushing someone towards a QR code they do not need would be worse advice than saying nothing.
   */
  it("leaves the retry as the primary action rather than promoting the fallback", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(promotesScanBack(await send())).toBe(false);
  });
});

describe("what no failure may claim", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  /**
   * Render a send state and hand back what a person would read.
   * @param status the state the send ended in
   * @returns the rendered text
   */
  function shown(status: SendStatus): string {
    act(() => {
      root.render(
        createElement(DirectSendPanel, { host: HOST, status, onSend: vi.fn() }),
      );
    });
    return container.textContent ?? "";
  }

  /*
   * The property, over every failure there is. `sent` is the only state that may claim the
   * destination has the answers, and none of these is it - measured on the rendered surface,
   * because that is where the claim would be made. Collected into one object and compared in one
   * assertion so a regression names the case that broke rather than the loop iteration.
   */
  it("never presents a delivered or accepted state", async () => {
    const claims: Record<string, string[]> = {};
    for (const { label, status } of await everyFailure()) {
      const text = shown(status);
      claims[label] = [
        status.state === "sent" ? "state is sent" : "",
        /\baccepted\b/i.test(text) ? "says accepted" : "",
        /\bdelivered\b/i.test(text) ? "says delivered" : "",
        /\bsaved\b/i.test(text) ? "says saved" : "",
      ].filter((claim) => claim !== "");
    }

    expect(claims).toEqual({
      "401": [],
      "403": [],
      "500": [],
      redirect: [],
      network: [],
      "not https": [],
      expired: [],
    });
  });

  // ...and every one of them says what is now true of the answers.
  it("says the answers have not been sent", async () => {
    const said: Record<string, boolean> = {};
    for (const { label, status } of await everyFailure()) {
      said[label] = /not been sent|not accepted|closed/i.test(shown(status));
    }

    expect(said).toEqual({
      "401": true,
      "403": true,
      "500": true,
      redirect: true,
      network: true,
      "not https": true,
      expired: true,
    });
  });

  /*
   * The refusal's copy, in full. "Would not authorise" is the plain-language form of a 401: it
   * names what was refused (this link's authority) and what follows from it (nothing was
   * stored), without asking a patient to know what a bearer token is.
   */
  it("explains a refusal in plain language, and offers the way back", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));

    const text = shown(await send());

    expect(text).toContain(HOST);
    expect(text).toMatch(/would not authorise/i);
    expect(text).toMatch(/nothing was stored/i);
    expect(text).toMatch(/returned as a link/i);
    // No retry: the credential is the problem, and pressing again will not change it.
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  // The failure's copy, in full: unreachable, unsent, still here, and one button to try again.
  it("explains a failure in plain language, and offers a retry", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const text = shown(await send());

    expect(text).toContain(HOST);
    expect(text).toMatch(/could not be reached/i);
    expect(text).toMatch(/still here/i);
    expect(
      [...container.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual([expect.stringMatching(/try again/i)]);
  });

  /*
   * The one thing a successful send may claim, and the two it may not. Acceptance is a statement
   * about the transaction, not about the request task's state - the clinic may have cancelled or
   * completed that task already, and the transaction deliberately leaves such a task alone (spec
   * edge case). Claiming otherwise would tell a patient their request is closed when it is not.
   */
  it("claims only acceptance when the send succeeds, never that anything was read or completed", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const status = await send();
    expect(status.state).toBe("sent");

    const text = shown(status);
    expect(text).toMatch(/accepted/i);
    expect(text).not.toMatch(/\bcompleted\b/i);
    expect(text).not.toMatch(/\bread\b/i);
  });
});
