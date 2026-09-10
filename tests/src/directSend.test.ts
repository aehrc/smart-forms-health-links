/**
 * Send execution: where the token goes, and what the filler is told afterwards.
 *
 * Two rules carry the weight here, and both are about honesty rather than mechanics.
 *
 * **The token goes to one place.** `contracts/shl-wire.md`: "The Bearer token is presented only
 * to `aud`'s origin; any redirect elsewhere aborts." A followed redirect would hand a
 * write-capable credential to whoever controls the redirect target, and the filler would be told
 * the answers had been delivered. So redirects are not followed - `redirect: "manual"` - and a
 * redirected response is a failure with no delivery claimed. The tests below stub a redirecting
 * destination for exactly this.
 *
 * **The terminal state says only what happened.** A 2xx means the destination accepted the
 * transaction. It does not mean a clinician has seen the answers, and there is nothing to poll
 * that would say otherwise, so the copy claims acceptance and stops (FR-026, US3 scenario 6).
 * `refused` (401/403) closes this channel and is never dressed as delivery; `failed` retains the
 * answers and offers a retry.
 * @author John Grimes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DirectSendOptions,
  SendState,
  SendStatus,
} from "@/fill/directSend";
import type { ApiAccessGrant, ReceivedGrant } from "@/link/apiAccess";
import type { Bundle, QuestionnaireResponse } from "fhir/r4";
import type { Mock } from "vitest";

import {
  canSend,
  currentSendStatus,
  sendDirect,
  suppressesOtherChannels,
} from "@/fill/directSend";

const AUD = "https://ehr.example.org/fhir";

const GRANT: ApiAccessGrant = {
  access_token: "opaque-access-token",
  token_type: "Bearer",
  expires_in: 3600,
  aud: AUD,
  patient: "pt-demo",
};

/** The moment the manifest was read. Every window below is measured from here. */
const RECEIVED_AT = 1_700_000_000_000;

const RECEIVED: ReceivedGrant = { grant: GRANT, receivedAt: RECEIVED_AT };

const ANSWERS: QuestionnaireResponse = {
  resourceType: "QuestionnaireResponse",
  status: "in-progress",
  questionnaire: "http://example.org/Questionnaire/sepsis|1.2.0",
  item: [{ linkId: "temperature", answer: [{ valueDecimal: 38.4 }] }],
};

const REQUEST_IDENTIFIER = "urn:uuid:8f1c9d2e-0000-4000-8000-abcdefabcdef";

/** The stubbed destination. Hoisted so the helpers below need no closure over a describe. */
let fetchMock: Mock<typeof fetch>;

/**
 * Send with the well-formed arguments, differing in whatever the test is about.
 * @param overrides options to differ
 * @returns the state the send ended in
 */
async function send(
  overrides: Partial<DirectSendOptions> = {},
): Promise<SendStatus> {
  return sendDirect({
    response: ANSWERS,
    received: RECEIVED,
    requestIdentifier: REQUEST_IDENTIFIER,
    now: RECEIVED_AT + 60_000,
    ...overrides,
  });
}

/**
 * The transaction body of one of the stubbed calls.
 *
 * `RequestInit.body` is a `BodyInit`, so the string check is a real one rather than a cast: a
 * `Blob` here would mean the sender had stopped serialising JSON.
 * @param index which call to read
 * @returns the parsed Bundle
 * @throws {Error} when that call carried no serialised body
 */
function bodyOf(index: number): Bundle {
  const body = fetchMock.mock.calls[index][1]?.body;
  if (typeof body !== "string") {
    throw new TypeError(`Call ${index} carried no serialised body.`);
  }
  return JSON.parse(body) as Bundle;
}

/**
 * Answer the Task pre-read with a readable Task, then the transaction with acceptance.
 * @param taskStatus the status the destination holds the Task in
 */
function stubTaskThenAccept(taskStatus = "requested"): void {
  fetchMock.mockImplementation((_input, init) =>
    Promise.resolve(
      (init?.method ?? "GET") === "GET"
        ? Response.json(
            {
              resourceType: "Task",
              id: "task-1",
              status: taskStatus,
              intent: "order",
            },
            { status: 200, headers: { ETag: 'W/"3"' } },
          )
        : Response.json({}, { status: 200 }),
    ),
  );
}

describe("the direct send", () => {
  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("where the token is presented", () => {
    // The destination, the token, the content type, and nothing followed anywhere.
    it("posts the transaction to the grant's aud, authorised by its token", async () => {
      fetchMock.mockResolvedValue(
        Response.json({ resourceType: "Bundle" }, { status: 200 }),
      );

      const status = await send();

      expect(status.state).toBe("sent");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(AUD);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");

      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer opaque-access-token");
      expect(headers.get("Content-Type")).toBe("application/fhir+json");

      const bundle = bodyOf(0);
      expect(bundle.type).toBe("transaction");
      expect(bundle.entry?.[0]?.request?.ifNoneExist).toBe(
        `identifier=urn:ietf:rfc:3986|${REQUEST_IDENTIFIER}`,
      );
    });

    /*
     * A redirect is the destination telling the browser to present the request somewhere else.
     * The token is not carried there, the send is abandoned, and - the part that matters - the
     * filler is not told the answers arrived.
     */
    it("aborts, claiming no delivery, when the destination redirects", async () => {
      fetchMock.mockResolvedValue(
        new Response("", {
          status: 307,
          headers: { Location: "https://elsewhere.example.org/fhir" },
        }),
      );

      const status = await send();

      expect(status.state).toBe("failed");
      expect(status.detail).toMatch(/not been sent|have not been sent/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // In a browser, a cross-origin redirect under `redirect: "manual"` arrives opaque.
    it("aborts on an opaque redirect, which is what a browser actually hands back", async () => {
      fetchMock.mockResolvedValue(Response.redirect(AUD, 302));

      const status = await send();

      expect(status.state).toBe("failed");
    });

    // FR-024: the destination must be an https address. Nothing is presented to anything else.
    it("presents nothing at all when the destination is not https", async () => {
      const status = await send({
        received: {
          grant: { ...GRANT, aud: "http://ehr.example.org/fhir" },
          receivedAt: RECEIVED_AT,
        },
      });

      expect(status.state).toBe("failed");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    /*
     * The Task pre-read is the one other place the token is presented, and it is skipped when
     * the published Task is not on the grant's origin - so a send with an off-origin Task URL
     * makes exactly one request, to the destination.
     */
    it("issues exactly one request when the published task is on another origin", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      const status = await send({
        serverTaskUrl: "https://elsewhere.example.org/fhir/Task/task-1",
      });

      expect(status.state).toBe("sent");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(AUD);
    });
  });

  describe("the state machine", () => {
    // A live grant is offered. Nothing happens until someone asks for it.
    it("starts idle for a grant whose window is open", () => {
      expect(
        currentSendStatus({ received: RECEIVED, now: RECEIVED_AT + 60_000 }),
      ).toEqual({ state: "idle" });
    });

    // `expired` replaces `idle`: the affordance is never offered from a closed window.
    it("starts expired once the grant's stated window has closed", () => {
      const status = currentSendStatus({
        received: RECEIVED,
        now: RECEIVED_AT + 3601 * 1000,
      });

      expect(status.state).toBe("expired");
      expect(status.detail).toContain("ehr.example.org");
    });

    // A grant that stated no window has none to have closed.
    it("starts idle for a grant that stated no window, however long ago it arrived", () => {
      const status = currentSendStatus({
        received: {
          grant: { ...GRANT, expires_in: undefined },
          receivedAt: RECEIVED_AT,
        },
        now: RECEIVED_AT + 400 * 86_400_000,
      });

      expect(status.state).toBe("idle");
    });

    /*
     * Only `idle` and `failed` may start a send. Everything else is terminal, in flight, or - in
     * the case of `checking` - waiting to hear whether the answers are already there, which is
     * precisely a state a send must not be started from.
     */
    it("permits a send only from idle and failed", () => {
      const permitted: Record<SendState, boolean> = {
        idle: true,
        failed: true,
        checking: false,
        expired: false,
        sending: false,
        sent: false,
        refused: false,
      };

      const actual = Object.fromEntries(
        Object.keys(permitted).map((state) => [
          state,
          canSend({ state: state as SendState }),
        ]),
      );

      expect(actual).toEqual(permitted);
    });

    // FR-026: a successful send suppresses all further sends, on every channel.
    it("suppresses every other channel once sent, and only then", () => {
      const states: SendState[] = [
        "idle",
        "checking",
        "expired",
        "sending",
        "sent",
        "refused",
        "failed",
      ];

      const actual = Object.fromEntries(
        states.map((state) => [state, suppressesOtherChannels({ state })]),
      );

      expect(actual).toEqual({
        idle: false,
        // A check in flight has delivered nothing, so the form and the scan-back return stay.
        checking: false,
        expired: false,
        sending: false,
        sent: true,
        refused: false,
        failed: false,
      });
    });

    // No request is ever issued from an expired grant (FR-025).
    it("issues no request from an expired grant", async () => {
      const status = await send({ now: RECEIVED_AT + 3601 * 1000 });

      expect(status.state).toBe("expired");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("what the destination's answer means", () => {
    // 2xx is acceptance. That is all it is, and all the copy claims.
    it("reports acceptance by the destination, and claims nothing more", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      const status = await send();

      expect(status.state).toBe("sent");
      expect(status.detail).toContain("ehr.example.org");
      expect(status.detail).toMatch(/accepted/i);
      expect(status.detail).not.toMatch(/read|reviewed|seen|looked at/i);
    });

    // 201 is equally acceptance: the contract says 2xx, not 200.
    it("treats any 2xx as acceptance", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 201 }));

      const status = await send();

      expect(status.state).toBe("sent");
    });

    // 401/403 close this channel: the credential the link carried will not be honoured.
    it("reports an authorisation refusal as refused, naming no delivery", async () => {
      const outcomes: Record<number, SendStatus> = {};
      for (const httpStatus of [401, 403]) {
        fetchMock.mockResolvedValue(new Response("", { status: httpStatus }));
        outcomes[httpStatus] = await send();
      }

      for (const status of Object.values(outcomes)) {
        expect(status.detail).toContain("ehr.example.org");
        expect(status.detail).not.toMatch(/\bsent\b|delivered|accepted/i);
      }
      expect({
        401: outcomes[401].state,
        403: outcomes[403].state,
      }).toEqual({ 401: "refused", 403: "refused" });
    });

    // Anything else is a failure that may be worth trying again.
    it("reports any other refusal as a retryable failure", async () => {
      fetchMock.mockResolvedValue(
        new Response("", { status: 500, statusText: "Internal Server Error" }),
      );

      const status = await send();

      expect(status.state).toBe("failed");
      expect(canSend(status)).toBe(true);
      expect(status.detail).toContain("500");
    });

    // A network that never reached the destination is the same story, and never a delivery.
    it("reports an unreachable destination as a retryable failure", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

      const status = await send();

      expect(status.state).toBe("failed");
      expect(status.detail).toContain("ehr.example.org");
      expect(status.detail).not.toMatch(/delivered|accepted/i);
    });
  });

  describe("the task leg", () => {
    // The pre-read comes first, and its version guards the completion.
    it("reads the published task before sending, and completes it in the same transaction", async () => {
      stubTaskThenAccept();

      const status = await send({
        serverTaskUrl: "https://ehr.example.org/fhir/Task/task-1",
      });

      expect(status.state).toBe("sent");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(1).entry?.[2]?.request).toEqual({
        method: "PUT",
        url: "Task/task-1",
        ifMatch: 'W/"3"',
      });
    });

    // FR-022: a task the clinic has already finished with is left alone, and the answers still go.
    it("sends the answers without a task entry when the task has already been finished", async () => {
      stubTaskThenAccept("completed");

      const status = await send({
        serverTaskUrl: "https://ehr.example.org/fhir/Task/task-1",
      });

      expect(status.state).toBe("sent");
      expect(
        bodyOf(1).entry?.map((entry) => entry.resource?.resourceType),
      ).toEqual(["QuestionnaireResponse", "Provenance"]);
    });
  });
});
