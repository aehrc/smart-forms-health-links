// @vitest-environment jsdom
/**
 * The filler's disclosure: what a person is told before they send, and after.
 *
 * FR-020 is the requirement under test, and it is a requirement about a *name*. "Your answers
 * will be sent directly to the destination" is not a disclosure - a patient cannot decide
 * anything from it. The host is what makes it a decision, and the host rather than the whole URL
 * because `https://kuzfdswqmz.edge.aidbox.app/fhir` is not something a person reads as a place.
 *
 * The second requirement is negative and just as important: a malformed grant must show no
 * disclosure and block nothing (FR-020). The form still renders, and the scan-back return still
 * works. So the panel renders *nothing* rather than an explanation of a channel that does not
 * exist, and the test asserts its siblings survive.
 *
 * The third is that the send is a single explicit *confirmed* action (FR-021). One click arms it,
 * a second commits it, and the confirmation names the destination again - because the disclosure
 * a person read when the page loaded is not necessarily the one in front of them when they
 * finish typing.
 *
 * Rendering rather than asserting on strings is deliberate here. Every one of these requirements
 * is about what reaches the screen, and a test that checked a copy-producing function could pass
 * while the panel rendered none of it.
 * @author John Grimes
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendStatus } from "@/fill/directSend";
import type { ReceivedGrant } from "@/link/apiAccess";
import type { Task } from "fhir/r4";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { directSendTarget } from "@/fill/directSend";
import DirectSendPanel from "@/fill/DirectSendPanel";

/** The destination named throughout. */
const HOST = "ehr.example.org";

/**
 * React will not run `act` without this flag, and does not publish it on its types.
 *
 * Widened once here, by name, rather than asserted at the point of assignment: it is a global
 * React itself reads, so the only thing being claimed is that `globalThis` may carry it.
 */
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("the filler's direct-send disclosure", () => {
  let container: HTMLElement;
  let root: Root;

  /**
   * Render into a fresh container and hand back its element.
   * @param ui the tree to render
   * @returns the container the tree was rendered into
   */
  function render(ui: ReactNode): HTMLElement {
    act(() => {
      root.render(ui);
    });
    return container;
  }

  /**
   * Click the first button whose text contains a fragment.
   * @param text the fragment to look for, case-insensitively
   * @throws {Error} when no button matches, since a silent no-op would pass every assertion
   */
  function click(text: string): void {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.toLowerCase().includes(text.toLowerCase()),
    );
    if (!button) {
      throw new Error(
        `No button matching "${text}". Buttons present: ` +
          `${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ") || "none"}`,
      );
    }

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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

  describe("before the send", () => {
    // FR-020: the destination is named, and named as a host.
    it("states that answers go straight to the destination, naming its host", () => {
      const text = render(
        <DirectSendPanel
          host={HOST}
          status={{ state: "idle" }}
          onSend={vi.fn()}
        />,
      ).textContent;

      expect(text).toContain(HOST);
      expect(text).toMatch(/directly|straight/i);
    });

    // The host, not the URL. A path and a scheme are noise a patient cannot act on.
    it("names the host rather than the whole destination URL", () => {
      const text =
        render(
          <DirectSendPanel
            host={HOST}
            status={{ state: "idle" }}
            onSend={vi.fn()}
          />,
        ).textContent ?? "";

      expect(text).not.toContain("https://");
      expect(text).not.toContain("/fhir");
    });

    // FR-021: a single explicit action, confirmed. Arming is not sending.
    it("does not send on the first click", () => {
      const onSend = vi.fn();
      render(
        <DirectSendPanel
          host={HOST}
          status={{ state: "idle" }}
          onSend={onSend}
        />,
      );

      click("send");

      expect(onSend).not.toHaveBeenCalled();
    });

    // The confirmation names the destination again, at the moment of the decision.
    it("names the destination again on the confirmation step", () => {
      render(
        <DirectSendPanel
          host={HOST}
          status={{ state: "idle" }}
          onSend={vi.fn()}
        />,
      );

      click("send");

      expect(container.textContent).toContain(HOST);
      expect(container.textContent).toMatch(/confirm/i);
    });

    // ...and confirming sends, exactly once.
    it("sends once when the send is confirmed", () => {
      const onSend = vi.fn();
      render(
        <DirectSendPanel
          host={HOST}
          status={{ state: "idle" }}
          onSend={onSend}
        />,
      );

      click("send");
      click("confirm");

      expect(onSend).toHaveBeenCalledTimes(1);
    });

    // Changing your mind must cost nothing and send nothing.
    it("sends nothing when the confirmation is cancelled", () => {
      const onSend = vi.fn();
      render(
        <DirectSendPanel
          host={HOST}
          status={{ state: "idle" }}
          onSend={onSend}
        />,
      );

      click("send");
      click("cancel");

      expect(onSend).not.toHaveBeenCalled();
      expect(container.textContent).not.toMatch(/confirm/i);
    });
  });

  /*
   * FR-020's negative half. A grant that could not be read is a grant that is not there, and the
   * only correct amount of interface for a channel that does not exist is none. The sibling here
   * stands in for the form and the scan-back return, which must be untouched by the absence.
   */
  describe("with no usable grant", () => {
    it("shows no disclosure at all, and blocks nothing around it", () => {
      const text = render(
        <div>
          <DirectSendPanel host={HOST} status={undefined} onSend={vi.fn()} />
          <p>Return as Health Link</p>
        </div>,
      ).textContent;

      expect(text).toBe("Return as Health Link");
      expect(container.querySelectorAll("button")).toHaveLength(0);
    });
  });

  describe("while sending", () => {
    // Nielsen heuristic 1: the send is a network call, so it says so, and it says where to.
    it("shows progress naming the destination, and offers no second send", () => {
      render(
        <DirectSendPanel
          host={HOST}
          status={{ state: "sending" }}
          onSend={vi.fn()}
        />,
      );

      expect(container.textContent).toContain(HOST);
      expect(container.textContent).toMatch(/sending/i);
      expect(container.querySelectorAll("button")).toHaveLength(0);
    });
  });

  describe("after the send", () => {
    /**
     * Render a terminal or retryable state.
     * @param status the state the send ended in
     * @returns the rendered text
     */
    function ended(status: SendStatus): string {
      return (
        render(<DirectSendPanel host={HOST} status={status} onSend={vi.fn()} />)
          .textContent ?? ""
      );
    }

    // FR-026: a terminal state naming the destination, with no further sends offered.
    it("names the destination and offers no further send once accepted", () => {
      const text = ended({
        state: "sent",
        detail: `${HOST} accepted the answers.`,
      });

      expect(text).toContain(HOST);
      expect(text).toMatch(/accepted/i);
      expect(text).not.toMatch(/delivered/i);
      expect(container.querySelectorAll("button")).toHaveLength(0);
    });

    // A refusal is terminal for this channel and never reads as delivery.
    it("explains a refusal, offers no retry, and points at the remaining way back", () => {
      const text = ended({
        state: "refused",
        detail: `${HOST} would not authorise this link to write the answers.`,
      });

      expect(text).toContain(HOST);
      expect(text).toMatch(/would not authorise/i);
      expect(text).toMatch(/link/i);
      expect(container.querySelectorAll("button")).toHaveLength(0);
    });

    // A failure retains the answers, so the one thing it must offer is another go.
    it("offers a retry after a failure", () => {
      const text = ended({
        state: "failed",
        detail: `${HOST} could not be reached.`,
      });

      expect(text).toContain(HOST);
      expect(
        [...container.querySelectorAll("button")].map(
          (button) => button.textContent,
        ),
      ).toEqual([expect.stringMatching(/try again/i)]);
    });

    // An expired window offers nothing and says why (FR-025).
    it("explains a closed window and offers no send", () => {
      const text = ended({
        state: "expired",
        detail: `The window for sending answers straight to ${HOST} has closed.`,
      });

      expect(text).toContain(HOST);
      expect(text).toMatch(/closed/i);
      expect(container.querySelectorAll("button")).toHaveLength(0);
    });
  });
});

/**
 * Whether an opened invitation offers a direct send at all.
 *
 * This is the gate the disclosure hangs off, and its negative cases are the whole of FR-020's
 * second half: no grant, an unreadable grant, or a Task with nothing stable to key a conditional
 * create on all mean the panel is never rendered. Nothing about that is an error, and nothing
 * about it touches the form.
 */
describe("what an opened invitation offers", () => {
  const RECEIVED: ReceivedGrant = {
    grant: {
      access_token: "opaque-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      aud: "https://ehr.example.org/fhir",
      patient: "pt-demo",
    },
    receivedAt: 1_700_000_000_000,
  };

  const TASK: Task = {
    resourceType: "Task",
    status: "requested",
    intent: "order",
    identifier: [{ system: "urn:ietf:rfc:3986", value: "urn:uuid:request-1" }],
    for: { reference: "Patient/requester-side", display: "Jane Citizen" },
    extension: [
      {
        url: "https://platypushealth.app/StructureDefinition/invitation-server-task-url",
        valueUrl: "https://ehr.example.org/fhir/Task/task-1",
      },
    ],
  };

  // Everything the panel and the send need, read off the invitation and the grant.
  it("offers a send when the manifest carried a grant and the task is identified", () => {
    expect(directSendTarget({ task: TASK, apiAccess: RECEIVED })).toEqual({
      received: RECEIVED,
      host: "ehr.example.org",
      requestIdentifier: "urn:uuid:request-1",
      serverTaskUrl: "https://ehr.example.org/fhir/Task/task-1",
      patientDisplay: "Jane Citizen",
    });
  });

  // A one-file manifest, and a manifest whose grant would not read, are the same thing here.
  it("offers nothing when there is no usable grant", () => {
    expect(
      directSendTarget({ task: TASK, apiAccess: undefined }),
    ).toBeUndefined();
  });

  /*
   * No business identifier means no `ifNoneExist` key, which means a second send would land a
   * second response. An affordance whose idempotency this app cannot guarantee is not offered
   * at all.
   */
  it("offers nothing when the task carries no business identifier", () => {
    expect(
      directSendTarget({
        task: { ...TASK, identifier: undefined },
        apiAccess: RECEIVED,
      }),
    ).toBeUndefined();
  });

  // An invitation with no published Task still sends the answers; only the Task leg is missing.
  it("offers a send with no task leg when the invitation published no task", () => {
    const target = directSendTarget({
      task: { ...TASK, extension: undefined },
      apiAccess: RECEIVED,
    });

    expect(target?.requestIdentifier).toBe("urn:uuid:request-1");
    expect(target?.serverTaskUrl).toBeUndefined();
  });
});
