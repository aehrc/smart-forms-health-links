import { useEffect, useState } from 'react';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Inbox, Loader2, Send } from 'lucide-react';
import { fetchQuestionnaireById, isRenderableQuestionnaire } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { canUseEncryptedReply, canUseServerReturn } from '@/lib/config';
import { saveRequest } from '@/lib/requestStore';
import { canCreateHealthLinks, createRequestLink } from '@/link/createLink';
import { questionnaireCanonicalOf, taskCorrelationId } from '@/link/exchange';
import PatientPicker from '@/components/PatientPicker';
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
  const [params] = useSearchParams();
  const config = useConfig();

  const [subject, setSubject] = useState('');
  const [subjectDisplay, setSubjectDisplay] = useState('');

  /*
   * The patient picker navigates back here with the chosen patient in the query string. Applied via an
   * effect rather than as initial state so returning from the picker updates the fields on a route that
   * is already mounted.
   */
  const pickedSubject = params.get('subject');
  const pickedDisplay = params.get('subjectDisplay');
  useEffect(() => {
    if (pickedSubject) {
      setSubject(pickedSubject);
    }
    if (pickedDisplay) {
      setSubjectDisplay(pickedDisplay);
    }
  }, [pickedSubject, pickedDisplay]);
  const [link, setLink] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | undefined>();
  /** Whether the request just created actually minted a reply slot, as opposed to config saying it could. */
  const [hadReplySlot, setHadReplySlot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canHost = canCreateHealthLinks(config);
  const serverReturn = canUseServerReturn(config);
  const encryptedReply = canUseEncryptedReply(config);

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
        subjectReference: subject.trim() === '' ? undefined : subject.trim(),
        subjectDisplay: subjectDisplay.trim() === '' ? undefined : subjectDisplay.trim()
      });

      const id = taskCorrelationId(created.task);

      /*
       * Persist before showing the link, and let a storage failure surface as a failure to create.
       * The private key that decrypts the reply exists only here — handing over a QR whose answers
       * could never be read would be worse than not creating the request at all.
       */
      if (id) {
        saveRequest({
          id,
          label: questionnaire.title ?? questionnaire.name ?? questionnaire.id ?? 'Questionnaire',
          questionnaireCanonical: questionnaireCanonicalOf(questionnaire),
          createdAt: new Date().toISOString(),
          expiresAt: created.expiresAt,
          link: created.link,
          subjectDisplay: subjectDisplay.trim() === '' ? undefined : subjectDisplay.trim(),
          // Kept so scanned answers naming a foreign patient can be reconciled in one click.
          subjectReference: subject.trim() === '' ? undefined : subject.trim(),
          reply: created.reply
            ? { url: created.reply.url, privateJwk: created.reply.privateJwk }
            : undefined,
          serverTaskUrl: created.serverTaskUrl,
          serverReturnOffered: created.serverReturnOffered
        });
      }

      setLink(created.link);
      setCorrelationId(id);
      setHadReplySlot(created.reply !== undefined);
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
            Both optional. The reference correlates the answers on your own server; the name is the part
            a filler can actually read, since it cannot resolve a reference into a server it has no
            access to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.responseServerUrl ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-700">
                Search <span className="font-mono">{config.responseServerUrl}</span>
              </p>
              <PatientPicker
                serverUrl={config.responseServerUrl}
                selectedReference={subject.trim() === '' ? undefined : subject.trim()}
                onChoose={(chosen) => {
                  setSubject(chosen.reference);
                  setSubjectDisplay(chosen.display);
                }}
                label="Search patients to address this request to"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-700">
              {config.responseServerUrl ? 'Or enter it by hand' : 'Subject'}
            </p>
            <Input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Patient/123"
              aria-label="Subject reference"
            />
            <Input
              value={subjectDisplay}
              onChange={(event) => setSubjectDisplay(event.target.value)}
              placeholder="Jane Citizen"
              aria-label="Subject name"
            />
          </div>

          {config.responseServerUrl ? (
            <p className="text-xs text-slate-500">
              Or{' '}
              <RouterLink
                to={`/patients?returnTo=${encodeURIComponent(`/request/${questionnaireId ?? ''}`)}`}
                className="underline">
                browse the full patient list
              </RouterLink>
              , which also shows what each one has already answered.
            </p>
          ) : null}

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

      <Alert
        tone={serverReturn ? 'warning' : undefined}
        title={`${serverReturn || encryptedReply ? 'Two' : 'One'} return channel${
          serverReturn || encryptedReply ? 's' : ''
        }`}>
        <ul className="space-y-1">
          <li>
            <strong>Answers come back as a link</strong> — whoever fills this in produces their own
            SMART Health Link and you scan or paste it into{' '}
            <RouterLink to="/scan" className="underline">
              Scan
            </RouterLink>
            . You review the answers, and nothing is written until you accept. Nothing has to be
            arranged in advance, so this needs no setting.
          </li>
          {encryptedReply ? (
            <li>
              <strong>Encrypted reply</strong> — a slot is created alongside the link and the answers
              come back encrypted to a key held only in this browser. You collect them from{' '}
              <RouterLink to="/requests" className="underline">
                Sent requests
              </RouterLink>
              . Useful when whoever fills this in cannot get a QR code back to you.
            </li>
          ) : null}
          <li>
            <strong>Direct write to your server</strong> —{' '}
            {serverReturn ? (
              <>
                enabled. The form will declare{' '}
                <span className="font-mono text-xs">{config.responseServerUrl}</span> via
                sdc-questionnaire-endpoint, so a filler can post answers there itself.{' '}
                <strong>Those arrive unreviewed</strong> — point the endpoint at a staging server if that
                is not what you want.
              </>
            ) : (
              <>
                off. Set <span className="font-mono text-xs">enableServerReturn</span> and{' '}
                <span className="font-mono text-xs">responseServerUrl</span> to offer it.
              </>
            )}
          </li>
        </ul>
        {encryptedReply ? null : (
          <p className="mt-2">
            The encrypted reply channel is off. Set{' '}
            <span className="font-mono text-xs">enableEncryptedReply</span> to offer it as well —
            worth doing when a filler may have no way to show you a QR code.
          </p>
        )}
        {config.senderName ? null : (
          <p className="mt-2">
            No <span className="font-mono text-xs">senderName</span> is configured, so this request
            cannot say who it is from — which is a reason for someone to decline it.
          </p>
        )}
      </Alert>

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
            <Alert title="Saved to Sent requests">
              <p>
                Reference <span className="font-mono text-xs">{correlationId}</span>.{' '}
                {hadReplySlot
                  ? 'The key that decrypts the reply is stored in this browser only — collect it from '
                  : 'When the answers come back, this reference is what matches them to this request. Track it from '}
                <RouterLink to="/requests" className="inline-flex items-center gap-1 underline">
                  <Inbox className="h-3 w-3" aria-hidden />
                  Sent requests
                </RouterLink>
                .
              </p>
            </Alert>
          ) : null}
          <ShareLinkPanel link={link} kind="request" />
        </>
      ) : null}
    </div>
  );
}
