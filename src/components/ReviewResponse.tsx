import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FilePlus2, Loader2, PencilLine, Save, ShieldCheck, X } from 'lucide-react';
import { getResponse, removeEmptyAnswersFromResponse } from '@aehrc/smart-forms-renderer';
import type { Provenance, Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import { useSmartSession } from '@/auth/SmartContext';
import { fetchUserDisplay } from '@/fhir/ehrServer';
import {
  NO_DESTINATION_MESSAGE,
  declaredEndpoints,
  referenceResolves,
  resolveDestinations,
  submitAmendment,
  submitResponse,
  type SavedResponse,
  type SubmitResult
} from '@/fhir/submit';
import { buildAmendment } from '@/fhir/amend';
import { extractFromResponse, extractMechanism } from '@/fhir/extract';
import { submitExtractedBundle, type BundleWriteResult } from '@/fhir/writeBundle';
import { describeEntries, filterBundle } from '@/lib/extractedEntries';
import WriteBackPanel from '@/components/WriteBackPanel';
import { taskCorrelationId } from '@/link/exchange';
import type { OutstandingRequest } from '@/lib/requestStore';
import FormRenderer from '@/components/FormRenderer';
import PatientPicker from '@/components/PatientPicker';
import RawAnswers from '@/components/RawAnswers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
  task?: Task;
  /** Attribution that arrived with the answers, when the filler sent any. */
  provenance?: Provenance;
  /** The local request these answers came back for, when they match one this browser sent. */
  matchedRequest?: OutstandingRequest;
  label?: string;
  /** Called once the response has been written somewhere. */
  onSaved?: () => void;
}

/** Whether the response carries a patient-asserted security label. */
function isPatientAsserted(response: QuestionnaireResponse): boolean {
  return (response.meta?.security ?? []).some((coding) => coding.code === 'PATAST');
}

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
 */
export default function ReviewResponse(props: ReviewResponseProps) {
  const {
    questionnaire,
    questionnaireError,
    response,
    task,
    provenance,
    matchedRequest,
    label,
    onSaved
  } = props;
  const config = useConfig();

  const [results, setResults] = useState<SubmitResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /*
   * Amendment. The received answers are stored exactly as they arrived and are never edited — see
   * `src/fhir/amend.ts` for why that is a decision rather than an omission. Changing something means
   * writing a *second* response authored by the reviewer, joined to the first by a Provenance.
   */
  const [isAmending, setIsAmending] = useState(false);
  /*
   * The response the editable form is seeded from, snapshotted when amending starts.
   *
   * Held in state rather than computed during render because `useBuildForm` compares
   * `questionnaireResponse` **by reference**: handing it a freshly-built object each render rebuilds
   * the form in a loop and throws away every keystroke the reviewer has made.
   */
  const [amendSeed, setAmendSeed] = useState<QuestionnaireResponse | null>(null);
  const session = useSmartSession();

  /*
   * Who the amendment is attributed to.
   *
   * Seeded from the launched user when there is one, and from `senderName` otherwise. The field stays
   * editable in both cases: with no session it is the only way to say who is amending, and with one it
   * is still a display name — `amenderReference` carries the identity the server actually vouched for,
   * so editing this changes what is readable, never what is claimed.
   */
  const [amender, setAmender] = useState(config.senderName ?? '');

  const { data: launchedUserName } = useQuery({
    queryKey: ['fhirUser', session?.serverUrl, session?.fhirUser],
    queryFn: ({ signal }) =>
      fetchUserDisplay(session!.serverUrl, session!.fhirUser!, signal, session),
    enabled: !!session?.fhirUser
  });

  /*
   * Applied once the name arrives rather than at mount, because it is fetched. Guarded on the field
   * still holding its seeded default: a reviewer who has started typing owns the field from then on,
   * and overwriting their edit when a background fetch lands would be maddening.
   */
  const seededAmender = useRef(config.senderName ?? '');
  useEffect(() => {
    if (launchedUserName && amender === seededAmender.current) {
      setAmender(launchedUserName);
      seededAmender.current = launchedUserName;
    }
  }, [launchedUserName, amender]);
  const [amendResults, setAmendResults] = useState<SubmitResult[] | null>(null);
  const [amendedResponse, setAmendedResponse] = useState<QuestionnaireResponse | null>(null);
  const [amendError, setAmendError] = useState<string | null>(null);
  const [isAmendSaving, setIsAmendSaving] = useState(false);
  /** Bumped on every mode change, to remount the renderer rather than mutate its singleton stores. */
  const [formEpoch, setFormEpoch] = useState(0);

  /*
   * Patient reconciliation. A response from a third-party filler names a patient in *that* app's terms
   * — Platypus sends its own local vault key — and a server enforcing referential integrity rejects the
   * entire write with `HAPI-1094`. Probing first turns a confusing failure after the fact into a
   * question the reviewer can actually answer.
   */
  const [subjectCheck, setSubjectCheck] = useState<'unknown' | 'checking' | 'resolves' | 'missing'>(
    'unknown'
  );
  const [subjectOverride, setSubjectOverride] = useState('');
  /** Name of the patient chosen, when one was chosen rather than typed. Empty for a hand-typed reference. */
  const [subjectOverrideDisplay, setSubjectOverrideDisplay] = useState('');
  const [clearSubject, setClearSubject] = useState(false);

  const destinations = resolveDestinations({
    questionnaire,
    responseServerUrl: config.responseServerUrl,
    session
  });
  const isFormDeclared = questionnaire !== undefined && declaredEndpoints(questionnaire).length > 0;
  const canSave = destinations.length > 0;

  const originalSubject = response.subject?.reference;

  useEffect(() => {
    if (!originalSubject || destinations.length === 0) {
      setSubjectCheck('unknown');
      return;
    }

    let cancelled = false;
    setSubjectCheck('checking');

    // Probed against the first destination only. With several, the reviewer is told which one failed by
    // the write itself; guessing at a reconciliation that satisfies all of them is not this step's job.
    referenceResolves(destinations[0], originalSubject, session)
      .then((resolves) => {
        if (!cancelled) {
          setSubjectCheck(resolves ? 'resolves' : 'missing');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubjectCheck('unknown');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [originalSubject, destinations.join('|')]);

  /** The response as it will actually be written, with any reconciliation applied. */
  function reconciledResponse(): QuestionnaireResponse {
    if (clearSubject) {
      const { subject: _subject, ...rest } = response;
      return rest;
    }

    const replacement = subjectOverride.trim();
    if (replacement === '') {
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
        subjectOverrideDisplay === ''
          ? { reference: replacement }
          : { reference: replacement, display: subjectOverrideDisplay }
    };
  }

  /** Apply a patient to the answers — from the picker, from the matched request, or typed in. */
  function chooseSubject(reference: string, display?: string) {
    setSubjectOverride(reference);
    setSubjectOverrideDisplay(display ?? '');
    setClearSubject(false);
  }

  const hasSubject = originalSubject !== undefined;
  /*
   * The name the filler put on the answers, and the only human identification any channel carries —
   * no demographics cross the wire at all. Read here for the first time: `reconciledResponse` still
   * refuses to carry it onto a reference the reviewer repoints, but seeding a box a human checks is a
   * different thing from asserting it, and without it they have nothing to go on but an opaque key.
   */
  const assertedName = response.subject?.display ?? matchedRequest?.subjectDisplay;
  const hasReconciliation = clearSubject || subjectOverride.trim() !== '';
  /*
   * Two ways a response arrives unfiled, and both end at the same question. Either it names a patient
   * the destination server does not hold — normal for a third-party filler, and a write that will be
   * rejected — or it names nobody at all, which no server objects to and which quietly files answers
   * against no one. The second is the more dangerous of the two, so it gets asked about just as loudly.
   */
  const needsSubject = results === null && canSave && (subjectCheck === 'missing' || !hasSubject);
  const searchServer = destinations[0];

  /*
   * Form data extraction — what these answers would put *in the record*, as opposed to what the record
   * says was asked. See `src/fhir/extract.ts`.
   *
   * Gated on config and on the form declaring extraction at all. Most do not, and the panel must be
   * absent rather than empty for those: an empty write-back box reads as "this form found nothing
   * clinically relevant", which is a much stronger claim than "this form has no templates".
   */
  const mechanism = config.enableWriteBack ? extractMechanism(questionnaire) : null;
  const [writeResults, setWriteResults] = useState<BundleWriteResult[] | null>(null);

  /*
   * Keyed on the *reconciled subject*, not on the response object.
   *
   * Two reasons, and both have bitten this file before. `reconciledResponse()` builds a fresh object
   * every render, so keying on it would re-extract in a loop — the same by-reference trap documented
   * at `useBuildForm` above. And the subject genuinely is an input: extraction files its Conditions
   * against whoever the answers are about, so repointing the patient has to produce a new extraction
   * rather than a stale one aimed at the filler's own local key.
   */
  const {
    data: extraction,
    isPending: isExtracting,
    error: extractError
  } = useQuery({
    queryKey: [
      'extract',
      questionnaire?.url ?? questionnaire?.id ?? null,
      questionnaire?.version ?? null,
      response.authored ?? null,
      originalSubject ?? null,
      subjectOverride.trim(),
      clearSubject
    ],
    queryFn: () =>
      extractFromResponse({
        // The reconciled copy, never `response`. A Condition filed against a patient the destination
        // does not hold is exactly the failure the reconciliation step above exists to prevent.
        response: reconciledResponse(),
        questionnaire: questionnaire!,
        originalSubject
      }),
    enabled: mechanism !== null && questionnaire !== undefined,
    retry: false
  });

  const extractedRows = useMemo(
    () => (extraction ? describeEntries(extraction.bundle) : []),
    [extraction]
  );

  /*
   * `null` means "nothing chosen yet", which renders as everything chosen. Holding it that way rather
   * than seeding a Set lets a re-extraction reset the choice without an effect racing the render: a
   * selection made against the previous patient's entries must not survive into the new ones.
   */
  const [selectedEntries, setSelectedEntries] = useState<Set<number> | null>(null);
  useEffect(() => {
    setSelectedEntries(null);
  }, [extraction]);

  const selectedWriteBack = useMemo(
    () => selectedEntries ?? new Set(extractedRows.map((row) => row.index)),
    [selectedEntries, extractedRows]
  );

  async function handleAccept() {
    setError(null);
    setIsSaving(true);
    try {
      const submitted = await submitResponse({
        response: reconciledResponse(),
        task,
        provenance,
        questionnaire,
        responseServerUrl: config.responseServerUrl,
        session
      });
      setResults(submitted);
      if (submitted.some((result) => result.responseId)) {
        onSaved?.();
      }

      /*
       * Write-back is the second phase, and deliberately so.
       *
       * The response goes first because it is the clinical content and the thing the reviewer actually
       * accepted; the extracted resources are a derived convenience. If this half fails the answers are
       * still safely on record, which is why a failure here is reported as a warning rather than thrown
       * — the same ordering and posture smart-forms takes in `RendererSaveAsFinalWriteBackDialog`.
       *
       * Sent only to servers that took the response. Writing a Condition to a server holding no
       * QuestionnaireResponse to explain it would leave a clinical assertion with no provenance at all.
       */
      if (extraction && selectedWriteBack.size > 0) {
        const bundle = filterBundle(extraction.bundle, selectedWriteBack);
        const targets = submitted
          .filter((result) => result.responseId)
          .map((result) => result.serverUrl);

        if (targets.length > 0) {
          setWriteResults(
            await Promise.all(
              targets.map((serverUrl) =>
                submitExtractedBundle({ serverUrl, bundle, session })
              )
            )
          );
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  /**
   * What an amendment would revise, per server.
   *
   * Taken from the most recent write, so amending twice chains: the second revises the first rather
   * than the original. Each entry keeps its own server's id, because a response written to several
   * destinations gets a different id from each and a reference to one means nothing on another.
   */
  const amendTargets: SavedResponse[] = (amendResults ?? results ?? [])
    .filter((result): result is SubmitResult & { responseId: string } => !!result.responseId)
    .map((result) => ({ serverUrl: result.serverUrl, responseId: result.responseId }));

  /*
   * Needs the form definition, because an amendment means editing answers and there is nothing to
   * render without it. The `RawAnswers` fallback is a table, not an editor.
   */
  const canAmend = amendTargets.length > 0 && questionnaire !== undefined;

  async function handleAmend() {
    if (!questionnaire) {
      return;
    }

    setAmendError(null);
    setIsAmendSaving(true);
    try {
      // The only thing taken from the renderer is the answers; `buildAmendment` carries identity
      // across from the stored original itself.
      const edited = removeEmptyAnswersFromResponse(questionnaire, getResponse());
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
          amenderReference: session?.fhirUser ?? undefined,
          recorded
        });

      const submitted = await submitAmendment({ saved: amendTargets, amend, session });
      setAmendResults(submitted);

      if (submitted.some((result) => result.responseId)) {
        // Identical across destinations — only the Provenance's `entity.what` differs by server — so
        // any one of them describes what is now on record.
        setAmendedResponse(amend(amendTargets[0].responseId).response);
        setIsAmending(false);
        setFormEpoch((epoch) => epoch + 1);
        onSaved?.();
      }
    } catch (cause) {
      setAmendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsAmendSaving(false);
    }
  }

  const saved = results?.filter((result) => result.responseId) ?? [];
  const failed = results?.filter((result) => result.error) ?? [];
  const amendSaved = amendResults?.filter((result) => result.responseId) ?? [];
  const amendFailed = amendResults?.filter((result) => result.error) ?? [];
  const correlationId = taskCorrelationId(task);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Review:{' '}
            {label ?? questionnaire?.title ?? matchedRequest?.label ?? questionnaire?.id ?? 'answers'}
          </h1>
          <p className="text-sm text-slate-500">
            Completed answers received.
            {matchedRequest ? (
              <>
                {' '}
                Answering your request <strong>{matchedRequest.label}</strong>
                {matchedRequest.subjectDisplay ? ` for ${matchedRequest.subjectDisplay}` : ''}, sent{' '}
                {new Date(matchedRequest.createdAt).toLocaleDateString()}.
              </>
            ) : (correlationId ? (
              <>
                {' '}
                Request <span className="font-mono text-xs">{correlationId}</span> — not one this
                browser sent, so there is no local record to match it against.
              </>
            ) : (
              ' No Task accompanied these answers, so they cannot be matched to a request.'
            ))}
            {matchedRequest?.prePopulated ? (
              <>
                {' '}
                <strong>This request went out pre-filled</strong> from the record, so an answer here
                may be one the patient left as it stood rather than one they gave. The whole response
                is labelled patient-asserted either way — there is nothing on the wire that separates
                them.
              </>
            ) : null}
          </p>
        </div>

        {results === null ? (
          <Button onClick={handleAccept} disabled={isSaving || !canSave} className="ml-auto">
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            {isSaving
              ? 'Saving…'
              : selectedWriteBack.size > 0
                ? `Accept, save and write back ${selectedWriteBack.size}`
                : 'Accept and save'}
          </Button>
        ) : null}
      </div>

      {isPatientAsserted(response) ? (
        <Alert title="Patient-asserted answers">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-slate-500" aria-hidden />
            These answers are labelled <span className="font-mono text-xs">PATAST</span> — recorded by
            the person themselves rather than by a clinician.
          </span>
          <p className="mt-1">
            The label {provenance ? 'and its Provenance are' : 'is'} preserved on save, so the record
            keeps who said this.
          </p>
        </Alert>
      ) : null}

      {results === null && !canSave ? (
        <Alert tone="warning" title="Nowhere to save this">
          {NO_DESTINATION_MESSAGE}
        </Alert>
      ) : null}

      {needsSubject ? (
        <Alert
          tone="warning"
          title={
            hasSubject
              ? 'This patient does not exist on the destination server'
              : 'These answers do not say who they are about'
          }>
          {hasSubject ? (
            <p>
              The answers name <span className="font-mono text-xs">{originalSubject}</span>
              {response.subject?.display ? (
                <>
                  , described as <strong>{response.subject.display}</strong>
                </>
              ) : null}
              , which <span className="font-mono text-xs">{searchServer}</span> does not hold. A filler
              identifies the patient in its own terms, so this is expected for answers from another app
              — but the write will be rejected until it is reconciled.
            </p>
          ) : (
            <p>
              No subject came back with them. Nothing on{' '}
              <span className="font-mono text-xs">{searchServer}</span> will refuse that, which is the
              problem: the answers would be filed against nobody and stay that way. Search for who
              they belong to.
            </p>
          )}
          <div className="mt-2 space-y-3">
            {matchedRequest?.subjectReference ? (
              <p>
                This request was addressed to{' '}
                <span className="font-mono text-xs">{matchedRequest.subjectReference}</span>
                {matchedRequest.subjectDisplay ? ` (${matchedRequest.subjectDisplay})` : ''}.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-slate-900"
                  onClick={() =>
                    chooseSubject(matchedRequest.subjectReference!, matchedRequest.subjectDisplay)
                  }>
                  Use that patient
                </button>
                .
              </p>
            ) : null}

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-800">
                Search <span className="font-mono">{searchServer}</span>
              </p>
              {/*
                * Searched on the destination server rather than on `responseServerUrl`, because a
                * questionnaire declaring its own sdc-questionnaire-endpoint sends the write somewhere
                * else — and a reference is only worth anything on the server it will be stored on.
                */}
              <PatientPicker
                serverUrl={searchServer}
                selectedReference={subjectOverride.trim() === '' ? undefined : subjectOverride.trim()}
                onChoose={(chosen) => chooseSubject(chosen.reference, chosen.display)}
                label="Search the destination server for the patient these answers are about"
                allowCreate
                prefillName={assertedName}
              />
              {destinations.length > 1 ? (
                <p className="text-xs">
                  A patient created here is created on{' '}
                  <span className="font-mono">{searchServer}</span> only. The other destinations will
                  still reject the write — the same best-effort posture the subject probe takes.
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-800" htmlFor="subject-override">
                Or enter a reference on that server by hand
              </label>
              <Input
                id="subject-override"
                value={subjectOverride}
                onChange={(event) => chooseSubject(event.target.value)}
                placeholder="Patient/123"
                aria-label={
                  hasSubject ? 'Replacement subject reference' : 'Subject reference for these answers'
                }
              />
            </div>

            {subjectOverrideDisplay !== '' ? (
              <p className="text-xs">
                Will be filed against <strong>{subjectOverrideDisplay}</strong> —{' '}
                <span className="font-mono">{subjectOverride}</span>.
              </p>
            ) : null}

            {hasSubject ? (
              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={clearSubject}
                  onChange={(event) => {
                    setClearSubject(event.target.checked);
                    if (event.target.checked) {
                      setSubjectOverride('');
                      setSubjectOverrideDisplay('');
                    }
                  }}
                  className="mt-0.5"
                />
                <span>
                  Save without a subject instead. The answers will be stored{' '}
                  <strong>with no record of who they are about</strong>, which is rarely what you want
                  — matching the patient is a clinical decision, not a technical one.
                  {subjectOverrideDisplay !== '' ? (
                    <>
                      {' '}
                      Any patient you just created stays on the server with nothing filed against it.
                    </>
                  ) : null}
                </span>
              </label>
            ) : null}
          </div>
          {!hasReconciliation ? (
            <p className="mt-2">
              {hasSubject
                ? 'Saving now will attempt the write as-is and report the rejection.'
                : 'Saving now will store the answers with no record of who they are about.'}
            </p>
          ) : null}
        </Alert>
      ) : null}

      {results === null && canSave ? (
        <Alert title={`Will be saved to ${destinations.length > 1 ? 'these servers' : 'this server'}`}>
          <ul className="space-y-0.5">
            {destinations.map((destination) => (
              <li key={destination} className="font-mono text-xs">
                {destination}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {isFormDeclared
              ? 'Declared by the questionnaire itself via sdc-questionnaire-endpoint.'
              : (questionnaire
                ? 'From app configuration; this questionnaire does not declare an endpoint.'
                : 'From app configuration. The form definition could not be resolved, so its ' +
                  'sdc-questionnaire-endpoint — if it declares one — was not consulted.')}
          </p>
        </Alert>
      ) : null}

      {mechanism !== null && isExtracting ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Working out what these answers would add to the record…
        </p>
      ) : null}

      {mechanism !== null && extractError ? (
        <Alert tone="warning" title="Could not work out what to write back">
          <p>{extractError instanceof Error ? extractError.message : String(extractError)}</p>
          <p className="mt-1">
            The answers can still be accepted and stored. Only the extra step of turning them into
            resources on the record is unavailable.
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
          disabled={results !== null}
          results={writeResults}
          isSaving={isSaving}
        />
      ) : null}

      {saved.length > 0 ? (
        <Alert title="Saved">
          <ul className="space-y-0.5">
            {saved.map((result) => (
              <li key={result.serverUrl} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
                <span className="font-mono text-xs">
                  QuestionnaireResponse/{result.responseId}
                  {result.taskId ? ` · Task/${result.taskId}` : ' · Task not saved'}
                  {provenance
                    ? (result.provenanceId
                      ? ` · Provenance/${result.provenanceId}`
                      : ' · Provenance not saved')
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {amendSaved.length > 0 ? (
        <Alert title="Amendment saved">
          <ul className="space-y-0.5">
            {amendSaved.map((result) => (
              <li key={result.serverUrl} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
                <span className="font-mono text-xs">
                  QuestionnaireResponse/{result.responseId}
                  {result.provenanceId ? ` · Provenance/${result.provenanceId}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1">
            Written as a new response authored by <strong>{amender.trim()}</strong>. The answers as
            they arrived are untouched, and the Provenance records that this revises them.
          </p>
        </Alert>
      ) : null}

      {(amendResults ?? []).some((result) => result.provenanceError) ? (
        <Alert tone="error" title="The amendment was saved but its Provenance was not">
          <ul className="space-y-0.5">
            {(amendResults ?? [])
              .filter((result) => result.provenanceError)
              .map((result) => (
                <li key={result.serverUrl} className="text-xs">
                  <span className="font-mono">{result.serverUrl}</span> — {result.provenanceError}
                </li>
              ))}
          </ul>
          <p className="mt-1">
            That link is the only thing joining the two resources, so the server now holds an
            amendment and the answers it revises with nothing saying so. Worth fixing by hand.
          </p>
        </Alert>
      ) : null}

      {amendFailed.length > 0 ? (
        <Alert tone="error" title="Could not save the amendment">
          <ul className="space-y-0.5">
            {amendFailed.map((result) => (
              <li key={result.serverUrl} className="text-xs">
                <span className="font-mono">{result.serverUrl}</span> — {result.error}
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
              The form below is editable. Saving writes a <strong>new</strong> QuestionnaireResponse
              with your changes, authored by you, plus a Provenance recording that it revises{' '}
              {amendTargets.length > 1 ? 'the stored responses' : 'the stored response'}. Nothing
              already written is modified or deleted, so the record keeps both versions and who wrote
              each.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-800" htmlFor="amender">
                Your name
              </label>
              <Input
                id="amender"
                value={amender}
                onChange={(event) => setAmender(event.target.value)}
                placeholder="Dr Jane Roe"
                aria-label="Name of the person making the amendment"
              />
              <p className="text-xs text-slate-500">
                Required. It becomes the amended response&rsquo;s <span className="font-mono">author</span>{' '}
                and the Provenance&rsquo;s agent — an amendment nobody is named for is the thing this
                whole path exists to avoid.
              </p>
            </div>

            <p className="text-xs text-slate-500">
              The patient-asserted label is dropped from the amended copy, because it would no longer
              be true of the parts you change. It stays on the original, which the Provenance points
              at.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleAmend} disabled={isAmendSaving || amender.trim() === ''}>
                {isAmendSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <FilePlus2 className="h-4 w-4" aria-hidden />
                )}
                {isAmendSaving ? 'Saving amendment…' : 'Save as amendment'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setIsAmending(false);
                  setAmendError(null);
                  setFormEpoch((epoch) => epoch + 1);
                }}
                disabled={isAmendSaving}>
                <X className="h-4 w-4" aria-hidden />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {results !== null && !isAmending && canAmend ? (
        <Alert title={amendResults === null ? 'Need to change something?' : 'Amend again?'}>
          <p>
            These answers are stored as they arrived and stay that way — editing them in place would
            file your words under the label and Provenance saying the patient asserted them. An
            amendment is written as a separate response authored by you, with a Provenance recording
            what it revises.
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
            }}>
            <PencilLine className="h-3.5 w-3.5" aria-hidden />
            {amendResults === null ? 'Amend these answers' : 'Amend again'}
          </Button>
        </Alert>
      ) : null}

      {results !== null && saved.length > 0 && !questionnaire ? (
        <Alert title="These cannot be amended here">
          Amending means editing the answers, and the form definition could not be resolved — so there
          is nothing to render an editor from. The stored response can still be amended by any app
          that can resolve the questionnaire.
        </Alert>
      ) : null}

      {failed.length > 0 ? (
        <Alert tone="error" title="Could not save">
          <ul className="space-y-0.5">
            {failed.map((result) => (
              <li key={result.serverUrl} className="text-xs">
                <span className="font-mono">{result.serverUrl}</span> — {result.error}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" title="Could not save">
          {error}
        </Alert>
      ) : null}

      {questionnaire ? (
        <div className="form-surface">
          {/*
            * Read-only everywhere except an explicit amendment. Keyed so a mode change remounts the
            * renderer: its questionnaire and response stores are module-level singletons, so
            * rebuilding is the supported way to reseed them.
            */}
          <FormRenderer
            key={`${isAmending ? 'edit' : 'view'}-${formEpoch}`}
            questionnaire={questionnaire}
            questionnaireResponse={
              isAmending ? (amendSeed ?? response) : (amendedResponse ?? response)
            }
            terminologyServerUrl={config.terminologyServerUrl}
            readOnly={!isAmending}
          />
        </div>
      ) : (
        <>
          <Alert tone="warning" title="The form definition could not be resolved">
            <p>
              {questionnaireError ??
                'The form these answers were given against could not be found.'}{' '}
              That is common for answers from another app — a response cites whatever canonical the
              app that wrote it used. The answers are shown as stored instead, and can still be
              saved: they are the clinical content, and the definition is presentation.
            </p>
          </Alert>
          <RawAnswers response={response} />
        </>
      )}
    </div>
  );
}
