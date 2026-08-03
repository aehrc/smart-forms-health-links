import { useState } from 'react';
import { CheckCircle2, Loader2, Save } from 'lucide-react';
import type { Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { useConfig } from '@/lib/ConfigContext';
import {
  NO_DESTINATION_MESSAGE,
  declaredEndpoints,
  resolveDestinations,
  submitResponse,
  type SubmitResult
} from '@/fhir/submit';
import { taskCorrelationId } from '@/link/exchange';
import FormRenderer from '@/components/FormRenderer';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

export interface ReviewResponseProps {
  questionnaire: Questionnaire;
  response: QuestionnaireResponse;
  task?: Task;
  label?: string;
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
  const { questionnaire, response, task, label } = props;
  const config = useConfig();

  const [results, setResults] = useState<SubmitResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const destinations = resolveDestinations({
    questionnaire,
    responseServerUrl: config.responseServerUrl
  });
  const isFormDeclared = declaredEndpoints(questionnaire).length > 0;
  const canSave = destinations.length > 0;

  async function handleAccept() {
    setError(null);
    setIsSaving(true);
    try {
      setResults(
        await submitResponse({
          response,
          task,
          questionnaire,
          responseServerUrl: config.responseServerUrl
        })
      );
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
            Review: {label ?? questionnaire.title ?? questionnaire.id}
          </h1>
          <p className="text-sm text-slate-500">
            Completed answers received.
            {correlationId ? (
              <>
                {' '}
                Request <span className="font-mono text-xs">{correlationId}</span>
              </>
            ) : (
              ' No Task accompanied these answers, so they cannot be matched to a request.'
            )}
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

      {results === null && !canSave ? (
        <Alert tone="warning" title="Nowhere to save this">
          {NO_DESTINATION_MESSAGE}
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
              : 'From app configuration; this questionnaire does not declare an endpoint.'}
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

      <div className="form-surface">
        <FormRenderer
          questionnaire={questionnaire}
          questionnaireResponse={response}
          terminologyServerUrl={config.terminologyServerUrl}
          readOnly
        />
      </div>
    </div>
  );
}
