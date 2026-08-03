import { useState } from 'react';
import { useLocation, Link as RouterLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Link2, Loader2 } from 'lucide-react';
import type { Questionnaire, QuestionnaireResponse } from 'fhir/r4';
import { fetchQuestionnaireByCanonical } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { LINK_CODECS } from '@/link/registry';
import { decodingCodec, questionnaireCanonical, responseFromBundle } from '@/link/codec';
import { createLinkFromCurrentForm } from '@/link/createLink';
import FormRenderer from '@/components/FormRenderer';
import ShareLinkPanel from '@/components/ShareLinkPanel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

interface ResolvedLink {
  questionnaire: Questionnaire;
  response: QuestionnaireResponse;
  label?: string;
}

/**
 * Decode the fragment, then resolve the Questionnaire it references from the forms server.
 *
 * The link carries answers by value and the form by reference, so opening one always needs a round
 * trip to the forms server. That is the trade that keeps the payload inside a QR code.
 */
async function resolveLink(
  fragment: string,
  formsServerUrl: string,
  signal?: AbortSignal
): Promise<ResolvedLink> {
  const codec = decodingCodec(fragment, LINK_CODECS);
  const content = await codec.decode(fragment);
  const response = responseFromBundle(content.bundle);
  const canonical = questionnaireCanonical(response);
  const questionnaire = await fetchQuestionnaireByCanonical(formsServerUrl, canonical, signal);

  return { questionnaire, response, label: content.label };
}

export default function ViewLink() {
  const location = useLocation();
  const config = useConfig();

  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // `location.hash` includes the leading '#'; the codecs strip it.
  const fragment = location.hash;

  const {
    data: resolved,
    isPending,
    error
  } = useQuery({
    queryKey: ['link', config.formsServerUrl, fragment],
    queryFn: ({ signal }) => resolveLink(fragment, config.formsServerUrl, signal),
    enabled: fragment !== '',
    retry: false
  });

  async function handleCreateLink() {
    if (!resolved) {
      return;
    }

    setLinkError(null);
    try {
      setLink(await createLinkFromCurrentForm(resolved.questionnaire, config));
    } catch (cause) {
      setLink(null);
      setLinkError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (fragment === '') {
    return (
      <Alert title="No link to open">
        This page renders a form from a link. Scan a QR code or open a link that has a payload in
        its fragment.
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
        <RouterLink
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          All forms
        </RouterLink>
      </div>
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
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {resolved.label ?? resolved.questionnaire.title ?? resolved.questionnaire.id}
          </h1>
          <p className="text-sm text-slate-500">Opened from a link, with answers restored.</p>
        </div>
        <Button onClick={handleCreateLink} className="ml-auto">
          <Link2 className="h-4 w-4" aria-hidden />
          Create updated link
        </Button>
      </div>

      {linkError ? (
        <Alert tone="error" title="Could not create link">
          {linkError}
        </Alert>
      ) : null}

      {link ? <ShareLinkPanel link={link} /> : null}

      <div className="form-surface">
        <FormRenderer
          questionnaire={resolved.questionnaire}
          questionnaireResponse={resolved.response}
          terminologyServerUrl={config.terminologyServerUrl}
        />
      </div>
    </div>
  );
}
