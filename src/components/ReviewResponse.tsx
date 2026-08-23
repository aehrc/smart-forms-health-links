import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Save, ShieldCheck } from 'lucide-react';
import type { Provenance, Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import {
  NO_DESTINATION_MESSAGE,
  declaredEndpoints,
  referenceResolves,
  resolveDestinations,
  submitResponse,
  type SubmitResult
} from '@/fhir/submit';
import { taskCorrelationId } from '@/link/exchange';
import type { OutstandingRequest } from '@/lib/requestStore';
import FormRenderer from '@/components/FormRenderer';
import PatientPicker from '@/components/PatientPicker';
import RawAnswers from '@/components/RawAnswers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';

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
    responseServerUrl: config.responseServerUrl
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
    referenceResolves(destinations[0], originalSubject)
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
  const hasReconciliation = clearSubject || subjectOverride.trim() !== '';
  /*
   * Two ways a response arrives unfiled, and both end at the same question. Either it names a patient
   * the destination server does not hold — normal for a third-party filler, and a write that will be
   * rejected — or it names nobody at all, which no server objects to and which quietly files answers
   * against no one. The second is the more dangerous of the two, so it gets asked about just as loudly.
   */
  const needsSubject = results === null && canSave && (subjectCheck === 'missing' || !hasSubject);
  const searchServer = destinations[0];

  async function handleAccept() {
    setError(null);
    setIsSaving(true);
    try {
      const submitted = await submitResponse({
        response: reconciledResponse(),
        task,
        provenance,
        questionnaire,
        responseServerUrl: config.responseServerUrl
      });
      setResults(submitted);
      if (submitted.some((result) => result.responseId)) {
        onSaved?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  const saved = results?.filter((result) => result.responseId) ?? [];
  const failed = results?.filter((result) => result.error) ?? [];
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
          </p>
        </div>

        {results === null ? (
          <Button onClick={handleAccept} disabled={isSaving || !canSave} className="ml-auto">
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            {isSaving ? 'Saving…' : 'Accept and save'}
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
              The answers name <span className="font-mono text-xs">{originalSubject}</span>, which{' '}
              <span className="font-mono text-xs">{searchServer}</span> does not hold. A filler
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
              />
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
          <FormRenderer
            questionnaire={questionnaire}
            questionnaireResponse={response}
            terminologyServerUrl={config.terminologyServerUrl}
            readOnly
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
