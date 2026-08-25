import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Eye, Inbox, Loader2, Send, Sparkles } from 'lucide-react';
import { fetchQuestionnaireById, isRenderableQuestionnaire } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { useEhrServerUrl, useSmartSession } from '@/auth/SmartContext';
import { fetchPatient, fetchUser, patientDisplay, personDisplay } from '@/fhir/ehrServer';
import {
  canPrePopulate,
  canUseEncryptedReply,
  canUseOneShotWrite,
  canUseServerReturn,
  resolveWriteSlotServerUrl
} from '@/lib/config';
import { prePopulate, questionnaireDeclaresPopulation } from '@/fhir/populate';
import { populatedRows, pruneAnswers } from '@/lib/answerRows';
import { saveRequest } from '@/lib/requestStore';
import { canCreateHealthLinks, createRequestLink } from '@/link/createLink';
import { questionnaireCanonicalOf, taskCorrelationId } from '@/link/exchange';
import PatientPicker from '@/components/PatientPicker';
import PrePopulatePanel from '@/components/PrePopulatePanel';
import FormRenderer from '@/components/FormRenderer';
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

  const session = useSmartSession();
  const ehrServerUrl = useEhrServerUrl();

  const [subject, setSubject] = useState('');
  const [subjectDisplay, setSubjectDisplay] = useState('');

  /*
   * An EHR launch from a chart already knows who the request is for. Looking that patient up and
   * filling both fields is the difference between a launch that means something and one that only
   * changes which server is written to — being made to search for the patient you launched from is
   * exactly the friction the launch exists to remove.
   */
  const launchPatientRef = session?.patientId ? `Patient/${session.patientId}` : null;

  const { data: launchPatient } = useQuery({
    queryKey: ['patient', ehrServerUrl, session?.patientId],
    queryFn: ({ signal }) =>
      fetchPatient(ehrServerUrl!, session!.patientId!, signal, session),
    enabled: !!launchPatientRef && !!ehrServerUrl
  });

  /**
   * The launched user — their name for the invitation, their resource for population.
   *
   * One query for both. SDC's `user` launch context is a `Practitioner` rather than a reference, so
   * pre-population needs the whole resource, and the session badge has always needed the name out of
   * it; fetching twice for the two halves of one resource would be a round trip for nothing.
   */
  const { data: launchedUser } = useQuery({
    queryKey: ['fhirUser-resource', session?.serverUrl, session?.fhirUser],
    queryFn: ({ signal }) => fetchUser(session!.serverUrl, session!.fhirUser!, signal, session),
    enabled: !!session?.fhirUser
  });
  const launchedUserName = personDisplay(launchedUser);

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

  /*
   * The launch context seeds the fields, but only while they are still empty. An explicit choice — a
   * patient picked here, or one carried in the query string — is the clinician overriding the chart
   * they launched from, and a background fetch landing afterwards must not undo that.
   */
  useEffect(() => {
    if (!launchPatientRef || pickedSubject) {
      return;
    }

    setSubject((current) => (current === '' ? launchPatientRef : current));
    if (launchPatient) {
      setSubjectDisplay((current) => (current === '' ? patientDisplay(launchPatient) : current));
    }
  }, [launchPatientRef, launchPatient, pickedSubject]);
  /*
   * Pre-population, and the three pieces of state it needs.
   *
   * `deselected` rather than `selected`, which is not a stylistic choice: the answers arrive
   * asynchronously, and tracking what is *kept* would mean an effect that ticks everything each time
   * the query resolves — racing the clinician's own unticking, and re-ticking a row they had just
   * removed. Tracking what they took away needs no effect at all, and the default falls out of it:
   * nothing removed means everything sent.
   */
  const [prePopulateOn, setPrePopulateOn] = useState(false);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [showPreview, setShowPreview] = useState(false);

  const [link, setLink] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | undefined>();
  /** Whether the request just created actually minted a reply slot, as opposed to config saying it could. */
  const [hadReplySlot, setHadReplySlot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const canHost = canCreateHealthLinks(config);
  const serverReturn = canUseServerReturn(config);
  const encryptedReply = canUseEncryptedReply(config);
  const oneShotWrite = canUseOneShotWrite(config);

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

  const subjectReference = subject.trim() === '' ? undefined : subject.trim();

  /*
   * Populate needs a `Patient` **resource**, and the subject field holds a reference. The launch
   * patient is not a substitute: this route deliberately lets a `PatientPicker` choice override the
   * chart that was launched from, and populating the launched patient's record into a request
   * addressed to somebody else is the worst bug available here.
   */
  const subjectPatientId = /^Patient\/([A-Za-z0-9\-.]{1,64})$/.exec(subjectReference ?? '')?.[1];
  const { data: subjectPatient } = useQuery({
    queryKey: ['patient', ehrServerUrl, subjectPatientId],
    queryFn: ({ signal }) => fetchPatient(ehrServerUrl!, subjectPatientId!, signal, session),
    enabled: !!subjectPatientId && !!ehrServerUrl
  });

  const declaresPopulation = questionnaireDeclaresPopulation(questionnaire);
  const prePopulateAvailable =
    canPrePopulate(config, session, ehrServerUrl) && declaresPopulation && !!subjectPatient;

  const {
    data: populated,
    isFetching: isPopulating,
    error: populateError
  } = useQuery({
    queryKey: ['pre-populate', ehrServerUrl, questionnaireId, subjectPatientId],
    queryFn: ({ signal }) =>
      prePopulate({
        questionnaire: questionnaire!,
        ehrServerUrl: ehrServerUrl!,
        session: session!,
        patient: subjectPatient!,
        ...(launchedUser?.resourceType === 'Practitioner' ? { user: launchedUser } : {}),
        signal
      }),
    enabled: prePopulateOn && prePopulateAvailable && !!questionnaire
  });

  const rows = useMemo(
    () => (populated?.response ? populatedRows(populated.response) : []),
    [populated]
  );

  /*
   * Selection is derived rather than stored, so a row that stops existing — the patient changed, the
   * record moved — cannot leave a stale tick behind that silently keeps an answer in the payload.
   */
  const selected = useMemo(
    () => new Set(rows.map((row) => row.path).filter((path) => !deselected.has(path))),
    [rows, deselected]
  );

  const seed = useMemo(() => {
    if (!populated?.response || selected.size === 0) {
      return undefined;
    }

    return pruneAnswers(populated.response, selected);
  }, [populated, selected]);

  /*
   * Changing who the request is for discards everything chosen about the previous patient. The query
   * key already refetches, but the *ticks* are keyed by path and paths collide across patients — the
   * same form produces the same `linkId`s — so without this a row unticked for one patient stays
   * unticked for the next, and the reason would be invisible.
   */
  useEffect(() => {
    setDeselected(new Set());
    setShowPreview(false);
  }, [subjectPatientId]);

  async function handleCreate() {
    if (!questionnaire) {
      return;
    }

    setError(null);
    setIsCreating(true);
    try {
      const created = await createRequestLink(questionnaire, config, {
        subjectReference,
        subjectDisplay: subjectDisplay.trim() === '' ? undefined : subjectDisplay.trim(),
        session,
        requesterDisplay: launchedUserName ?? undefined,
        // Only what is still ticked, and only while the toggle is on — an untoggled request is blank.
        prePopulated: prePopulateOn ? seed : undefined
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
          subjectReference,
          /*
           * Recorded because the reviewer cannot tell otherwise. "The patient confirmed their
           * medication list" and "the patient never touched the medication list" arrive as the same
           * resource, and only the request knows which one it asked for.
           */
          prePopulated: prePopulateOn && seed !== undefined,
          reply: created.reply
            ? { url: created.reply.url, privateJwk: created.reply.privateJwk }
            : undefined,
          serverTaskUrl: created.serverTaskUrl,
          serverReturnOffered: created.serverReturnOffered,
          write: created.write
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
          {ehrServerUrl ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-slate-700">
                Search <span className="font-mono">{ehrServerUrl}</span>
              </p>
              <PatientPicker
                serverUrl={ehrServerUrl}
                selectedReference={subject.trim() === '' ? undefined : subject.trim()}
                onChoose={(chosen) => {
                  setSubject(chosen.reference);
                  setSubjectDisplay(chosen.display);
                }}
                label="Search patients to address this request to"
                allowCreate
                prefillName={subjectDisplay}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-700">
              {ehrServerUrl ? 'Or enter it by hand' : 'Subject'}
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

          {ehrServerUrl ? (
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

          {config.enablePrePopulate && declaresPopulation ? (
            <div className="space-y-1.5 border-t border-slate-200 pt-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={prePopulateOn}
                  disabled={!prePopulateAvailable || !!link}
                  onChange={(event) => setPrePopulateOn(event.target.checked)}
                />
                <span>
                  <span className="inline-flex items-center gap-1.5 font-medium text-slate-900">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    Fill this in from the record first
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    This form declares pre-population, so the record can answer part of it before it
                    goes out. You check every answer before the link is made.
                  </span>
                </span>
              </label>

              {prePopulateAvailable ? null : (
                <p className="pl-6 text-xs text-amber-800">
                  {!session
                    ? 'Sign in through your EHR to read the record.'
                    : !ehrServerUrl
                      ? 'No record server is configured to read from.'
                      : !subjectPatientId
                        ? 'Choose a patient above — a form can only be filled in from somebody’s record.'
                        : 'Looking up that patient…'}
                </p>
              )}
            </div>
          ) : null}

          <Button onClick={handleCreate} disabled={isCreating || !canHost || isPopulating}>
            {isCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            {isCreating
              ? 'Encrypting and uploading…'
              : isPopulating
                ? 'Reading the record…'
                : seed
                  ? 'Create request link, pre-filled'
                  : 'Create request link'}
          </Button>
        </CardContent>
      </Card>

      {prePopulateOn && populateError ? (
        <Alert tone="error" title="The record could not be read">
          <p>{populateError instanceof Error ? populateError.message : String(populateError)}</p>
          <p className="mt-1">
            Nothing has been pre-filled. The form can still be sent blank — untick the box above —
            but do not read this as the record holding nothing, because it is the opposite: the
            reads did not complete.
          </p>
        </Alert>
      ) : null}

      {prePopulateOn && populated && !populateError ? (
        <>
          <PrePopulatePanel
            rows={rows}
            issues={populated.issues}
            selected={selected}
            onSelectedChange={(next) => {
              setDeselected(new Set(rows.map((row) => row.path).filter((path) => !next.has(path))));
            }}
            sourceLabel={ehrServerUrl ?? 'the record server'}
            disabled={!!link}
          />

          {seed ? (
            <div className="space-y-2">
              <Button variant="outline" size="sm" onClick={() => setShowPreview((open) => !open)}>
                <Eye className="h-4 w-4" aria-hidden />
                {showPreview ? 'Hide the form' : 'Preview as the patient will see it'}
              </Button>

              {/*
                * Mounted only while open. The renderer's questionnaire and response stores are
                * module-level singletons — `FormRenderer` says so — so a second form on screen would
                * fight this one for them. Read-only because the choice being made here is what to
                * send, not what to answer; the answering is the patient's.
                */}
              {showPreview ? (
                <div className="form-surface">
                  <FormRenderer
                    questionnaire={questionnaire}
                    questionnaireResponse={seed}
                    terminologyServerUrl={config.terminologyServerUrl}
                    readOnly
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

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
            <strong>Write once to a slot</strong> —{' '}
            {oneShotWrite ? (
              <>
                enabled. The request carries the address of an empty response on{' '}
                <span className="font-mono text-xs">{resolveWriteSlotServerUrl(config)}</span>, plus a
                token and the version to write against, so a filler can send the answers there without
                showing you anything. The write succeeds <strong>once</strong>; you still collect and
                review them here before they reach a record.
              </>
            ) : (
              <>
                off. Set <span className="font-mono text-xs">enableOneShotWrite</span> to offer it —
                the channel to use when a filler has no way to get a QR code back to you and no way to
                do the encrypted reply&rsquo;s crypto.
              </>
            )}
          </li>
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
        {config.senderName ?? launchedUserName ? null : (
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
