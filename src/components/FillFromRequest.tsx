import { useState } from 'react';
import { CheckCircle2, Link2, Loader2, Send, ShieldCheck } from 'lucide-react';
import type { Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import {
  canCreateHealthLinks,
  createResponseLink,
  sendEncryptedReply,
  sendOneShotWrite
} from '@/link/createLink';
import { taskCorrelationId } from '@/link/exchange';
import { parseReturnChannels } from '@/link/replyDescriptor';
import FormRenderer from '@/components/FormRenderer';
import ShareLinkPanel from '@/components/ShareLinkPanel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

export interface FillFromRequestProps {
  questionnaire: Questionnaire;
  task: Task;
  /**
   * Answers the requester filled in from their record before sending, when they did.
   *
   * Passed to the renderer **by reference**, and it must stay one: `useBuildForm` compares it that
   * way, so a fresh object each render rebuilds the form in a loop (the caveat `ReviewResponse`
   * documents). It arrives from `parseRequestBundle` inside a cached query, which is stable — so
   * nothing here may reshape it on the way past.
   */
  prePopulated?: QuestionnaireResponse;
  label?: string;
}

/**
 * The filler's side: a request arrived, so render its embedded Questionnaire and hand the answers
 * back.
 *
 * The form may arrive partly filled in. The requester can populate it from their own record before
 * sending — the only side that can, since nothing here has a path to their servers — and those
 * answers travel as a seed the renderer starts from. It is a starting point and not an assertion:
 * this device owns it once the link is open, and clearing a field is as final as typing in one. The
 * alert below the channel list says so, and it is not decoration — it is the only thing between
 * somebody and silently endorsing a clinician's data as their own.
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
 * - **Send answers** — a single conditional `PUT` into a slot the request pre-allocated. Plaintext
 *   FHIR, so the slot host sees the content, in exchange for needing no crypto at all to answer;
 *   also offered only when the request asked for it.
 *
 * When a request offers a slot of either kind, that becomes the primary action — it is the one that
 * needs nothing further from the person filling the form.
 *
 * ## Why this app *does* write to a channel-D slot, having refused channel B
 *
 * The objection to channel B was never "writing is wrong". It was that B named a record server with
 * no capability attached, so answering it meant pushing an unreviewed assertion into somebody's
 * record and hoping that was wanted. A channel-D slot is a single pre-allocated resource on the
 * requester's own transport host, the write is bounded to once, and the requester still reviews
 * before anything reaches a record. Nothing that made B refusable is present, so refusing it would
 * strand answers for no gain — which is the same reasoning that has this app honour someone else's
 * reply slot.
 */
export default function FillFromRequest(props: FillFromRequestProps) {
  const { questionnaire, task, prePopulated, label } = props;
  const config = useConfig();

  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'shl' | 'reply' | 'write' | null>(null);
  /** Which channel the answers went down, or null while they have not been sent. */
  const [sent, setSent] = useState<'reply' | 'write' | null>(null);
  /**
   * The slot had already been answered.
   *
   * Kept apart from {@link error} on purpose: it is not a failure the person can retry their way out
   * of, and offering them a retry that is guaranteed to fail again would be a lie.
   */
  const [taken, setTaken] = useState(false);

  const channels = parseReturnChannels(task);

  async function handleReturn() {
    setError(null);
    setPending('shl');
    try {
      const created = await createResponseLink(questionnaire, config, task);
      setLink(created);
    } catch (cause) {
      setLink(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  async function handleSendSecurely() {
    if (!channels.reply) {
      return;
    }

    setError(null);
    setPending('reply');
    try {
      await sendEncryptedReply(questionnaire, channels.reply, task);
      setSent('reply');
    } catch (cause) {
      // Never mark it sent on failure: the honest state is "not sent", with a retry available.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  async function handleSendAnswers() {
    if (!channels.write) {
      return;
    }

    setError(null);
    setPending('write');
    try {
      const outcome = await sendOneShotWrite(questionnaire, channels.write, task);

      switch (outcome.status) {
        case 'written':
          setSent('write');
          break;
        case 'taken':
          // Someone got there first, or an earlier send of ours landed without us seeing it. Either
          // way the request has its answers and a second write must not be attempted.
          setTaken(true);
          break;
        case 'refused':
          setError(
            'The requester\u2019s server refused the token this request carried, so the answers were ' +
              `not written (${outcome.detail}). Return them as a link instead.`
          );
          break;
        case 'gone':
          setError(
            'The slot this request named no longer exists, so there is nowhere to write the answers. ' +
              'Return them as a link instead.'
          );
          break;
      }
    } catch (cause) {
      // Never mark it sent on failure: the honest state is "not sent", with a retry available.
      setError(cause instanceof Error ? cause.message : String(cause));
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
            {requester ? `${requester} has asked for this form to be completed.` : 'Someone has asked for this form to be completed.'}
            {addressedTo ? (
              <>
                {' '}
                Addressed to <strong>{addressedTo}</strong>.
              </>
            ) : null}
            {correlationId ? (
              <>
                {' '}
                Request <span className="font-mono text-xs">{correlationId}</span>
              </>
            ) : null}
          </p>
        </div>

        {sent || taken ? null : (
          <div className="ml-auto flex flex-wrap gap-2">
            {channels.reply ? (
              <Button onClick={handleSendSecurely} disabled={pending !== null}>
                {pending === 'reply' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                )}
                {pending === 'reply' ? 'Encrypting and sending…' : 'Send securely'}
              </Button>
            ) : null}
            {channels.write ? (
              <Button
                variant={channels.reply ? 'outline' : undefined}
                onClick={handleSendAnswers}
                disabled={pending !== null}
                title="Written straight into the slot the requester set aside — once">
                {pending === 'write' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Send className="h-4 w-4" aria-hidden />
                )}
                {pending === 'write' ? 'Sending…' : 'Send answers'}
              </Button>
            ) : null}
            <Button
              variant={channels.reply || channels.write ? 'outline' : undefined}
              onClick={handleReturn}
              disabled={pending !== null || !canHost}
              title={
                canHost
                  ? 'Encrypted and hosted — the requester scans it back'
                  : 'Needs blobServerUrl in config.json'
              }>
              {pending === 'shl' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Link2 className="h-4 w-4" aria-hidden />
              )}
              Return as Health Link
            </Button>
          </div>
        )}
      </div>

      {sent === 'reply' ? (
        <Alert title="Sent securely">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
            The encrypted answers were delivered to the requester&rsquo;s reply slot.
          </span>
          <p className="mt-1">
            Only they can read them — the answers were encrypted to their key before leaving this
            device. This confirms delivery to the slot and nothing more: there is no signal available
            for whether they have collected it yet.
          </p>
        </Alert>
      ) : null}

      {sent === 'write' ? (
        <Alert title="Answers sent">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
            The answers were written to the slot the requester set aside.
          </span>
          <p className="mt-1">
            That was the one write this request allowed, so they cannot be sent again this way. It
            confirms delivery and nothing more — the requester still has to collect them, and someone
            there still has to review them before they reach a record.
          </p>
        </Alert>
      ) : null}

      {taken ? (
        <Alert title="This request has already been answered">
          The slot the request named already holds a completed response, so nothing was written — an
          answer either arrived from somewhere else, or an earlier send from here landed after all.
          The write was refused rather than overwriting it, which is the point of it being a single
          write.
          <p className="mt-1">
            If these answers are the ones that should stand, return them as a Health Link instead and
            let the requester decide.
          </p>
          <Button variant="outline" className="mt-2" onClick={handleReturn} disabled={!canHost}>
            <Link2 className="h-4 w-4" aria-hidden />
            Return as Health Link
          </Button>
        </Alert>
      ) : null}

      {!sent && !taken && channels.reply ? (
        <Alert title="This request can accept answers directly">
          The answers will be encrypted to the requester&rsquo;s key on this device and left in a slot
          for them to collect, so nothing has to be scanned back.
          {channels.reply.replyMethod !== 'PUT' ? (
            <p className="mt-1">
              It asks for delivery by{' '}
              <span className="font-mono text-xs">{channels.reply.replyMethod}</span>, which this app
              does not implement — use one of the link options instead.
            </p>
          ) : null}
        </Alert>
      ) : null}

      {!sent && !taken && channels.write ? (
        <Alert title="This request set aside a place for the answers">
          They will be written straight to{' '}
          <span className="font-mono text-xs break-all">{channels.write.writeUrl}</span>, so nothing
          has to be scanned back.
          <p className="mt-1">
            Two things worth knowing before you use it. The answers travel as ordinary FHIR, so
            whoever runs that server can read them — unlike the encrypted reply, where they cannot.
            And the request allows{' '}
            {channels.write.writeEtag ? <strong>exactly one</strong> : 'a'} write
            {channels.write.writeEtag ? ', so corrections after that go through the requester' : ''}.
          </p>
        </Alert>
      ) : null}

      {!sent && !taken && channels.serverTaskUrl && !channels.write ? (
        <Alert title="This request also names a server">
          Answers may be written directly to{' '}
          <span className="font-mono text-xs break-all">{channels.serverTaskUrl}</span>. This app does
          not do that — it names a record server and carries no capability, so answering it would push
          answers into someone&rsquo;s record unreviewed. Use one of the options above instead.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" title="The answers have not been sent">
          {error}
        </Alert>
      ) : null}

      {link ? <ShareLinkPanel link={link} kind="response" /> : null}

      {prePopulated ? (
        <Alert title="Some of this is already filled in">
          <p>
            {task.requester?.display ?? 'Whoever sent this'} filled in part of this form from their
            own records before sending it. <strong>Check it.</strong> Anything wrong or out of date
            can be changed or cleared here, and what you send back is what you leave on the form —
            nothing is kept from the original.
          </p>
        </Alert>
      ) : null}

      <div className="form-surface">
        <FormRenderer
          questionnaire={questionnaire}
          questionnaireResponse={prePopulated}
          terminologyServerUrl={config.terminologyServerUrl}
        />
      </div>
    </div>
  );
}
