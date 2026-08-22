import { CheckCircle2, Loader2, Send } from "lucide-react";
import { useState } from "react";

import type { SendStatus } from "./directSend";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The direct-return surface, from disclosure to outcome.
 *
 * Everything this panel says names the destination host, because that is the only part of a
 * `https://kuzfdswqmz.edge.aidbox.app/fhir` a person can weigh (FR-020). The wording of each
 * outcome comes from {@link SendStatus.detail} rather than from here: the state machine already
 * has to be precise about what a 2xx, a 401 and a dropped connection each mean, and restating it
 * in the component would be two places to drift.
 *
 * ## Why there is a confirmation step
 *
 * A send is irreversible and it writes into someone's medical record. The disclosure a patient
 * read when the page loaded is not necessarily the one in front of them twenty minutes later when
 * they finish typing, so the destination is named again at the moment of the decision (FR-021).
 *
 * ## Why an absent grant renders nothing
 *
 * Not a disabled button, not an explanation - nothing. A manifest with no grant, or with one this
 * app could not read, is a link whose only return path is the scan-back one, and that path is
 * already on screen below. Describing a channel that does not exist would be the one outcome
 * FR-020 rules out: a malformed grant getting in the way of the form.
 * @author John Grimes
 */

export interface DirectSendPanelProps {
  /** The destination's host, named in every message this panel shows. */
  readonly host: string;
  /** Where the send is up to, or undefined when there is no usable grant. */
  readonly status: SendStatus | undefined;
  /** Start the send. Called once, when the person filling the form confirms. */
  readonly onSend: () => void;
}

/**
 * The direct-return surface: disclosure, confirmation, progress and outcome.
 * @param props the destination host, the send state and the send action
 * @returns the panel, or nothing when there is no direct channel to disclose
 */
export default function DirectSendPanel(props: DirectSendPanelProps) {
  const { host, status, onSend } = props;
  const [confirming, setConfirming] = useState(false);

  if (!status) {
    return null;
  }

  if (status.state === "sent") {
    return (
      <Alert title={`Accepted by ${host}`}>
        <span className="inline-flex items-start gap-1.5">
          <CheckCircle2
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden
          />
          {status.detail ?? `${host} accepted the answers.`}
        </span>
        <p className="mt-1">
          There is nothing further to return. Acceptance means {host} took the
          answers into its record; it is not a signal that anyone there has
          opened them.
        </p>
      </Alert>
    );
  }

  if (status.state === "refused") {
    return (
      <Alert tone="error" title="These answers were not accepted">
        {status.detail ??
          `${host} would not authorise this link to write the answers.`}
        <p className="mt-1">
          The answers are still here. They can be returned as a link for the
          requester to scan instead.
        </p>
      </Alert>
    );
  }

  if (status.state === "expired") {
    return (
      <Alert tone="warning" title="The direct send has closed">
        {status.detail ??
          `The window for sending answers straight to ${host} has closed.`}
        <p className="mt-1">
          The answers can still be returned as a link for the requester to scan.
        </p>
      </Alert>
    );
  }

  if (status.state === "sending") {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Sending answers to {host}…
      </p>
    );
  }

  if (status.state === "failed") {
    return (
      <div className="space-y-3">
        <Alert tone="error" title="The answers have not been sent">
          {status.detail ?? `${host} did not take the answers.`}
        </Alert>
        <Button onClick={onSend}>
          <Send className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="space-y-3">
        <Alert tone="warning" title={`Send these answers to ${host}?`}>
          They will be written into the record at {host} as soon as you confirm,
          and cannot be taken back from here.
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setConfirming(false);
              onSend();
            }}
          >
            <Send className="h-4 w-4" aria-hidden />
            Confirm and send
          </Button>
          <Button variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Alert title={`Answers go straight to ${host}`}>
        This request can take the completed answers directly. They are written
        into the record at {host}, which is where the request came from, so
        nothing has to be scanned back.
      </Alert>
      <Button onClick={() => setConfirming(true)}>
        <Send className="h-4 w-4" aria-hidden />
        Send answers to {host}
      </Button>
    </div>
  );
}
