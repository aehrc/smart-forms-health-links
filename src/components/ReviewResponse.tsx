import {
  getResponse,
  removeEmptyAnswersFromResponse,
} from "@aehrc/smart-forms-renderer";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  FilePlus2,
  Loader2,
  PencilLine,
  Save,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Task,
} from "fhir/r4";

import { useSmartSession } from "@/auth/SmartContext";
import FormRenderer from "@/components/FormRenderer";
import PatientPicker from "@/components/PatientPicker";
import RawAnswers from "@/components/RawAnswers";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import WriteBackPanel from "@/components/WriteBackPanel";
import { buildAmendment } from "@/fhir/amend";
import { extractFromResponse, extractMechanism } from "@/fhir/extract";
import { patientDetailsFromAnswers } from "@/fhir/newPatient";
import {
  NO_DESTINATION_MESSAGE,
  attachSubject,
  declaredEndpoints,
  referenceResolves,
  resolveDestinations,
  submitResponse,
  type PublishedTaskOutcome,
  type SubmitOutcome,
  submitAmendment,
  type SavedResponse,
  type SubmitResult,
} from "@/fhir/submit";
import {
  submitExtractedBundle,
  type BundleWriteResult,
} from "@/fhir/writeBundle";
import { useConfig } from "@/lib/configContextValue";
import { describeEntries, filterBundle } from "@/lib/extractedEntries";
import { FHIR_PROXY_BASE, isSessionEnded, useSession } from "@/lib/session";
import { taskCorrelationId, taskFormLabel } from "@/link/exchange";
import Connect from "@/routes/Connect";

export interface ReviewResponseProps {
  /**
   * The form these answers were given against, when it could be resolved.
   *
   * Optional because a response cites whatever canonical the app that wrote it used, and on a
   * shared server that is often a form this deployment's catalogue does not hold. The answers are
   * the clinical content; the definition is presentation, so losing the latter degrades the display
   * without blocking the review.
   */
  questionnaire?: Questionnaire;
  /** Why the form could not be resolved, when it could not. */
  questionnaireError?: string;
  response: QuestionnaireResponse;
  /**
   * The request Task that came back with the answers, when the filler returned one.
   *
   * Read for three things beyond completing the request on save: the correlation id the review
   * screen shows, the form the answers were given against when they do not say themselves, and -
   * because it is the requester's own invitation Task come back - the patient the request was
   * addressed to.
   */
  task?: Task;
  /** Attribution that arrived with the answers, when the filler sent any. */
  provenance?: Provenance;
  label?: string;
  /**
   * Where these answers already are, when they are already on the server.
   *
   * Set for the walk-in queue and for nothing else. Answers arriving on a link are content this
   * app has never stored, so accepting them is a create. Answers from a printed code reached the
   * practice the moment they were sent - untriaged, tagged, and belonging to nobody - so accepting
   * them is an **update of what is already there**, not a second copy with a subject on it.
   *
   * Two other things follow from it. The patient search is pinned to this server, because a subject
   * reference is only worth anything on the server holding the response. And the save removes the
   * walk-in tag, which is what takes the item out of the queue.
   */
  savedAs?: SavedResponse;
  /**
   * Whether the reviewer may register a patient who is not on the server yet.
   *
   * Off by default, because the usual review is of answers a practice asked a patient it already
   * knows for, and offering to create a second record for them is a way to end up with one. A
   * walk-in turns it on: nobody has ever heard of the person who scanned the poster, so
   * registering them is the expected outcome rather than a mistake.
   */
  allowPatientCreation?: boolean;
  /**
   * Called once the answers have landed somewhere.
   *
   * For the collect-reply flow, which does keep a browser-local record of what it sent and needs to
   * mark it collected. Note what this is *not*: the review no longer reads that record to work out
   * who the answers are about - it reads the request Task that came back with them, which is the
   * requester's own invitation and works on any device.
   */
  onSaved?: () => void;
}

/**
 * Whether the response carries a patient-asserted security label.
 * @param response
 */
function isPatientAsserted(response: QuestionnaireResponse): boolean {
  return (response.meta?.security ?? []).some(
    (coding) => coding.code === "PATAST",
  );
}

/**
 * How the four request outcomes are headed on screen.
 *
 * Each one is a distinct thing to have happened, and none of them may be dressed up as another:
 * `unchanged` in particular must not read as a completion, because the clinic decided that Task
 * and these answers did not change it.
 */
const REQUEST_OUTCOME_TITLES: Record<PublishedTaskOutcome["kind"], string> = {
  completed: "Request marked completed",
  unchanged: "Request left as it was",
  skipped: "No request was marked completed",
  failed: "Request not marked completed",
};

/**
 * The requester's side: answers came back, so show them for review and write them on acceptance.
 *
 * The form is rendered **read-only** on purpose. Editing another party's answers before committing
 * them would blur who recorded what, and the response's `author`/`source` would no longer describe
 * the document.
 *
 * This human step is what keeps the whole design inside the specs: SMART Health Links have no
 * submission channel, so nothing was pushed here. The payload was published, this app pulled it, and
 * a person decides whether it enters the record.
 *
 * Everything this screen knows about the request comes off the returned Task. There is no
 * browser-local record of the mint to consult - minting is a server operation (FR-011) - and the
 * Task is a better source than one anyway: it is the requester's own invitation Task come back, so
 * a request sent from a colleague's machine reads here exactly like one sent from this one.
 * @param props
 * @author John Grimes
 */
export default function ReviewResponse(props: ReviewResponseProps) {
  const {
    questionnaire,
    questionnaireError,
    response,
    task,
    provenance,
    label,
    savedAs,
    allowPatientCreation,
    onSaved,
  } = props;
  const config = useConfig();
  /*
   * The session names the server this write lands on. Two things need it: the request Task this
   * acceptance completes lives there, so the write has to be told which server "there" is, and the
   * screen has to name it rather than showing `/api/fhir`, which is this app's own plumbing and
   * means nothing to the person reading it.
   */
  const sessionState = useSession();
  const session =
    sessionState.kind === "active" ? sessionState.session : undefined;

  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  /*
   * Separate from `error`, because it is not one: nothing about the answers is wrong, and the
   * remedy is a launch rather than a correction.
   */
  const [sessionEnded, setSessionEnded] = useState(false);

  /*
   * Patient reconciliation. A response from a third-party filler names a patient in *that* app's terms
   * (Platypus sends its own local vault key) and a server enforcing referential integrity rejects the
   * entire write with `HAPI-1094`. Probing first turns a confusing failure after the fact into a
   * question the reviewer can actually answer.
   */
  const [probe, setProbe] = useState<{
    destination: string;
    reference: string;
    result: "resolves" | "missing" | "unknown";
  } | null>(null);
  const [subjectOverride, setSubjectOverride] = useState("");
  /** Name of the patient chosen, when one was chosen rather than typed. Empty for a hand-typed reference. */
  const [subjectOverrideDisplay, setSubjectOverrideDisplay] = useState("");
  const [clearSubject, setClearSubject] = useState(false);

  /*
   * Amendment. The received answers are stored exactly as they arrived and are never edited - see
   * `src/fhir/amend.ts` for why that is a decision rather than an omission. Changing something means
   * writing a *second* response authored by the reviewer, joined to the first by a Provenance.
   */
  const [isAmending, setIsAmending] = useState(false);
  /*
   * The response the editable form is seeded from, snapshotted when amending starts.
   *
   * Held in state rather than computed during render because the renderer compares its response
   * **by reference**: handing it a freshly-built object each render rebuilds the form in a loop and
   * throws away every keystroke the reviewer has made.
   */
  const [amendSeed, setAmendSeed] = useState<QuestionnaireResponse | null>(
    null,
  );
  const smartSession = useSmartSession();

  /*
   * Who the amendment is attributed to.
   *
   * Seeded from the launched user when there is one, and from `senderName` otherwise. The field
   * stays editable in both cases: it is a display name, and `amenderReference` carries the identity
   * the server actually vouched for, so editing this changes what is readable, never what is
   * claimed.
   */
  const [amender, setAmender] = useState(
    smartSession?.userDisplay ?? config.senderName ?? "",
  );
  /*
   * Applied once the name arrives rather than at mount, because the session is fetched. Guarded on
   * the field still holding its seeded default: a reviewer who has started typing owns the field
   * from then on, and overwriting their edit when a background read lands would be maddening.
   */
  const seededAmender = useRef(config.senderName ?? "");
  useEffect(() => {
    const launched = smartSession?.userDisplay;
    if (launched && amender === seededAmender.current) {
      setAmender(launched);
      seededAmender.current = launched;
    }
  }, [smartSession?.userDisplay, amender]);
  const [amendResults, setAmendResults] = useState<SubmitResult[] | null>(null);
  const [amendedResponse, setAmendedResponse] =
    useState<QuestionnaireResponse | null>(null);
  const [amendError, setAmendError] = useState<string | null>(null);
  const [isAmendSaving, setIsAmendSaving] = useState(false);
  /** Bumped on every mode change, to remount the renderer rather than mutate its singleton stores. */
  const [formEpoch, setFormEpoch] = useState(0);
  const [writeResults, setWriteResults] = useState<BundleWriteResult[] | null>(
    null,
  );

  /**
   * What to call a destination on screen. Never the internal proxy path.
   * @param destination
   */
  function destinationName(destination: string): string {
    if (destination !== FHIR_PROXY_BASE) {
      return destination;
    }

    return session === undefined
      ? "the launched server"
      : `${session.issuerLabel} - ${session.issuer}`;
  }

  const destinations = resolveDestinations({
    questionnaire,
    responseServerUrl: FHIR_PROXY_BASE,
  });
  const isFormDeclared =
    questionnaire !== undefined && declaredEndpoints(questionnaire).length > 0;
  const canSave = destinations.length > 0;

  const originalSubject = response.subject?.reference;
  // Probed against the first destination only. With several, the reviewer is told which one failed by
  // the write itself; guessing at a reconciliation that satisfies all of them is not this step's job.
  const probeDestination = destinations.at(0);

  /*
   * Derived during render: a result is only reported against the exact subject and destination it was
   * obtained for, so a stale answer can never be shown, and "nothing to probe" needs no state at all.
   */
  let subjectCheck: "unknown" | "checking" | "resolves" | "missing" = "unknown";
  if (originalSubject && probeDestination !== undefined) {
    subjectCheck =
      probe?.destination === probeDestination &&
      probe.reference === originalSubject
        ? probe.result
        : "checking";
  }

  useEffect(() => {
    if (!originalSubject || probeDestination === undefined) {
      return;
    }

    let cancelled = false;
    const probed = {
      destination: probeDestination,
      reference: originalSubject,
    };

    referenceResolves(probeDestination, originalSubject)
      .then((resolves) => {
        if (!cancelled) {
          setProbe({ ...probed, result: resolves ? "resolves" : "missing" });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProbe({ ...probed, result: "unknown" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [originalSubject, probeDestination]);

  /** The response as it will actually be written, with any reconciliation applied. */
  function reconciledResponse(): QuestionnaireResponse {
    if (clearSubject) {
      const rest = { ...response };
      delete rest.subject;
      return rest;
    }

    const replacement = subjectOverride.trim();
    if (replacement === "") {
      return response;
    }

    /*
     * The display is replaced rather than merged. Whatever the filler wrote described the patient as
     * *their* system knows them, and carrying that name across onto a reference the reviewer has just
     * repointed would label the answers with a name nobody on the destination server chose. A
     * hand-typed reference therefore gets no display at all, which is the honest result.
     */
    return {
      ...response,
      subject:
        subjectOverrideDisplay === ""
          ? { reference: replacement }
          : { reference: replacement, display: subjectOverrideDisplay },
    };
  }

  /**
   * Apply a patient to the answers - from the picker, from the request, or typed in.
   * @param reference
   * @param display
   */
  function chooseSubject(reference: string, display?: string) {
    setSubjectOverride(reference);
    setSubjectOverrideDisplay(display ?? "");
    setClearSubject(false);
  }

  const hasSubject = originalSubject !== undefined;
  const hasReconciliation = clearSubject || subjectOverride.trim() !== "";
  /*
   * Two ways a response arrives unfiled, and both end at the same question. Either it names a patient
   * the destination server does not hold (normal for a third-party filler, and a write that will be
   * rejected) or it names nobody at all, which no server objects to and which quietly files answers
   * against no one. The second is the more dangerous of the two, so it gets asked about just as loudly.
   */
  const needsSubject =
    outcome === null && canSave && (subjectCheck === "missing" || !hasSubject);
  /*
   * Answers already on a server are reconciled against *that* server, whatever the form declares.
   * A questionnaire's own `sdc-questionnaire-endpoint` says where new answers should be sent; it
   * says nothing about where these ones already are, and a subject reference only means something
   * on the server holding the resource it is attached to.
   */
  const searchServer = savedAs?.serverUrl ?? destinations[0];
  /*
   * Who the request was addressed to, offered as a one-click reconciliation.
   *
   * Taken from the returned Task rather than from any record this browser kept, because there is
   * no such record: minting is a server operation (FR-011), and the Task that comes back *is* the
   * requester's own invitation Task, so its `for` still names the patient on the requester's own
   * server. Reading it here is what makes the shortcut work for a request any colleague sent -
   * the browser-local store it replaced could only ever match a request minted in this browser.
   *
   * Offered only when it differs from what the answers already say: repeating a reference the
   * destination has just been shown not to hold is not a reconciliation.
   */
  const requestSubject =
    task?.for?.reference !== undefined && task.for.reference !== originalSubject
      ? { reference: task.for.reference, display: task.for.display }
      : undefined;

  /*
   * Form data extraction - what these answers would put *in the record*, as opposed to what the
   * record says was asked. See `src/fhir/extract.ts`.
   *
   * Gated on config and on the form declaring extraction at all. Most do not, and the panel must be
   * absent rather than empty for those: an empty write-back box reads as "this form found nothing
   * clinically relevant", which is a much stronger claim than "this form has no templates".
   */
  const mechanism = config.enableWriteBack
    ? extractMechanism(questionnaire)
    : null;

  /*
   * Keyed on the *reconciled subject*, not on the response object.
   *
   * Two reasons, and both have bitten this file before. `reconciledResponse()` builds a fresh object
   * every render, so keying on it would re-extract in a loop. And the subject genuinely is an input:
   * extraction files its Conditions against whoever the answers are about, so repointing the patient
   * has to produce a new extraction rather than a stale one aimed at the filler's own local key.
   */
  const {
    data: extraction,
    isPending: isExtracting,
    error: extractError,
  } = useQuery({
    queryKey: [
      "extract",
      questionnaire?.url ?? questionnaire?.id ?? null,
      questionnaire?.version ?? null,
      response.authored ?? null,
      originalSubject ?? null,
      subjectOverride.trim(),
      clearSubject,
    ],
    queryFn: () =>
      extractFromResponse({
        // The reconciled copy, never `response`. A Condition filed against a patient the destination
        // does not hold is exactly the failure the reconciliation step above exists to prevent.
        response: reconciledResponse(),
        questionnaire: questionnaire!,
        originalSubject,
      }),
    enabled: mechanism !== null && questionnaire !== undefined,
    retry: false,
  });

  const extractedRows = useMemo(
    () => (extraction ? describeEntries(extraction.bundle) : []),
    [extraction],
  );

  /*
   * `null` means "nothing chosen yet", which renders as everything chosen.
   *
   * The extraction the choice was made against is stored beside it, and the choice is *derived*
   * rather than reset: a selection made for the previous patient's entries must not survive into the
   * new ones, and comparing here does that with no effect to race the render.
   */
  const [selection, setSelection] = useState<{
    source: unknown;
    entries: Set<number> | null;
  }>({ source: undefined, entries: null });
  const selectedEntries =
    selection.source === extraction ? selection.entries : null;
  const setSelectedEntries = (entries: Set<number> | null): void => {
    setSelection({ source: extraction, entries });
  };

  const selectedWriteBack = useMemo(
    () => selectedEntries ?? new Set(extractedRows.map((row) => row.index)),
    [selectedEntries, extractedRows],
  );

  /*
   * What an amendment would revise, per server.
   *
   * Taken from the most recent write, so amending twice chains: the second revises the first rather
   * than reaching back past it to the original.
   */
  const amendTargets: SavedResponse[] = (amendResults ?? outcome?.results ?? [])
    .filter(
      (result): result is SubmitResult & { responseId: string } =>
        result.responseId !== undefined,
    )
    .map((result) => ({
      serverUrl: result.serverUrl,
      responseId: result.responseId,
    }));

  /*
   * Needs the form definition, because an amendment means editing answers and there is nothing to
   * render an editor from without it.
   */
  const canAmend = amendTargets.length > 0 && questionnaire !== undefined;

  /** Write a second response revising what is already stored, rather than editing it. */
  async function handleAmend() {
    if (!questionnaire) {
      return;
    }

    setAmendError(null);
    setIsAmendSaving(true);
    try {
      // The only thing taken from the renderer is the answers; `buildAmendment` carries identity
      // across from the stored original itself.
      const edited = removeEmptyAnswersFromResponse(
        questionnaire,
        getResponse(),
      );
      const original = amendSeed ?? reconciledResponse();
      const recorded = new Date().toISOString();

      const amend = (originalResponseId: string) =>
        buildAmendment({
          original,
          originalResponseId,
          edited,
          amender: amender.trim(),
          // Only when signed in. Naming a reference the server cannot vouch for would be worse than
          // naming none, because it reads as verified identity when it is still just a typed string.
          amenderReference: smartSession?.fhirUser ?? undefined,
          recorded,
        });

      const submitted = await submitAmendment({ saved: amendTargets, amend });
      setAmendResults(submitted);

      if (submitted.some((result) => result.responseId)) {
        // Identical across destinations - only the Provenance's `entity.what` differs by server - so
        // any one of them describes what is now on record.
        setAmendedResponse(amend(amendTargets[0].responseId).response);
        setIsAmending(false);
        setFormEpoch((epoch) => epoch + 1);
        onSaved?.();
      }
    } catch (error_) {
      if (isSessionEnded(error_)) {
        setSessionEnded(true);
        return;
      }
      setAmendError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setIsAmendSaving(false);
    }
  }

  async function handleAccept() {
    setError(null);
    setIsSaving(true);
    try {
      /*
       * Two verbs, one button. Answers this app has never stored are created; answers already on
       * the server are updated where they lie, because they arrived there before anybody knew whose
       * they were. Both end with the same outcome shape, so everything downstream - the write-back
       * phase, the saved list, the amendment offer - is unaware of which one ran.
       */
      const submitted: SubmitOutcome =
        savedAs === undefined
          ? await submitResponse({
              response: reconciledResponse(),
              task,
              provenance,
              questionnaire,
              responseServerUrl: FHIR_PROXY_BASE,
              launchedServer: session
                ? { issuer: session.issuer, label: session.issuerLabel }
                : undefined,
            })
          : {
              results: [
                await attachSubject({
                  saved: savedAs,
                  response: reconciledResponse(),
                }),
              ],
              /*
               * No Task is completed. A walk-in answers the standing request behind a printed
               * code, which serves everybody else who scans it too, so finishing it here would
               * retire the poster on the first person to use it.
               */
              task: {
                kind: "skipped",
                detail:
                  "These answers came from a printed walk-in code, which stays open for the " +
                  "next person, so no request was marked completed.",
              },
            };
      setOutcome(submitted);
      if (submitted.results.some((result) => result.responseId)) {
        onSaved?.();
      }

      /*
       * Write-back is the second phase, and deliberately so.
       *
       * The response goes first because it is the clinical content and the thing the reviewer
       * actually accepted; the extracted resources are a derived convenience. If this half fails the
       * answers are still safely on record, which is why a failure here is reported rather than
       * thrown.
       */
      if (extraction && selectedWriteBack.size > 0) {
        const bundle = filterBundle(extraction.bundle, selectedWriteBack);
        const targets = submitted.results
          .filter((result) => result.responseId)
          .map((result) => result.serverUrl);

        if (targets.length > 0) {
          setWriteResults(
            await Promise.all(
              targets.map((serverUrl) =>
                submitExtractedBundle({ serverUrl, bundle }),
              ),
            ),
          );
        }
      }
    } catch (error_) {
      /*
       * A review takes as long as a person takes to read, and a session can die inside that. The
       * answers are still here and still acceptable - what is missing is the authority to write
       * them - so the honest surface is a launch prompt, not a FHIR error nobody can act on.
       */
      if (isSessionEnded(error_)) {
        setSessionEnded(true);
        return;
      }

      setError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setIsSaving(false);
    }
  }

  if (sessionEnded) {
    return <Connect reason="session-expired" />;
  }

  /*
   * What the answers themselves say about who filled them in, for the registration form to start
   * from rather than have retyped. Derived only where a registration can happen: on the ordinary
   * per-patient review the create form never appears, and the practice already knows who this is.
   */
  const patientSeed = allowPatientCreation
    ? patientDetailsFromAnswers(questionnaire, response)
    : undefined;

  /*
   * Two verbs, so two labels. "Save" is right for answers this app is storing for the first time;
   * a walk-in is already stored, and what the reviewer is doing is deciding whose it is.
   */
  const acceptLabel =
    savedAs === undefined ? "Accept and save" : "Attach and file";

  const saved = outcome?.results.filter((result) => result.responseId) ?? [];
  const failed = outcome?.results.filter((result) => result.error) ?? [];
  const correlationId = taskCorrelationId(task);
  const authoredOn = task?.authoredOn;
  /*
   * Which request these answers belong to, said in the terms the payload actually supports. The
   * correlation id is `Task.identifier`, the only join that survives a round trip through a
   * third-party app, and it is what `/requests` shows beside the same request.
   */
  let requestNote = (
    <>
      {" "}
      Answering request{" "}
      <span className="font-mono text-xs">{correlationId}</span>
      {task?.for?.display ? ` for ${task.for.display}` : ""}
      {authoredOn ? `, sent ${new Date(authoredOn).toLocaleDateString()}` : ""}.
    </>
  );
  if (correlationId === undefined) {
    requestNote = task ? (
      <>
        {" "}
        A request came back with these answers, but it carries no identifier, so
        they cannot be matched to a request.
      </>
    ) : (
      <>
        {" "}
        No Task accompanied these answers, so they cannot be matched to a
        request.
      </>
    );
  }

  /*
   * Where the destination came from, when the questionnaire itself did not declare one. It is the
   * server this session launched from - there is no configured destination any more, and saying
   * there is would send someone looking for a setting that does not exist.
   */
  const launchedSourceNote = questionnaire
    ? "The server you are signed in to; this questionnaire declares no endpoint of its own."
    : "The server you are signed in to. The form definition could not be resolved, so its " +
      "sdc-questionnaire-endpoint, if it declares one, was not consulted.";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Review:{" "}
            {label ??
              questionnaire?.title ??
              taskFormLabel(task) ??
              questionnaire?.id ??
              "answers"}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Completed answers received.
            {requestNote}
          </p>
        </div>

        {outcome === null ? (
          <Button
            onClick={() => {
              void handleAccept();
            }}
            disabled={isSaving || !canSave}
            className="ml-auto"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            {isSaving ? "Saving…" : acceptLabel}
          </Button>
        ) : null}
      </div>

      {isPatientAsserted(response) ? (
        <Alert title="Patient-asserted answers">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck
              className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400"
              aria-hidden
            />
            These answers are labelled{" "}
            <span className="font-mono text-xs">PATAST</span> - recorded by the
            person themselves rather than by a clinician.
          </span>
          <p className="mt-1">
            The label {provenance ? "and its Provenance are" : "is"} preserved
            on save, so the record keeps who said this.
          </p>
        </Alert>
      ) : null}

      {outcome === null && !canSave ? (
        <Alert tone="warning" title="Nowhere to save this">
          {NO_DESTINATION_MESSAGE}
        </Alert>
      ) : null}

      {needsSubject ? (
        <Alert
          tone="warning"
          title={
            hasSubject
              ? "This patient does not exist on the destination server"
              : "These answers do not say who they are about"
          }
        >
          {hasSubject ? (
            <p>
              The answers name{" "}
              <span className="font-mono text-xs">{originalSubject}</span>,
              which <strong>{destinationName(searchServer)}</strong> does not
              hold. A filler identifies the patient in its own terms, so this is
              expected for answers from another app - but the write will be
              rejected until it is reconciled.
            </p>
          ) : (
            <p>
              No subject came back with them. Nothing on{" "}
              <strong>{destinationName(searchServer)}</strong> will refuse that,
              which is the problem: the answers would be filed against nobody
              and stay that way. Search for who they belong to.
            </p>
          )}
          <div className="mt-2 space-y-3">
            {requestSubject ? (
              <p>
                The request these answers came back for was addressed to{" "}
                <span className="font-mono text-xs">
                  {requestSubject.reference}
                </span>
                {requestSubject.display ? ` (${requestSubject.display})` : ""},
                on the server you are signed in to.{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-slate-900 dark:hover:text-slate-200"
                  onClick={() =>
                    chooseSubject(
                      requestSubject.reference,
                      requestSubject.display,
                    )
                  }
                >
                  Use that patient
                </button>
                .
              </p>
            ) : null}

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-800 dark:text-slate-200">
                Search <strong>{destinationName(searchServer)}</strong>
              </p>
              {/*
               * Searched on the destination server rather than on `responseServerUrl`, because a
               * questionnaire declaring its own sdc-questionnaire-endpoint sends the write somewhere
               * else - and a reference is only worth anything on the server it will be stored on.
               */}
              <PatientPicker
                serverUrl={searchServer}
                selectedReference={
                  subjectOverride.trim() === ""
                    ? undefined
                    : subjectOverride.trim()
                }
                onChoose={(chosen) =>
                  chooseSubject(chosen.reference, chosen.display)
                }
                allowCreate={allowPatientCreation}
                seed={patientSeed}
                label={
                  allowPatientCreation
                    ? "Find the patient these answers are about, or register them"
                    : "Search the destination server for the patient these answers are about"
                }
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="block text-xs font-medium text-slate-800 dark:text-slate-200"
                htmlFor="subject-override"
              >
                Or enter a reference on that server by hand
              </label>
              <Input
                id="subject-override"
                value={subjectOverride}
                onChange={(event) => chooseSubject(event.target.value)}
                placeholder="Patient/123"
                aria-label={
                  hasSubject
                    ? "Replacement subject reference"
                    : "Subject reference for these answers"
                }
              />
            </div>

            {subjectOverrideDisplay === "" ? null : (
              <p className="text-xs">
                Will be filed against <strong>{subjectOverrideDisplay}</strong>{" "}
                - <span className="font-mono">{subjectOverride}</span>.
              </p>
            )}

            {hasSubject ? (
              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={clearSubject}
                  onChange={(event) => {
                    setClearSubject(event.target.checked);
                    if (event.target.checked) {
                      setSubjectOverride("");
                      setSubjectOverrideDisplay("");
                    }
                  }}
                  className="mt-0.5"
                />
                <span>
                  Save without a subject instead. The answers will be stored{" "}
                  <strong>with no record of who they are about</strong>, which
                  is rarely what you want - matching the patient is a clinical
                  decision, not a technical one.
                </span>
              </label>
            ) : null}
          </div>
          {hasReconciliation ? null : (
            <p className="mt-2">
              {hasSubject
                ? "Saving now will attempt the write as-is and report the rejection."
                : "Saving now will store the answers with no record of who they are about."}
            </p>
          )}
        </Alert>
      ) : null}

      {outcome === null && canSave ? (
        <Alert
          title={`Will be saved to ${destinations.length > 1 ? "these servers" : "this server"}`}
        >
          <ul className="space-y-0.5">
            {destinations.map((destination) => (
              <li key={destination} className="text-xs">
                {destinationName(destination)}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {isFormDeclared
              ? "Declared by the questionnaire itself via sdc-questionnaire-endpoint."
              : launchedSourceNote}
          </p>
        </Alert>
      ) : null}

      {mechanism !== null && isExtracting ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Working out what these answers would put in the record…
        </p>
      ) : null}

      {extractError ? (
        <Alert tone="warning" title="Extraction failed">
          <p>
            {extractError instanceof Error
              ? extractError.message
              : "The form's extraction templates could not be applied."}{" "}
            The answers can still be accepted; only the option to write the
            resources they imply onto the record is unavailable.
          </p>
        </Alert>
      ) : null}

      {extraction ? (
        <WriteBackPanel
          mechanism={extraction.mechanism}
          rows={extractedRows}
          issues={extraction.issues}
          selected={selectedWriteBack}
          onSelectedChange={setSelectedEntries}
          disabled={outcome !== null || !canSave}
          results={writeResults}
          isSaving={isSaving}
        />
      ) : null}

      {saved.length > 0 ? (
        <Alert title="Saved">
          <ul className="space-y-0.5">
            {saved.map((result) => {
              const provenanceNote = result.provenanceId
                ? ` · Provenance/${result.provenanceId}`
                : " · Provenance not saved";

              return (
                <li
                  key={result.serverUrl}
                  className="flex items-center gap-1.5"
                >
                  <CheckCircle2
                    className="h-3.5 w-3.5 text-green-600 dark:text-green-400"
                    aria-hidden
                  />
                  <span className="font-mono text-xs">
                    QuestionnaireResponse/{result.responseId}
                    {provenance ? provenanceNote : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </Alert>
      ) : null}

      {/*
       * What became of the request itself, said plainly. The answers landing and the request
       * closing are two separate facts: a screen that reports only the first leaves the reviewer to
       * find out on Sent requests that theirs still reads "awaiting answers".
       */}
      {outcome ? (
        <Alert
          tone={outcome.task.kind === "failed" ? "warning" : "info"}
          title={REQUEST_OUTCOME_TITLES[outcome.task.kind]}
        >
          <p>{outcome.task.detail}</p>
          {outcome.task.taskId ? (
            <p className="mt-1 font-mono text-xs">Task/{outcome.task.taskId}</p>
          ) : null}
        </Alert>
      ) : null}

      {failed.length > 0 ? (
        <Alert tone="error" title="Could not save">
          <ul className="space-y-0.5">
            {failed.map((result) => (
              <li key={result.serverUrl} className="text-xs">
                {destinationName(result.serverUrl)} - {result.error}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {amendError ? (
        <Alert tone="error" title="Could not save the amendment">
          {amendError}
        </Alert>
      ) : null}

      {isAmending ? (
        <Card className="border-slate-400">
          <CardHeader>
            <CardTitle className="text-base">Amending</CardTitle>
            <CardDescription>
              The form below is editable. Saving writes a <strong>new</strong>{" "}
              QuestionnaireResponse with your changes, authored by you, plus a
              Provenance recording that it revises{" "}
              {amendTargets.length > 1
                ? "the stored responses"
                : "the stored response"}
              . Nothing already written is modified or deleted, so the record
              keeps both versions and who wrote each.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <label
                className="block text-xs font-medium text-slate-800 dark:text-slate-200"
                htmlFor="amender"
              >
                Your name
              </label>
              <Input
                id="amender"
                value={amender}
                onChange={(event) => {
                  setAmender(event.target.value);
                }}
                placeholder="Dr Jane Roe"
                aria-label="Name of the person making the amendment"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Required. It becomes the amended response&rsquo;s{" "}
                <span className="font-mono">author</span> and the
                Provenance&rsquo;s agent - an amendment nobody is named for is
                the thing this whole path exists to avoid.
              </p>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              The patient-asserted label is dropped from the amended copy,
              because it would no longer be true of the parts you change. It
              stays on the original, which the Provenance points at.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  void handleAmend();
                }}
                disabled={isAmendSaving || amender.trim() === ""}
              >
                {isAmendSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <FilePlus2 className="h-4 w-4" aria-hidden />
                )}
                {isAmendSaving ? "Saving amendment…" : "Save as amendment"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setIsAmending(false);
                  setAmendError(null);
                  setFormEpoch((epoch) => epoch + 1);
                }}
                disabled={isAmendSaving}
              >
                <X className="h-4 w-4" aria-hidden />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {outcome !== null && !isAmending && canAmend ? (
        <Alert
          title={
            amendResults === null ? "Need to change something?" : "Amend again?"
          }
        >
          <p>
            These answers are stored as they arrived and stay that way - editing
            them in place would file your words under the label and Provenance
            saying the patient asserted them. An amendment is written as a
            separate response authored by you, with a Provenance recording what
            it revises.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => {
              setAmendSeed(amendedResponse ?? reconciledResponse());
              setIsAmending(true);
              setAmendError(null);
              setFormEpoch((epoch) => epoch + 1);
              // `amendResults` is deliberately kept: it is what `amendTargets` reads, so a second
              // amendment revises the first rather than reaching back past it to the original.
            }}
          >
            <PencilLine className="h-3.5 w-3.5" aria-hidden />
            {amendResults === null ? "Amend these answers" : "Amend again"}
          </Button>
        </Alert>
      ) : null}

      {outcome !== null && saved.length > 0 && !questionnaire ? (
        <Alert title="These cannot be amended here">
          Amending means editing the answers, and the form definition could not
          be resolved - so there is nothing to render an editor from. The stored
          response can still be amended by any app that can resolve the
          questionnaire.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" title="Could not save">
          {error}
        </Alert>
      ) : null}

      {questionnaire ? (
        <div className="form-surface">
          <FormRenderer
            key={`${isAmending ? "edit" : "view"}-${formEpoch}`}
            questionnaire={questionnaire}
            questionnaireResponse={
              isAmending
                ? (amendSeed ?? response)
                : (amendedResponse ?? response)
            }
            terminologyServerUrl={config.terminologyServerUrl}
            readOnly={!isAmending}
          />
        </div>
      ) : (
        <>
          <Alert
            tone="warning"
            title="The form definition could not be resolved"
          >
            <p>
              {questionnaireError ??
                "The form these answers were given against could not be found."}{" "}
              That is common for answers from another app - a response cites
              whatever canonical the app that wrote it used. The answers are
              shown as stored instead, and can still be saved: they are the
              clinical content, and the definition is presentation.
            </p>
          </Alert>
          <RawAnswers response={response} />
        </>
      )}
    </div>
  );
}
