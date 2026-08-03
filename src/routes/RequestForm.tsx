import { useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Send } from 'lucide-react';
import { fetchQuestionnaireById, isRenderableQuestionnaire } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { canCreateHealthLinks, createRequestLink } from '@/link/createLink';
import { taskCorrelationId } from '@/link/exchange';
import ShareLinkPanel from '@/components/ShareLinkPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Create a "please fill this in" SMART Health Link for a form.
 *
 * The Questionnaire is embedded in the encrypted payload, so whoever scans this needs no access to
 * the forms server. The link itself stays a few hundred bytes because it carries only a URL and a
 * decryption key.
 */
export default function RequestForm() {
  const { questionnaireId } = useParams<{ questionnaireId: string }>();
  const config = useConfig();

  const [subject, setSubject] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canHost = canCreateHealthLinks(config);

  const {
    data: questionnaire,
    isPending,
    error: loadError
  } = useQuery({
    queryKey: ['questionnaire', config.formsServerUrl, questionnaireId],
    queryFn: ({ signal }) =>
      fetchQuestionnaireById(config.formsServerUrl, questionnaireId!, signal),
    enabled: !!questionnaireId
  });

  async function handleCreate() {
    if (!questionnaire) {
      return;
    }

    setError(null);
    setIsCreating(true);
    try {
      const created = await createRequestLink(questionnaire, config, {
        subjectReference: subject.trim() === '' ? undefined : subject.trim()
      });
      setLink(created.link);
      setCorrelationId(taskCorrelationId(created.task));
    } catch (cause) {
      setLink(null);
      setError(cause instanceof Error ? cause.message : String(cause));
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

  if (loadError) {
    return (
      <Alert tone="error" title="Could not load form">
        {loadError instanceof Error ? loadError.message : String(loadError)}
      </Alert>
    );
  }

  if (!isRenderableQuestionnaire(questionnaire)) {
    return (
      <Alert tone="warning" title="This form has no items">
        {questionnaire.title ?? questionnaireId} contains no questions, so there is nothing to
        request.
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

      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Request: {questionnaire.title ?? questionnaire.name ?? questionnaire.id}
        </h1>
        <p className="text-sm text-slate-500">
          Creates an encrypted SMART Health Link containing this whole form.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who is this for?</CardTitle>
          <CardDescription>
            Optional. A FHIR reference such as <span className="font-mono text-xs">Patient/123</span>,
            recorded on the Task so the answers can be matched to a person.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Patient/123"
            aria-label="Subject reference"
          />
          <Button onClick={handleCreate} disabled={isCreating || !canHost}>
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {isCreating ? 'Encrypting and uploading…' : 'Create request link'}
          </Button>
        </CardContent>
      </Card>

      {!canHost ? (
        <Alert tone="warning" title="Nowhere to host the encrypted payload">
          Set <span className="font-mono text-xs">blobServerUrl</span> in{' '}
          <span className="font-mono text-xs">config.json</span>. It deliberately does not default to
          the forms server, which is a read-only catalogue of questionnaires rather than somewhere to
          put transactional data.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error" title="Could not create the request">
          {error}
        </Alert>
      ) : null}

      {link ? (
        <>
          {correlationId ? (
            <Alert title="Request reference">
              Keep this to match the answers when they come back:{' '}
              <span className="font-mono text-xs">{correlationId}</span>
            </Alert>
          ) : null}
          <ShareLinkPanel link={link} kind="request" />
        </>
      ) : null}
    </div>
  );
}
