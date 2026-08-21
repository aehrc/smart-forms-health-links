import { CheckCircle2, Link2, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { Questionnaire, Task } from "fhir/r4";

import FormRenderer from "@/components/FormRenderer";
import ShareLinkPanel from "@/components/ShareLinkPanel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/lib/ConfigContext";
import {
  canCreateHealthLinks,
  createResponseLink,
  sendEncryptedReply,
} from "@/link/createLink";
import { taskCorrelationId } from "@/link/exchange";
import { parseReturnChannels } from "@/link/replyDescriptor";

export interface FillFromRequestProps {
  questionnaire: Questionnaire;
  task: Task;
  label?: string;
}

/**
 * The filler's side: a request arrived, so render its embedded Questionnaire and hand the answers
 * back.
 *
 * Two return paths:
 *
 * - **SMART Health Link** — the answers are encrypted, hosted, and handed back as a link the
 *   requester scans. This is the default path and the one Platypus uses, so it is what the requester
 *   side is built to read. It needs somewhere to put the payload; in production that would be the
 *   filling app's own storage.
 * - **Send securely** — the answers are encrypted to a public key the request carried and parked in
 *   a slot the requester polls. Offered only when the request asked for it, which by default no
 *   request this app mints does. It remains here because honouring someone else's return channel is
 *   a different question from offering our own: refusing would strand their answers.
 *
 * When a request does offer a reply slot, that becomes the primary action — it is the one that needs
 * nothing further from the person filling the form.
 */
export default function FillFromRequest(props: FillFromRequestProps) {
  const { questionnaire, task, label } = props;
  const config = useConfig();

  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"shl" | "reply" | null>(null);
  const [sent, setSent] = useState(false);

  const channels = parseReturnChannels(task);

  async function handleReturn() {
    setError(null);
    setPending("shl");
    try {
      const created = await createResponseLink(questionnaire, config, task);
      setLink(created);
    } catch (error_) {
      setLink(null);
      setError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setPending(null);
    }
  }

  async function handleSendSecurely() {
    if (!channels.reply) {
      return;
    }

    setError(null);
    setPending("reply");
    try {
      await sendEncryptedReply(questionnaire, channels.reply, task);
      setSent(true);
    } catch (error_) {
      // Never mark it sent on failure: the honest state is "not sent", with a retry available.
      setError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setPending(null);
    }
  }

  const correlationId = taskCorrelationId(task);
  const canHost = canCreateHealthLinks(config);
  const requester = task.requester?.display;
  const addressedTo = task.for?.display;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {label ?? questionnaire.title ?? questionnaire.id}
          </h1>
          <p className="text-sm text-slate-500">
            {requester
              ? `${requester} has asked for this form to be completed.`
              : "Someone has asked for this form to be completed."}
            {addressedTo ? (
              <>
                {" "}
                Addressed to <strong>{addressedTo}</strong>.
              </>
            ) : null}
            {correlationId ? (
              <>
                {" "}
                Request{" "}
                <span className="font-mono text-xs">{correlationId}</span>
              </>
            ) : null}
          </p>
        </div>

        {sent ? null : (
          <div className="ml-auto flex flex-wrap gap-2">
            {channels.reply ? (
              <Button onClick={handleSendSecurely} disabled={pending !== null}>
                {pending === "reply" ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                )}
                {pending === "reply"
                  ? "Encrypting and sending…"
                  : "Send securely"}
              </Button>
            ) : null}
            <Button
              variant={channels.reply ? "outline" : undefined}
              onClick={handleReturn}
              disabled={pending !== null || !canHost}
              title={
                canHost
                  ? "Encrypted and hosted — the requester scans it back"
                  : "Needs blobServerUrl in config.json"
              }
            >
              {pending === "shl" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Link2 className="h-4 w-4" aria-hidden />
              )}
              Return as Health Link
            </Button>
          </div>
        )}
      </div>

      {sent ? (
        <Alert title="Sent securely">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
            The encrypted answers were delivered to the requester&rsquo;s reply
            slot.
          </span>
          <p className="mt-1">
            Only they can read them — the answers were encrypted to their key
            before leaving this device. This confirms delivery to the slot and
            nothing more: there is no signal available for whether they have
            collected it yet.
          </p>
        </Alert>
      ) : null}

      {!sent && channels.reply ? (
        <Alert title="This request can accept answers directly">
          The answers will be encrypted to the requester&rsquo;s key on this
          device and left in a slot for them to collect, so nothing has to be
          scanned back.
          {channels.reply.replyMethod === "PUT" ? null : (
            <p className="mt-1">
              It asks for delivery by{" "}
              <span className="font-mono text-xs">
                {channels.reply.replyMethod}
              </span>
              , which this app does not implement — use one of the link options
              instead.
            </p>
          )}
        </Alert>
      ) : null}

      {!sent && channels.serverTaskUrl ? (
        <Alert title="This request also names a server">
          Answers may be written directly to{" "}
          <span className="font-mono text-xs break-all">
            {channels.serverTaskUrl}
          </span>
          . This app does not do that — it returns answers to the requester
          rather than writing into their record unreviewed.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" title="The answers have not been sent">
          {error}
        </Alert>
      ) : null}

      {link ? <ShareLinkPanel link={link} kind="response" /> : null}

      <div className="form-surface">
        <FormRenderer
          questionnaire={questionnaire}
          terminologyServerUrl={config.terminologyServerUrl}
        />
      </div>
    </div>
  );
}
