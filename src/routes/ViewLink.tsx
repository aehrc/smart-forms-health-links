import {
  getResponse,
  removeEmptyAnswersFromResponse,
} from "@aehrc/smart-forms-renderer";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";

import type { ReceivedGrant } from "@/link/apiAccess";
import type {
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

import FillFromRequest from "@/components/FillFromRequest";
import ReviewResponse from "@/components/ReviewResponse";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchQuestionnaireByCanonical } from "@/fhir/formsServer";
import {
  directSendTarget,
  promotesScanBack,
  suppressesOtherChannels,
} from "@/fill/directSend";
import DirectSendPanel from "@/fill/DirectSendPanel";
import { useDirectSend } from "@/fill/useDirectSend";
import { FHIR_PROXY_BASE, useSession } from "@/lib/session";
import {
  PasscodeRequiredError,
  decodingCodec,
  ensureQuestionnaireCanonical,
} from "@/link/codec";
import {
  isRequestBundle,
  parseRequestBundle,
  parseResponseBundle,
  responseCanonical,
  taskQuestionnaireCanonical,
} from "@/link/exchange";
import { LINK_CODECS } from "@/link/registry";

/**
 * The single entry point for any link, in either direction.
 *
 * Dispatching on the payload rather than the route matters because a scanner cannot know what it
 * just scanned. A request (`Questionnaire` + `Task`, no answers) opens the form to be filled; a
 * response (`QuestionnaireResponse`) opens the review-and-accept flow.
 *
 * The response direction is now the primary one: a filler mints its own SMART Health Link and the
 * requester scans it back. Two consequences shape this file. Answers arriving by link carry no
 * indication of *which* request they answer beyond the Task that comes back with them, so that Task
 * is passed through to the review screen rather than looked up anywhere. And a link this app did not
 * write may cite a form the launched server does not hold - or is being opened by a filler with no
 * session at all - so an unresolvable Questionnaire degrades the display rather than failing the
 * open.
 *
 * ## The direct return
 *
 * An invitation whose manifest carried an API access grant can take the answers straight to the
 * clinic's own server, and that is what {@link DirectSendPanel} above the form is for. Three
 * things about where it sits are deliberate.
 *
 * It is rendered *here* rather than inside {@link FillFromRequest} because it is a property of the
 * link, not of the form: the grant arrived beside the payload and never enters the Bundle the form
 * is built from. The answers are collected from the renderer's own store at send time - the same
 * `getResponse()` that minting a response link uses - so nothing has to be threaded down and back.
 *
 * A successful send removes the form and the other return channels entirely
 * ({@link suppressesOtherChannels}). FR-026 requires a terminal state that suppresses all further
 * sends, and the honest way to do that is to stop offering them rather than to disable them.
 *
 * That applies to a send this browser did not make. An invitation reopened after its answers are
 * already stored reaches the same terminal state, because {@link useDirectSend} asks the
 * destination about the published Task when the link is opened - so what a filler sees is the
 * accepted state rather than a second empty form (spec edge case: "the same invitation opened
 * after the response was already sent"). While that question is outstanding the form renders as
 * usual and only the send affordance waits.
 *
 * A grant that could not be read is simply absent, so nothing here changes: no panel, and the
 * form and the scan-back return exactly as before (FR-020).
 */

type Opened = { warnings?: string[]; label?: string } & (
  | {
      mode: "request";
      questionnaire: Questionnaire;
      task: Task;
      /**
       * Answers the requester filled in from the record before sending, when there are any.
       *
       * Carried through to the renderer so the form opens with them already in it. Dropping it
       * here is invisible on the wire - the seed still travels, still round-trips, still passes
       * the payload checks - and shows up only as a blank form, which is why it is named on this
       * type rather than pulled out of the Bundle again further down.
       */
      prePopulated?: QuestionnaireResponse;
      /** The grant the manifest carried, when it carried a readable one. */
      apiAccess?: ReceivedGrant;
    }
  | {
      mode: "response";
      questionnaire?: Questionnaire;
      questionnaireError?: string;
      response: QuestionnaireResponse;
      task?: Task;
      provenance?: Provenance;
    }
);

async function openLink(
  fragment: string,
  formsServerUrl: string,
  options: {
    passcode?: string;
    signal?: AbortSignal;
    /** What to call the server in anything the user reads; defaults to a neutral description. */
    serverName?: string;
  } = {},
): Promise<Opened> {
  const codec = decodingCodec(fragment, LINK_CODECS);
  const content = await codec.decode(fragment, { passcode: options.passcode });

  if (isRequestBundle(content.bundle)) {
    // A request embeds its Questionnaire, so nothing needs resolving.
    const { questionnaire, task, prePopulated } = parseRequestBundle(
      content.bundle,
    );
    return {
      mode: "request",
      questionnaire,
      task,
      prePopulated,
      label: content.label,
      warnings: content.warnings,
      /*
       * Only the request direction can use a grant. A response link opened here is the requester
       * scanning answers back, and there is nothing left to send.
       */
      apiAccess: content.apiAccess,
    };
  }

  const { response, task, provenance } = parseResponseBundle(content.bundle);

  const base = {
    mode: "response" as const,
    response,
    task,
    provenance,
    warnings: content.warnings,
    label: content.label,
  };

  /*
   * The form is carried by reference, never by value (re-sending hundreds of kilobytes of
   * Questionnaire would defeat the point), so it is resolved here, falling back to the canonical
   * the returned Task carries when the answers do not name one themselves.
   */
  const canonical = responseCanonical(
    response,
    taskQuestionnaireCanonical(task),
  );
  if (!canonical) {
    return {
      ...base,
      questionnaireError:
        "These answers do not name the questionnaire they were given against.",
    };
  }

  try {
    return {
      ...base,
      questionnaire: await fetchQuestionnaireByCanonical(
        formsServerUrl,
        canonical,
        options.signal,
      ),
    };
  } catch (error) {
    // A cancelled query is not a resolution failure, and must not be presented as one.
    if (options.signal?.aborted) {
      throw error;
    }

    return {
      ...base,
      questionnaireError:
        `These answers cite ${canonical}, which ` +
        `${options.serverName ?? "the launched server"} does not hold.`,
    };
  }
}

/**
 *
 */
export default function ViewLink() {
  const location = useLocation();

  // `location.hash` includes the leading '#'; the codecs strip it.
  const fragment = location.hash;

  /*
   * The nonce is load-bearing: without it, react-query treats a re-submitted passcode as a cache
   * hit, so correcting a typo back to a value already tried would silently do nothing.
   *
   * The fragment is recorded alongside it so a passcode never outlives the link it was typed for.
   * Changing only the hash re-renders this component without remounting it, so state survives -
   * and carrying a passcode across would spend one of the *next* link's limited attempts on
   * something the user never entered for it, which is exactly what the `P` pre-empt exists to avoid.
   */
  const [attempt, setAttempt] = useState<{
    fragment: string;
    passcode?: string;
    nonce: number;
  }>({
    fragment,
    nonce: 0,
  });
  const passcode = attempt.fragment === fragment ? attempt.passcode : undefined;

  /*
   * What to call the server in the one message that names it. Deliberately *not* part of the
   * query key: a session resolving after the link has opened would re-run the open, and a second
   * manifest fetch means a second minted token for no reason. An anonymous filler has no session
   * and gets the neutral wording.
   */
  const session = useSession();
  const serverName =
    session.kind === "active" ? session.session.issuerLabel : undefined;

  const {
    data: opened,
    isPending,
    error,
  } = useQuery({
    queryKey: ["link", fragment, passcode ?? "", attempt.nonce],
    /*
     * The canonical resolution below reads through the session proxy, which is right for the
     * requester scanning answers back and unavailable to a filler who holds only a link - so an
     * unresolvable Questionnaire degrades the display rather than failing the open.
     */
    queryFn: ({ signal }) =>
      openLink(fragment, FHIR_PROXY_BASE, { passcode, signal, serverName }),
    enabled: fragment !== "",
    retry: false,
  });

  if (fragment === "") {
    return (
      <Alert title="No link to open">
        This page opens a form from a link. Scan a QR code, or paste a link on
        the Scan page.
      </Alert>
    );
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Opening link…
      </p>
    );
  }

  if (error instanceof PasscodeRequiredError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <PasscodePrompt
          error={error}
          onSubmit={(entered) =>
            setAttempt((previous) => ({
              fragment,
              passcode: entered,
              nonce: previous.nonce + 1,
            }))
          }
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert tone="error" title="Could not open this link">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
        <BackLink />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />

      {/* Above both branches: a request delivered by manifest can drop files just as a response can. */}
      {opened.warnings && opened.warnings.length > 0 ? (
        <Alert tone="warning" title="Some of this link was not shown">
          <ul className="space-y-0.5">
            {opened.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {opened.mode === "request" ? (
        /*
         * Keyed by the fragment so that opening a second link inside the same mounted route starts
         * over: a send state and a grant window belong to one invitation, and carrying either
         * across would describe the previous link.
         */
        <OpenedRequest
          key={fragment}
          questionnaire={opened.questionnaire}
          task={opened.task}
          prePopulated={opened.prePopulated}
          apiAccess={opened.apiAccess}
          label={opened.label}
        />
      ) : (
        <ReviewResponse
          questionnaire={opened.questionnaire}
          questionnaireError={opened.questionnaireError}
          response={opened.response}
          task={opened.task}
          provenance={opened.provenance}
          label={opened.label}
        />
      )}
    </div>
  );
}

/**
 * An opened invitation: the direct send if there is one, and the form.
 *
 * Separate from {@link ViewLink} because the direct send is live state - a window that closes on a
 * timer - and hooks cannot be called after the route's loading, passcode and error branches have
 * returned. Splitting it also means the send state is scoped to one invitation by construction.
 * @param props the form, the request, the grant it arrived with, and the label to show
 * @param props.questionnaire
 * @param props.task
 * @param props.prePopulated
 * @param props.apiAccess
 * @param props.label
 * @returns the direct-send surface above the form
 */
function OpenedRequest(props: {
  readonly questionnaire: Questionnaire;
  readonly task: Task;
  readonly prePopulated?: QuestionnaireResponse;
  readonly apiAccess?: ReceivedGrant;
  readonly label?: string;
}) {
  const { questionnaire, task, prePopulated, apiAccess, label } = props;

  const target = directSendTarget({ task, apiAccess });
  const { status, send } = useDirectSend(target);

  return (
    <>
      {target && status ? (
        <DirectSendPanel
          host={target.host}
          relayHost={target.relayHost}
          status={status}
          /*
           * The answers are read from the renderer's store at the moment of the send rather than
           * threaded down and back: that store is where they live, and it is the same
           * `getResponse()` that minting a return link uses. Empty and hidden answers are stripped
           * and the questionnaire canonical stamped on, so the destination is told which form was
           * answered.
           */
          onSend={() =>
            send(
              ensureQuestionnaireCanonical(
                removeEmptyAnswersFromResponse(questionnaire, getResponse()),
                questionnaire,
              ),
            )
          }
        />
      ) : null}

      {/*
       * Once the destination has the answers there is nothing further to return, so the form
       * and every other channel go away rather than being left disabled (FR-026).
       */}
      {status && suppressesOtherChannels(status) ? null : (
        <FillFromRequest
          questionnaire={questionnaire}
          task={task}
          prePopulated={prePopulated}
          label={label}
          /*
           * Suppresses the "this request also names a server, and this app does not write there"
           * note, which stops being true the moment a grant makes it possible.
           */
          directSendOffered={target !== undefined}
          /*
           * ...and once that grant is spent or expired, the note is not the point any more: the
           * link return is, so it stops being the alternative and becomes the instruction.
           */
          scanBackPromoted={status !== undefined && promotesScanBack(status)}
        />
      )}
    </>
  );
}

function PasscodePrompt(props: {
  error: PasscodeRequiredError;
  onSubmit: (passcode: string) => void;
}) {
  const [passcode, setPasscode] = useState("");
  const exhausted = props.error.remainingAttempts === 0;

  return (
    <Alert
      tone={props.error.wasAttempted ? "error" : "warning"}
      title="This link requires a passcode"
    >
      <p>
        {props.error.wasAttempted
          ? props.error.message
          : "The sender protected this link with a passcode. They should have given it to you separately from the link itself."}
      </p>

      {exhausted ? (
        <p className="mt-2">
          No attempts remain, so this link can no longer be opened. Ask the
          sender for a new one.
        </p>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (passcode.trim() !== "") {
              props.onSubmit(passcode);
            }
          }}
        >
          <div className="space-y-1">
            <label
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              htmlFor="shl-passcode"
            >
              Passcode
            </label>
            <Input
              id="shl-passcode"
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              autoComplete="one-time-code"
              aria-label="Link passcode"
            />
          </div>
          <Button type="submit" disabled={passcode.trim() === ""}>
            <KeyRound className="h-4 w-4" aria-hidden />
            Open link
          </Button>
        </form>
      )}
    </Alert>
  );
}

function BackLink() {
  return (
    <RouterLink
      to="/"
      className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All forms
    </RouterLink>
  );
}
