import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { Questionnaire, QuestionnaireResponse, Task } from 'fhir/r4';
import { fetchQuestionnaireByCanonical } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { LINK_CODECS } from '@/link/registry';
import { decodingCodec, questionnaireCanonical } from '@/link/codec';
import { isRequestBundle, parseRequestBundle, parseResponseBundle } from '@/link/exchange';
import FillFromRequest from '@/components/FillFromRequest';
import ReviewResponse from '@/components/ReviewResponse';
import { Alert } from '@/components/ui/alert';

/**
 * The single entry point for any link, in either direction.
 *
 * Dispatching on the payload rather than the route matters because a scanner cannot know what it just
 * scanned. A request (`Questionnaire` + `Task`, no answers) opens the form to be filled; a response
 * (`QuestionnaireResponse`) opens the review-and-accept flow.
 */

type Opened =
  | { mode: 'request'; questionnaire: Questionnaire; task: Task; label?: string }
  | {
      mode: 'response';
      questionnaire: Questionnaire;
      response: QuestionnaireResponse;
      task?: Task;
      label?: string;
    };

async function openLink(
  fragment: string,
  formsServerUrl: string,
  signal?: AbortSignal
): Promise<Opened> {
  const codec = decodingCodec(fragment, LINK_CODECS);
  const content = await codec.decode(fragment);

  if (isRequestBundle(content.bundle)) {
    // A request embeds its Questionnaire, so nothing needs resolving.
    const { questionnaire, task } = parseRequestBundle(content.bundle);
    return { mode: 'request', questionnaire, task, label: content.label };
  }

  /*
   * A response carries answers by value but the form only by canonical reference — re-sending
   * hundreds of kilobytes of Questionnaire would defeat the point. So the form is resolved here.
   */
  const { response, task } = parseResponseBundle(content.bundle);
  const questionnaire = await fetchQuestionnaireByCanonical(
    formsServerUrl,
    questionnaireCanonical(response),
    signal
  );

  return { mode: 'response', questionnaire, response, task, label: content.label };
}

export default function ViewLink() {
  const location = useLocation();
  const config = useConfig();

  // `location.hash` includes the leading '#'; the codecs strip it.
  const fragment = location.hash;

  const {
    data: opened,
    isPending,
    error
  } = useQuery({
    queryKey: ['link', config.formsServerUrl, fragment],
    queryFn: ({ signal }) => openLink(fragment, config.formsServerUrl, signal),
    enabled: fragment !== '',
    retry: false
  });

  if (fragment === '') {
    return (
      <Alert title="No link to open">
        This page opens a form from a link. Scan a QR code, or paste a link on the Scan page.
      </Alert>
    );
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Opening link…
      </p>
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
      {opened.mode === 'request' ? (
        <FillFromRequest
          questionnaire={opened.questionnaire}
          task={opened.task}
          label={opened.label}
        />
      ) : (
        <ReviewResponse
          questionnaire={opened.questionnaire}
          response={opened.response}
          task={opened.task}
          label={opened.label}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <RouterLink
      to="/"
      className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All forms
    </RouterLink>
  );
}
