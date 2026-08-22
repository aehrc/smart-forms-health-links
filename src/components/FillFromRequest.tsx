import { CheckCircle2, Link2, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { Questionnaire, Task } from "fhir/r4";

import FormRenderer from "@/components/FormRenderer";
import ShareLinkPanel from "@/components/ShareLinkPanel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/lib/configContextValue";
import { createResponseLink, sendEncryptedReply } from "@/link/createLink";
import { taskCorrelationId } from "@/link/exchange";
import { parseReturnChannels } from "@/link/replyDescriptor";

export interface FillFromRequestProps {
  questionnaire: Questionnaire;
  task: Task;
  label?: string;
  /**
   * Whether the surface above is already offering to write the answers to the named server.
   *
   * Suppresses this component's "this request also names a server, and this app does not write
   * there" note, which stops being true the moment a grant makes such a write possible.
   */
  directSendOffered?: boolean;
  /**
   * Whether returning a link is now the way these answers get home.
   *
   * Set when the direct channel is shut with nothing delivered - an expired window or a refused
   * credential. It makes the return the primary action and says so, rather than leaving a person
   * to work out that the alternative in the corner is now the only option (FR-025, FR-028).
   */
  scanBackPromoted?: boolean;
}

/**
 * The filler's side: a request arrived, so render its embedded Questionnaire and hand the answers
 * back.
 *
 * Two return paths live here, and neither is the direct send - that is offered above this
 * component, by the surface that holds the grant.
 *
 * - **Return answers as a link** - the answers are compressed into a link the requester scans and
 *   accepts under their own session. Always available: it needs no session, no host and no
 *   network, which is what makes it the fallback every other channel can fall back *to*. The link
 *   is not encrypted, and the panel that shows it says so.
 * - **Send securely** - the answers are encrypted to a public key the request carried and parked
 *   in a slot the requester polls. Offered only when the request asked for it, which no request
 *   this app mints does. It remains here because honouring someone else's return channel is a
 *   different question from offering our own: refusing would strand their answers.
 *
 * Which one leads depends on what the request offers and on what has already been tried. A reply
 * slot leads when there is one, because it needs nothing further from the person filling the form.
 * `scanBackPromoted` overrides that: once the direct channel has closed with nothing delivered,
 * the link is the way home and is presented as such.
 * @param props the form, the request it answers, and what the surface above has already offered
 * @returns the filler's surface
 */
export default function FillFromRequest(props: FillFromRequestProps) {
  const {
    questionnaire,
    task,
    label,
    directSendOffered = false,
    scanBackPromoted = false,
  } = props;
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
  const requester = task.requester?.display;
  const addressedTo = task.for?.display;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {label ?? questionnaire.title ?? questionnaire.id}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
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
              <Button
                variant={scanBackPromoted ? "outline" : undefined}
                onClick={() => {
                  void handleSendSecurely();
                }}
                disabled={pending !== null}
              >
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
              variant={
                channels.reply && !scanBackPromoted ? "outline" : undefined
              }
              onClick={() => {
                void handleReturn();
              }}
              disabled={pending !== null}
              title="The requester scans it back and accepts the answers themselves"
            >
              {pending === "shl" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Link2 className="h-4 w-4" aria-hidden />
              )}
              Return answers as a link
            </Button>
          </div>
        )}
      </div>

      {sent ? (
        <Alert title="Sent securely">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2
              className="h-3.5 w-3.5 text-green-600 dark:text-green-400"
              aria-hidden
            />
            The encrypted answers were delivered to the requester&rsquo;s reply
            slot.
          </span>
          <p className="mt-1">
            Only they can read them - the answers were encrypted to their key
            before leaving this device. This confirms delivery to the slot and
            nothing more: there is no signal available for whether they have
            collected it yet.
          </p>
        </Alert>
      ) : null}

      {/*
       * Above the form, because it is an instruction rather than a footnote: the surface that
       * closed the direct channel has explained why, and this is what to do about it. It says
       * where the answers go and who does the accepting, since a link that the requester has to
       * scan needs the requester to be in the room.
       */}
      {!sent && scanBackPromoted ? (
        <Alert title="Return these answers as a link">
          Finish the form, then use <strong>Return answers as a link</strong>{" "}
          above. It produces a QR code and a link for{" "}
          {requester ?? "whoever asked for this form"} to scan, and they accept
          the answers into the record themselves. Nothing is sent from here.
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
              , which this app does not implement - use one of the link options
              instead.
            </p>
          )}
        </Alert>
      ) : null}

      {!sent && channels.serverTaskUrl && !directSendOffered ? (
        <Alert title="This request also names a server">
          Answers may be written directly to{" "}
          <span className="font-mono text-xs break-all">
            {channels.serverTaskUrl}
          </span>
          . This app does not do that without a grant that authorises it - it
          returns answers to the requester rather than writing into their record
          unreviewed.
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
