import { useState } from 'react';
import { useParams, Link as RouterLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Link2, Loader2 } from 'lucide-react';
import { fetchQuestionnaireById, isRenderableQuestionnaire } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { canCreateHealthLinks, createResponseLink } from '@/link/createLink';
import FormRenderer from '@/components/FormRenderer';
import ShareLinkPanel from '@/components/ShareLinkPanel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

export default function FillForm() {
  const { questionnaireId } = useParams<{ questionnaireId: string }>();
  const config = useConfig();

  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canHost = canCreateHealthLinks(config);

  const {
    data: questionnaire,
    isPending,
    error
  } = useQuery({
    queryKey: ['questionnaire', config.formsServerUrl, questionnaireId],
    queryFn: ({ signal }) =>
      fetchQuestionnaireById(config.formsServerUrl, questionnaireId!, signal),
    enabled: !!questionnaireId
  });

  async function handleCreateLink() {
    if (!questionnaire) {
      return;
    }

    setLinkError(null);
    setIsCreating(true);
    try {
      // No Task here: this route fills a form directly rather than answering a request, so there is
      // nothing to correlate against.
      setLink(await createResponseLink(questionnaire, config));
    } catch (cause) {
      setLink(null);
      setLinkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsCreating(false);
    }
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading form…
      </p>
    );
  }

  if (error) {
    return (
      <Alert tone="error" title="Could not load form">
        {error instanceof Error ? error.message : String(error)}
      </Alert>
    );
  }

  if (!isRenderableQuestionnaire(questionnaire)) {
    return (
      <Alert tone="warning" title="This form has no items">
        {questionnaire.title ?? questionnaireId} contains no questions, so there is nothing to
        render. It is most likely a sub-questionnaire intended for assembly.
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <RouterLink
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All forms
      </RouterLink>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">
          {questionnaire.title ?? questionnaire.name ?? questionnaire.id}
        </h1>
        <Button
          onClick={handleCreateLink}
          disabled={isCreating || !canHost}
          title={canHost ? undefined : 'Needs blobServerUrl in config.json'}
          className="ml-auto">
          {isCreating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden />
          )}
          {isCreating ? 'Creating…' : 'Create link'}
        </Button>
      </div>

      {!canHost ? (
        <Alert tone="warning" title="Links cannot be created">
          Answers are shared as a SMART Health Link, whose encrypted payload has to be hosted
          somewhere. Set <span className="font-mono text-xs">blobServerUrl</span> in{' '}
          <span className="font-mono text-xs">config.json</span>. The form below still works; there is
          just nowhere to put the result.
        </Alert>
      ) : null}

      {linkError ? (
        <Alert tone="error" title="Could not create link">
          {linkError}
        </Alert>
      ) : null}

      {link ? <ShareLinkPanel link={link} /> : null}

      <div className="form-surface">
        <FormRenderer
          questionnaire={questionnaire}
          terminologyServerUrl={config.terminologyServerUrl}
        />
      </div>
    </div>
  );
}
