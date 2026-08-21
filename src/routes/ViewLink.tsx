import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";

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
import { FHIR_PROXY_BASE } from "@/lib/session";
import {
  listRequests,
  updateRequest,
  type OutstandingRequest,
} from "@/lib/requestStore";
import { findRequestForTask } from "@/lib/sentRequests";
import { PasscodeRequiredError, decodingCodec } from "@/link/codec";
import {
  isRequestBundle,
  parseRequestBundle,
  parseResponseBundle,
  responseCanonical,
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
 * indication of *which* request they answer beyond `Task.identifier`, so the local record is looked
 * up here and stamped on save. And a link this app did not write may cite a form the launched
 * server does not hold - or is being opened by a filler with no session at all - so an unresolvable
 * Questionnaire degrades the display rather than failing the open.
 */

type Opened = { warnings?: string[]; label?: string } & (
  | { mode: "request"; questionnaire: Questionnaire; task: Task }
  | {
      mode: "response";
      questionnaire?: Questionnaire;
      questionnaireError?: string;
      response: QuestionnaireResponse;
      task?: Task;
      provenance?: Provenance;
      matchedRequest?: OutstandingRequest;
    }
);

async function openLink(
  fragment: string,
  formsServerUrl: string,
  options: { passcode?: string; signal?: AbortSignal } = {},
): Promise<Opened> {
  const codec = decodingCodec(fragment, LINK_CODECS);
  const content = await codec.decode(fragment, { passcode: options.passcode });

  if (isRequestBundle(content.bundle)) {
    // A request embeds its Questionnaire, so nothing needs resolving.
    const { questionnaire, task } = parseRequestBundle(content.bundle);
    return {
      mode: "request",
      questionnaire,
      task,
      label: content.label,
      warnings: content.warnings,
    };
  }

  const { response, task, provenance } = parseResponseBundle(content.bundle);

  // Which request did this answer? `Task.identifier` is the only thing that survives the round trip.
  const matchedRequest = findRequestForTask(listRequests(), task);

  const base = {
    mode: "response" as const,
    response,
    task,
    provenance,
    matchedRequest,
    warnings: content.warnings,
    label: content.label,
  };

  /*
   * The form is carried by reference, never by value — re-sending hundreds of kilobytes of
   * Questionnaire would defeat the point — so it is resolved here, falling back to what the
   * originating request recorded when the answers do not say.
   */
  const canonical = responseCanonical(
    response,
    matchedRequest?.questionnaireCanonical,
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
      questionnaireError: `These answers cite ${canonical}, which ${formsServerUrl} does not hold.`,
    };
  }
}

export default function ViewLink() {
  const location = useLocation();

  // `location.hash` includes the leading '#'; the codecs strip it.
  const fragment = location.hash;

  /*
   * The nonce is load-bearing: without it, react-query treats a re-submitted passcode as a cache
   * hit, so correcting a typo back to a value already tried would silently do nothing.
   *
   * The fragment is recorded alongside it so a passcode never outlives the link it was typed for.
   * Changing only the hash re-renders this component without remounting it, so state survives —
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

  const {
    data: opened,
    isPending,
    error,
  } = useQuery({
    queryKey: ["link", fragment, passcode ?? "", attempt.nonce],
    /*
     * TODO(phase-5): T037-T039 rework this surface. The canonical resolution below reads through
     * the session proxy, which is right for the requester scanning answers back, and unavailable
     * to a filler who holds only a link - so an unresolvable Questionnaire has to keep degrading
     * the display rather than failing the open, exactly as it already does.
     */
    queryFn: ({ signal }) =>
      openLink(fragment, FHIR_PROXY_BASE, { passcode, signal }),
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
        <FillFromRequest
          questionnaire={opened.questionnaire}
          task={opened.task}
          label={opened.label}
        />
      ) : (
        <ReviewResponse
          questionnaire={opened.questionnaire}
          questionnaireError={opened.questionnaireError}
          response={opened.response}
          task={opened.task}
          provenance={opened.provenance}
          matchedRequest={opened.matchedRequest}
          label={opened.label}
          onSaved={() => {
            /*
             * Close the loop on `/requests`. Without this a request answered by link stays listed as
             * outstanding forever, because nothing else observes that the answers came back.
             */
            if (opened.matchedRequest) {
              updateRequest(opened.matchedRequest.id, {
                collectedAt: new Date().toISOString(),
              });
            }
          }}
        />
      )}
    </div>
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
